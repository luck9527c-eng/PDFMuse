import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { ReadingFocus, RecognizedTextLine } from "../../shared/contracts.js";
import type { BookSource } from "../library.js";
import { chunkPageText } from "./semantic-chunker.js";

/**
 * 整本书的页级全文索引（FTS5）。
 * 中文按单字切分写入，查询词同样预处理，使任意长度的中文子串都能命中；
 * 英文单词保持原样由 unicode61 分词。
 */
const CJK_PATTERN = /[\u3000-\u9fff\uff00-\uffef]/;
const BOOK_ID_PATTERN = /^[a-f0-9]{64}$/;
const TEXT_EXTRACTION_VERSION = "v2-structured-lines";

/**
 * 相对阈值截断：丢弃不足最高分 60% 的弱命中，避免「最不差的 N 个」式噪声
 * （语义余弦几乎恒为正，无阈值时全书页面都有正分）。首条（最高分）恒保留。
 */
export function keepStrongHits<T extends { score: number }>(items: readonly T[], ratio = 0.6): T[] {
  const top = items[0]?.score ?? 0;
  if (top <= 0) return [...items];
  return items.filter((item) => item.score >= top * ratio);
}

export function tokenizeForIndex(text: string) {
  return Array.from(text)
    .map((char) => (CJK_PATTERN.test(char) ? ` ${char} ` : char))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

export type BookSearchHit = {
  source?: "pdf" | "conversation";
  page?: number;
  snippet: string;
  score?: number;
  sourceId?: string;
};
export type BookSearchOutcome =
  | {
      status: "ok";
      hits: BookSearchHit[];
      indexedPages: number;
      totalPages: number;
      retrievalMode?: "hybrid" | "fts-only";
    }
  | {
      status: "partial";
      hits: BookSearchHit[];
      indexedPages: number;
      totalPages: number;
      note: string;
      retrievalMode?: "hybrid" | "fts-only";
    }
  | { status: "unavailable"; note: string };

export type EmbeddingProvider = {
  model: string;
  embed(inputs: readonly string[], signal?: AbortSignal): Promise<readonly number[][]>;
};

export type BookIndexOptions = {
  embeddingProvider?: EmbeddingProvider;
  getEmbeddingProvider?: () => EmbeddingProvider | undefined | Promise<EmbeddingProvider | undefined>;
  embeddingBatchSize?: number;
  onEmbeddingError?: (error: unknown) => void;
  /** 书目元数据最小读接口（library_books 表属 Library）：索引、检索与原文件加载经此取源。 */
  getBookSource?(bookId: string): BookSource | undefined;
  /** Recognized Text 行最小读接口（recognized_pages 表属 OCR）：原生文本不足时兜底取识别行。 */
  readRecognizedLines?(bookId: string, page: number): ReadonlyArray<RecognizedTextLine> | undefined;
  /** 会话检索最小读接口（会话表属会话存储）：懒取，组装根中会话存储晚于本模块创建。 */
  getConversationSearch?(): ((bookId: string, likePattern: string) => Array<{ id: string; body: string }>) | undefined;
};

type EmbeddingRow = {
  source: "pdf" | "conversation";
  source_id: string;
  page: number | null;
  text: string;
  vector_json: string;
  model: string;
  dimensions: number;
  content_hash: string;
};

type ConversationIndexInput = {
  id: string;
  role: "reader" | "assistant";
  body: string;
  status?: string;
};

const DEFAULT_EMBEDDING_BATCH_SIZE = 32;

function canRetryWithSmallerEmbeddingBatch(error: unknown) {
  if (error instanceof DOMException && error.name === "AbortError") return false;
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP (400|413|422)\b/.test(message)
    || /批量|batch|向量数量|无效向量/i.test(message);
}

async function embedWithAdaptiveBatching(
  provider: EmbeddingProvider,
  inputs: readonly string[],
  signal?: AbortSignal,
): Promise<readonly number[][]> {
  if (inputs.length === 0) return [];
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  try {
    const vectors = await provider.embed(inputs, signal);
    if (vectors.length !== inputs.length) throw new Error("嵌入模型返回的向量数量不匹配。");
    return vectors;
  } catch (error) {
    if (inputs.length === 1 || !canRetryWithSmallerEmbeddingBatch(error)) throw error;
    const midpoint = Math.ceil(inputs.length / 2);
    const left = await embedWithAdaptiveBatching(provider, inputs.slice(0, midpoint), signal);
    const right = await embedWithAdaptiveBatching(provider, inputs.slice(midpoint), signal);
    return [...left, ...right];
  }
}

function contentHash(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

function parseVector(value: string) {
  try {
    const vector = JSON.parse(value) as unknown;
    if (!Array.isArray(vector) || vector.length === 0) return undefined;
    if (!vector.every((item) => typeof item === "number" && Number.isFinite(item))) return undefined;
    return vector;
  } catch {
    return undefined;
  }
}

function cosineSimilarity(left: readonly number[], right: readonly number[]) {
  if (left.length !== right.length || left.length === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return Math.max(0, Math.min(1, dot / Math.sqrt(leftNorm * rightNorm)));
}

/** 用 pdfjs 抽取一页文本；失败页返回空串并继续。 */
async function extractPageText(document: Awaited<ReturnType<typeof getDocument>["promise"]>, page: number) {
  try {
    const pageProxy = await document.getPage(page);
    const content = await pageProxy.getTextContent();
    return content.items
      .map((item) => ("str" in item ? `${item.str}${"hasEOL" in item && item.hasEOL ? "\n" : " "}` : ""))
      .join("")
      .replace(/[^\S\n]+/g, " ")
      .replace(/ *\n */g, "\n")
      .trim();
  } catch {
    return "";
  }
}

export function createBookIndex(dataHome: string, options: BookIndexOptions = {}) {
  const database = new DatabaseSync(path.join(dataHome, "pdfmuse.db"));
  database.exec(`
    CREATE TABLE IF NOT EXISTS book_pages (
      book_id TEXT NOT NULL,
      page INTEGER NOT NULL,
      text TEXT NOT NULL,
      extraction_version TEXT NOT NULL DEFAULT 'v2-structured-lines',
      PRIMARY KEY (book_id, page)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS book_pages_fts USING fts5(
      book_id UNINDEXED,
      page UNINDEXED,
      tokens,
      tokenize='unicode61'
    );
    CREATE TABLE IF NOT EXISTS semantic_embeddings (
      book_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('pdf', 'conversation')),
      source_id TEXT NOT NULL,
      page INTEGER,
      text TEXT NOT NULL,
      vector_json TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (book_id, source, source_id)
    );
    CREATE INDEX IF NOT EXISTS semantic_embeddings_book_source
      ON semantic_embeddings(book_id, source);
  `);
  const pageColumns = database.prepare("PRAGMA table_info(book_pages)").all() as Array<{ name: string }>;
  if (!pageColumns.some((column) => column.name === "extraction_version")) {
    database.exec("ALTER TABLE book_pages ADD COLUMN extraction_version TEXT NOT NULL DEFAULT 'v1-flat-text'");
  }

  const embeddingBatchSize = Math.max(1, options.embeddingBatchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE);
  const indexing = new Map<string, Promise<{ indexedPages: number; totalPages: number; note?: string }>>();
  const embeddingRuns = new Map<string, Promise<boolean>>();

  const indexedPagesStatement = database.prepare(
    "SELECT COUNT(*) AS count FROM book_pages WHERE book_id = ? AND extraction_version = ?",
  );
  const allIndexedPagesStatement = database.prepare(
    "SELECT COUNT(*) AS count FROM book_pages WHERE book_id = ?",
  );
  const insertPageStatement = database.prepare(`
    INSERT INTO book_pages (book_id, page, text, extraction_version) VALUES (?, ?, ?, ?)
    ON CONFLICT(book_id, page) DO UPDATE SET
      text = excluded.text,
      extraction_version = excluded.extraction_version
  `);
  const insertFtsStatement = database.prepare(
    "INSERT INTO book_pages_fts (book_id, page, tokens) VALUES (?, ?, ?)",
  );
  const deleteFtsPageStatement = database.prepare("DELETE FROM book_pages_fts WHERE book_id = ? AND page = ?");
  const clearFtsStatement = database.prepare(
    "DELETE FROM book_pages_fts WHERE book_id = ?",
  );
  const clearPagesStatement = database.prepare(
    "DELETE FROM book_pages WHERE book_id = ?",
  );
  const clearPdfEmbeddingsStatement = database.prepare(
    "DELETE FROM semantic_embeddings WHERE book_id = ? AND source = 'pdf'",
  );
  const searchStatement = database.prepare(`
    SELECT page, text
    FROM book_pages
    WHERE book_id = ? AND extraction_version = ? AND text LIKE ?
    ORDER BY page ASC
    LIMIT 40
  `);
  const indexedPagesBeforeStatement = database.prepare(
    "SELECT MAX(page) AS max_page, COUNT(*) AS count FROM book_pages WHERE book_id = ? AND extraction_version = ?",
  );
  const pageTextStatement = database.prepare(
    "SELECT page, text FROM book_pages WHERE book_id = ? AND extraction_version = ? ORDER BY page ASC",
  );
  const readPagesStatement = database.prepare(
    "SELECT page, text FROM book_pages WHERE book_id = ? AND extraction_version = ? AND page >= ? AND page <= ? ORDER BY page ASC",
  );
  const embeddingRowsStatement = database.prepare(`
    SELECT source, source_id, page, text, vector_json, model, dimensions, content_hash
    FROM semantic_embeddings WHERE book_id = ?
  `);
  const embeddingUpsertStatement = database.prepare(`
    INSERT INTO semantic_embeddings
      (book_id, source, source_id, page, text, vector_json, model, dimensions, content_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(book_id, source, source_id) DO UPDATE SET
      page = excluded.page,
      text = excluded.text,
      vector_json = excluded.vector_json,
      model = excluded.model,
      dimensions = excluded.dimensions,
      content_hash = excluded.content_hash,
      updated_at = excluded.updated_at
  `);
  const conversationEmbeddingStatement = database.prepare(`
    SELECT source_id FROM semantic_embeddings
    WHERE book_id = ? AND source = 'conversation' AND source_id = ?
  `);

  async function embeddingProvider() {
    return options.embeddingProvider ?? options.getEmbeddingProvider?.();
  }

  /** 原生文本不足一页下限时，用 Recognized Text 行兜底（经 OCR 模块的读接口）。 */
  function recognizedPageText(bookId: string, page: number) {
    const lines = options.readRecognizedLines?.(bookId, page);
    if (!lines) return "";
    return lines
      .map((line) => (line && typeof line.text === "string" ? line.text : ""))
      .filter(Boolean)
      .join("\n")
      .replace(/[^\S\n]+/g, " ")
      .trim();
  }

  function embeddingRows(bookId: string) {
    return embeddingRowsStatement.all(bookId) as EmbeddingRow[];
  }

  async function ensurePdfEmbeddings(
    bookId: string,
    provider: EmbeddingProvider,
    signal?: AbortSignal,
  ) {
    const pages = pageTextStatement.all(bookId, TEXT_EXTRACTION_VERSION) as Array<{ page: number; text: string }>;
    const chunks = pages.flatMap((page) => chunkPageText(page.text, page.page).map((chunk) => ({
      ...chunk,
      sourceId: `${page.page}:${chunk.id}`,
    })));
    const existing = new Map(
      embeddingRows(bookId)
        .filter((row) => row.source === "pdf")
        .map((row) => [row.source_id, row]),
    );
    const missing = chunks.filter((chunk) => {
      const row = existing.get(chunk.sourceId);
      return !row || row.model !== provider.model || row.content_hash !== contentHash(chunk.text);
    });
    try {
      for (let start = 0; start < missing.length; start += embeddingBatchSize) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const batch = missing.slice(start, start + embeddingBatchSize);
        const vectors = await embedWithAdaptiveBatching(provider, batch.map((chunk) => chunk.text), signal);
        if (vectors.length !== batch.length) throw new Error("嵌入模型返回的向量数量不匹配。");
        const timestamp = new Date().toISOString();
        database.exec("BEGIN");
        try {
          for (let index = 0; index < batch.length; index += 1) {
            const vector = vectors[index];
            if (!vector || vector.length === 0 || !vector.every((value) => Number.isFinite(value))) {
              throw new Error("嵌入模型返回了无效向量。");
            }
            const chunk = batch[index]!;
            embeddingUpsertStatement.run(
              bookId,
              "pdf",
              chunk.sourceId,
              chunk.page,
              chunk.text,
              JSON.stringify(vector),
              provider.model,
              vector.length,
              contentHash(chunk.text),
              timestamp,
              timestamp,
            );
          }
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      }
      const activeIds = new Set(chunks.map((chunk) => chunk.sourceId));
      for (const row of existing.values()) {
        if (!activeIds.has(row.source_id)) {
          database.prepare(
            "DELETE FROM semantic_embeddings WHERE book_id = ? AND source = 'pdf' AND source_id = ?",
          ).run(bookId, row.source_id);
        }
      }
      return true;
    } catch (error) {
      options.onEmbeddingError?.(error);
      return false;
    }
  }

  async function indexConversationMessage(bookId: string, input: ConversationIndexInput) {
    if (input.status && input.status !== "complete") return false;
    const text = input.body.trim();
    if (!text || !input.id) return false;
    const provider = await embeddingProvider();
    if (!provider) return false;
    const existing = conversationEmbeddingStatement.get(bookId, input.id) as { source_id: string } | undefined;
    const hash = contentHash(text);
    if (existing) {
      const current = embeddingRows(bookId).find((row) => row.source === "conversation" && row.source_id === input.id);
      if (current?.model === provider.model && current.content_hash === hash) return true;
    }
    try {
      const vectors = await provider.embed([text]);
      const vector = vectors[0];
      if (!vector || vector.length === 0 || !vector.every((value) => Number.isFinite(value))) return false;
      const timestamp = new Date().toISOString();
      embeddingUpsertStatement.run(
        bookId,
        "conversation",
        input.id,
        null,
        text,
        JSON.stringify(vector),
        provider.model,
        vector.length,
        hash,
        timestamp,
        timestamp,
      );
      return true;
    } catch {
      return false;
    }
  }

  async function performEnsureIndexed(
    bookId: string,
    loadBook: () => Promise<{ bytes: Uint8Array; password?: string }>,
    signal?: AbortSignal,
    onProgress?: (indexedPages: number, totalPages: number) => void,
  ): Promise<{ indexedPages: number; totalPages: number; note?: string }> {
    const row = options.getBookSource?.(bookId);
    if (!row) return { indexedPages: 0, totalPages: 0, note: "书库中没有这本书的索引来源。" };
    const existing = indexedPagesBeforeStatement.get(bookId, TEXT_EXTRACTION_VERSION) as { max_page: number | null; count: number };
    const allExisting = allIndexedPagesStatement.get(bookId) as { count: number };
    if (allExisting.count > existing.count) {
      database.exec("BEGIN");
      try {
        clearPagesStatement.run(bookId);
        clearFtsStatement.run(bookId);
        clearPdfEmbeddingsStatement.run(bookId);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
    if (existing.count >= row.pageCount && existing.max_page === row.pageCount) {
      const provider = await embeddingProvider();
      if (provider) await ensureEmbeddings(bookId, signal);
      return { indexedPages: existing.count, totalPages: row.pageCount };
    }
    const source = await loadBook();
    const loadingTask = getDocument({
      data: source.bytes.slice(),
      ...(source.password ? { password: source.password } : {}),
    });
    const contiguous = existing.count === (existing.max_page ?? 0);
    let indexed = contiguous ? existing.count : 0;
    try {
      const document = await loadingTask.promise;
      if (!contiguous) {
        database.exec("BEGIN");
        try {
          clearPagesStatement.run(bookId);
          clearFtsStatement.run(bookId);
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      }
      for (let page = indexed + 1; page <= document.numPages; page += 1) {
        if (signal?.aborted) break;
        const nativeText = await extractPageText(document, page);
        const text = nativeText.length >= 16 ? nativeText : (recognizedPageText(bookId, page) || nativeText);
        database.exec("BEGIN");
        try {
          insertPageStatement.run(bookId, page, text, TEXT_EXTRACTION_VERSION);
          deleteFtsPageStatement.run(bookId, page);
          if (text) insertFtsStatement.run(bookId, page, tokenizeForIndex(text));
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
        indexed = page;
        onProgress?.(indexed, document.numPages);
      }
    } finally {
      await loadingTask.destroy();
    }
    const provider = await embeddingProvider();
    if (provider) await ensureEmbeddings(bookId, signal);
    const partial = indexed < row.pageCount
      ? { note: `索引尚未完成（已索引 ${indexed}/${row.pageCount} 页），当前只在已索引范围内检索。` }
      : {};
    return { indexedPages: indexed, totalPages: row.pageCount, ...partial };
  }

  function indexRecognizedPage(bookId: string, page: number, lines: readonly { text: string }[]) {
    const text = lines.map((line) => line.text).join("\n").replace(/[^\S\n]+/g, " ").trim();
    if (!BOOK_ID_PATTERN.test(bookId) || !Number.isSafeInteger(page) || page <= 0) return false;
    try {
      database.exec("BEGIN");
      insertPageStatement.run(bookId, page, text, TEXT_EXTRACTION_VERSION);
      deleteFtsPageStatement.run(bookId, page);
      if (text) insertFtsStatement.run(bookId, page, tokenizeForIndex(text));
      database.prepare("DELETE FROM semantic_embeddings WHERE book_id = ? AND source = 'pdf' AND page = ?").run(bookId, page);
      database.exec("COMMIT");
      return true;
    } catch {
      try { database.exec("ROLLBACK"); } catch { /* noop */ }
      return false;
    }
  }

  function ensureIndexed(
    bookId: string,
    loadBook: () => Promise<{ bytes: Uint8Array; password?: string }>,
    signal?: AbortSignal,
    onProgress?: (indexedPages: number, totalPages: number) => void,
  ) {
    const current = indexing.get(bookId);
    if (current) return current;
    const run = performEnsureIndexed(bookId, loadBook, signal, onProgress)
      .finally(() => indexing.delete(bookId));
    indexing.set(bookId, run);
    return run;
  }

  function ensureEmbeddings(bookId: string, signal?: AbortSignal) {
    const current = embeddingRuns.get(bookId);
    if (current) return current;
    const run = (async () => {
      const provider = await embeddingProvider();
      return provider ? ensurePdfEmbeddings(bookId, provider, signal) : false;
    })().finally(() => embeddingRuns.delete(bookId));
    embeddingRuns.set(bookId, run);
    return run;
  }

  function likePattern(query: string) {
    const escaped = query.replace(/[%_\\]/g, (char) => `\\${char}`);
    return `%${escaped}%`;
  }

  function buildSnippet(pageText: string, query: string) {
    const index = pageText.toLowerCase().indexOf(query.toLowerCase());
    if (index < 0) return pageText.slice(0, 160);
    const start = Math.max(0, index - 60);
    const end = Math.min(pageText.length, index + query.length + 100);
    return `${start > 0 ? "…" : ""}${pageText.slice(start, end)}${end < pageText.length ? "…" : ""}`;
  }

  return {
    async search(
      bookId: string,
      query: string,
      limit = 6,
      focus?: ReadingFocus,
      signal?: AbortSignal,
    ): Promise<BookSearchOutcome> {
      const trimmed = query.trim();
      if (!trimmed) return { status: "unavailable", note: "检索词为空。" };
      const row = options.getBookSource?.(bookId);
      if (!row) return { status: "unavailable", note: "书库中没有这本书。" };

      type Candidate = {
        source: "pdf" | "conversation";
        sourceId: string;
        page?: number;
        text: string;
        lexical: number;
        semantic: number;
      };
      const candidates = new Map<string, Candidate>();
      const addCandidate = (candidate: Omit<Candidate, "lexical" | "semantic">, lexical: number) => {
        const key = `${candidate.source}:${candidate.source === "pdf" ? candidate.page : candidate.sourceId}`;
        const existing = candidates.get(key);
        if (!existing) {
          candidates.set(key, { ...candidate, lexical, semantic: 0 });
          return;
        }
        existing.lexical = Math.max(existing.lexical, lexical);
        if (candidate.text.length > existing.text.length) existing.text = candidate.text;
        if (candidate.sourceId < existing.sourceId) existing.sourceId = candidate.sourceId;
      };

      // 关键词腿：FTS5 命中 + LIKE 兜底（覆盖标点分隔的中文与短语）。
      const tokens = tokenizeForIndex(trimmed);
      let ftsPages = new Set<number>();
      let pages: { page: number; text: string }[] = [];
      try {
        const fts = database.prepare(`
          SELECT book_id, page FROM book_pages_fts
          WHERE book_pages_fts MATCH ? AND book_id = ?
          ORDER BY rank
          LIMIT 40
        `).all(`"${tokens.replace(/"/g, '""')}"`, bookId) as { book_id: string; page: number }[];
        ftsPages = new Set(fts.filter((hit) => hit.book_id === bookId).map((hit) => hit.page));
        const likePages = searchStatement.all(bookId, TEXT_EXTRACTION_VERSION, likePattern(trimmed)) as { page: number; text: string }[];
        const merged = new Map<number, string>();
        for (const hit of likePages) merged.set(hit.page, hit.text);
        for (const hit of ftsPages) {
          if (!merged.has(hit)) {
            const text = database.prepare(
              "SELECT text FROM book_pages WHERE book_id = ? AND page = ? AND extraction_version = ?",
            ).get(bookId, hit, TEXT_EXTRACTION_VERSION) as { text: string } | undefined;
            if (text) merged.set(hit, text.text);
          }
        }
        pages = [...merged.entries()].sort((a, b) => a[0] - b[0]).map(([page, text]) => ({ page, text }));
      } catch {
        pages = searchStatement.all(bookId, TEXT_EXTRACTION_VERSION, likePattern(trimmed)) as { page: number; text: string }[];
      }
      for (const page of pages) {
        addCandidate({ source: "pdf", sourceId: `${page.page}:0`, page: page.page, text: page.text }, ftsPages.has(page.page) ? 0.8 : 1);
      }

      // 早期对话同样是候选来源；经会话存储的读接口查询，未接线时只用 PDF 候选。
      const conversationSearch = options.getConversationSearch?.();
      if (conversationSearch) {
        for (const hit of conversationSearch(bookId, likePattern(trimmed))) {
          addCandidate({ source: "conversation", sourceId: hit.id, text: hit.body }, 0.9);
        }
      }

      let retrievalMode: "hybrid" | "fts-only" = "fts-only";
      const provider = await embeddingProvider();
      let queryVector: readonly number[] | undefined;
      if (provider) {
        await ensurePdfEmbeddings(bookId, provider, signal);
        try {
          const vectors = await provider.embed([trimmed], signal);
          const vector = vectors[0];
          if (vector && vector.length > 0 && vector.every((value) => Number.isFinite(value))) {
            queryVector = vector;
          }
        } catch {
          queryVector = undefined;
        }
      }

      if (queryVector) {
        const rows = embeddingRows(bookId);
        for (const row of rows) {
          const vector = parseVector(row.vector_json);
          if (!vector || row.model !== provider?.model || row.dimensions !== queryVector.length) continue;
          const key = `${row.source}:${row.source === "pdf" ? row.page : row.source_id}`;
          const existing = candidates.get(key);
          if (existing) {
            existing.semantic = Math.max(existing.semantic, cosineSimilarity(queryVector, vector));
          } else {
            candidates.set(key, {
              source: row.source,
              sourceId: row.source_id,
              ...(row.page === null ? {} : { page: row.page }),
              text: row.text,
              lexical: 0,
              semantic: cosineSimilarity(queryVector, vector),
            });
          }
        }
        if ([...candidates.values()].some((candidate) => candidate.semantic > 0)) retrievalMode = "hybrid";
      }

      const selectedPage = focus?.selectedPassage?.page;
      const currentPage = focus?.currentPage;
      const scored = [...candidates.values()]
        .map((candidate) => {
          // 阅读位置先验：选段页最强，当前页 ±1 窗口次之（复习/讲解的小节通常跨 2-3 页）。
          const nearCurrentPage = currentPage !== undefined
            && candidate.page !== undefined
            && Math.abs(candidate.page - currentPage) <= 1;
          const focusBoost = candidate.source === "pdf"
            ? (candidate.page === selectedPage ? 0.3 : 0) + (nearCurrentPage ? 0.2 : 0)
            : 0;
          const base = retrievalMode === "hybrid"
            ? candidate.semantic * 0.65 + candidate.lexical * 0.35
            : candidate.lexical;
          return { candidate, score: base + focusBoost };
        })
        .filter((item) => item.score > 0)
        .sort((left, right) => (
          right.score - left.score
          || (left.candidate.source === "pdf" ? -1 : 1) - (right.candidate.source === "pdf" ? -1 : 1)
          || (left.candidate.page ?? Number.MAX_SAFE_INTEGER) - (right.candidate.page ?? Number.MAX_SAFE_INTEGER)
          || left.candidate.sourceId.localeCompare(right.candidate.sourceId)
        ));

      const hits: BookSearchHit[] = keepStrongHits(scored.slice(0, Math.max(1, limit))).map(({ candidate, score }) => ({
        source: candidate.source,
        ...(candidate.page === undefined ? {} : { page: candidate.page }),
        sourceId: candidate.sourceId,
        snippet: buildSnippet(candidate.text, trimmed),
        score: Number(score.toFixed(6)),
      }));
      const indexedPages = indexedPagesStatement.get(bookId, TEXT_EXTRACTION_VERSION) as { count: number };
      const base = {
        hits,
        indexedPages: indexedPages.count,
        totalPages: row.pageCount,
        retrievalMode,
      };
      if (indexedPages.count < row.pageCount) {
        return {
          status: "partial",
          ...base,
          note: `索引尚未完成（${indexedPages.count}/${row.pageCount} 页），结果只覆盖已索引页面。`,
        };
      }
      return { status: "ok", ...base };
    },

    ensureIndexed,

    ensureEmbeddings,

    indexRecognizedPage,

    indexConversationMessage,

    /** 按书库记录读取原文件字节（含已记住的密码）；原文件只读，永不修改。 */
    async loadBookByBookId(bookId: string) {
      const row = options.getBookSource?.(bookId);
      if (!row) throw new Error("书库中没有这本书。");
      return loadBookBytes(row.path, row.savedPassword);
    },

    /** 读取指定页码范围（含端点）的已索引整页文本；供 read_pages 工具整页阅读。 */
    readPages(bookId: string, fromPage: number, toPage: number): Array<{ page: number; text: string }> {
      return readPagesStatement.all(bookId, TEXT_EXTRACTION_VERSION, fromPage, toPage) as Array<{ page: number; text: string }>;
    },

    stats(bookId: string) {
      const row = options.getBookSource?.(bookId);
      const indexed = indexedPagesStatement.get(bookId, TEXT_EXTRACTION_VERSION) as { count: number };
      return {
        indexedPages: indexed.count,
        totalPages: row?.pageCount ?? 0,
      };
    },

    /** 每书数据清理钩子：在调用方提供的连接上删除本书页面、FTS 与全部语义向量。 */
    deleteBookData(bookId: string, connection: DatabaseSync) {
      connection.prepare("DELETE FROM book_pages WHERE book_id = ?").run(bookId);
      connection.prepare("DELETE FROM book_pages_fts WHERE book_id = ?").run(bookId);
      connection.prepare("DELETE FROM semantic_embeddings WHERE book_id = ?").run(bookId);
    },

    /** 清空会话时的向量清理钩子：在调用方事务内只删本书会话来源的向量。 */
    deleteConversationEmbeddings(bookId: string, connection: DatabaseSync) {
      connection.prepare(
        "DELETE FROM semantic_embeddings WHERE book_id = ? AND source = 'conversation'",
      ).run(bookId);
    },

    close() {
      database.close();
    },
  };
}

/** 从原文件读取书籍字节用于索引；原文件永不修改。 */
async function loadBookBytes(currentPath: string, password?: string) {
  const bytes = new Uint8Array(await readFile(currentPath));
  return { bytes, ...(password ? { password } : {}) };
}

export type BookIndex = ReturnType<typeof createBookIndex>;
