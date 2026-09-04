import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { ReadingFocus } from "../../shared/contracts.js";

/**
 * 整本书的页级全文索引（FTS5）。
 * 中文按单字切分写入，查询词同样预处理，使任意长度的中文子串都能命中；
 * 英文单词保持原样由 unicode61 分词。
 */
const CJK_PATTERN = /[\u3000-\u9fff\uff00-\uffef]/;

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

type BookRow = { current_path: string; page_count: number; saved_password: string | null };

export type EmbeddingProvider = {
  model: string;
  embed(inputs: readonly string[], signal?: AbortSignal): Promise<readonly number[][]>;
};

export type BookIndexOptions = {
  embeddingProvider?: EmbeddingProvider;
  getEmbeddingProvider?: () => EmbeddingProvider | undefined | Promise<EmbeddingProvider | undefined>;
  embeddingBatchSize?: number;
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

const PDF_CHUNK_SIZE = 1_200;
const PDF_CHUNK_OVERLAP = 160;
const DEFAULT_EMBEDDING_BATCH_SIZE = 32;

function contentHash(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

function splitIntoChunks(text: string, page: number) {
  const chunks: Array<{ id: string; text: string; page: number }> = [];
  if (!text) return chunks;
  const step = Math.max(1, PDF_CHUNK_SIZE - PDF_CHUNK_OVERLAP);
  let index = 0;
  for (let start = 0; start < text.length; start += step) {
    const chunk = text.slice(start, start + PDF_CHUNK_SIZE).trim();
    if (chunk) chunks.push({ id: `${index}`, text: chunk, page });
    index += 1;
    if (start + PDF_CHUNK_SIZE >= text.length) break;
  }
  return chunks;
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
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
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

  const embeddingBatchSize = Math.max(1, options.embeddingBatchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE);
  const indexing = new Map<string, Promise<{ indexedPages: number; totalPages: number; note?: string }>>();
  const embeddingRuns = new Map<string, Promise<boolean>>();

  const indexedPagesStatement = database.prepare(
    "SELECT COUNT(*) AS count FROM book_pages WHERE book_id = ?",
  );
  const bookRowStatement = database.prepare(
    "SELECT current_path, page_count, saved_password FROM library_books WHERE id = ?",
  );
  const insertPageStatement = database.prepare(`
    INSERT INTO book_pages (book_id, page, text) VALUES (?, ?, ?)
    ON CONFLICT(book_id, page) DO UPDATE SET text = excluded.text
  `);
  const insertFtsStatement = database.prepare(
    "INSERT INTO book_pages_fts (book_id, page, tokens) VALUES (?, ?, ?)",
  );
  const clearFtsStatement = database.prepare(
    "DELETE FROM book_pages_fts WHERE book_id = ?",
  );
  const clearPagesStatement = database.prepare(
    "DELETE FROM book_pages WHERE book_id = ?",
  );
  const searchStatement = database.prepare(`
    SELECT page, text
    FROM book_pages
    WHERE book_id = ? AND text LIKE ?
    ORDER BY page ASC
    LIMIT 40
  `);
  const indexedPagesBeforeStatement = database.prepare(
    "SELECT MAX(page) AS max_page, COUNT(*) AS count FROM book_pages WHERE book_id = ?",
  );
  const pageTextStatement = database.prepare(
    "SELECT page, text FROM book_pages WHERE book_id = ? ORDER BY page ASC",
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

  function embeddingRows(bookId: string) {
    return embeddingRowsStatement.all(bookId) as EmbeddingRow[];
  }

  async function ensurePdfEmbeddings(
    bookId: string,
    provider: EmbeddingProvider,
    signal?: AbortSignal,
  ) {
    const pages = pageTextStatement.all(bookId) as Array<{ page: number; text: string }>;
    const chunks = pages.flatMap((page) => splitIntoChunks(page.text, page.page).map((chunk) => ({
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
        const vectors = await provider.embed(batch.map((chunk) => chunk.text), signal);
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
    } catch {
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
    const row = bookRowStatement.get(bookId) as BookRow | undefined;
    if (!row) return { indexedPages: 0, totalPages: 0, note: "书库中没有这本书的索引来源。" };
    const existing = indexedPagesBeforeStatement.get(bookId) as { max_page: number | null; count: number };
    if (existing.count >= row.page_count && existing.max_page === row.page_count) {
      const provider = await embeddingProvider();
      if (provider) await ensureEmbeddings(bookId, signal);
      return { indexedPages: existing.count, totalPages: row.page_count };
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
        const text = await extractPageText(document, page);
        database.exec("BEGIN");
        try {
          insertPageStatement.run(bookId, page, text);
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
    const partial = indexed < row.page_count
      ? { note: `索引尚未完成（已索引 ${indexed}/${row.page_count} 页），当前只在已索引范围内检索。` }
      : {};
    return { indexedPages: indexed, totalPages: row.page_count, ...partial };
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
      const row = bookRowStatement.get(bookId) as BookRow | undefined;
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
        const likePages = searchStatement.all(bookId, likePattern(trimmed)) as { page: number; text: string }[];
        const merged = new Map<number, string>();
        for (const hit of likePages) merged.set(hit.page, hit.text);
        for (const hit of ftsPages) {
          if (!merged.has(hit)) {
            const text = database.prepare(
              "SELECT text FROM book_pages WHERE book_id = ? AND page = ?",
            ).get(bookId, hit) as { text: string } | undefined;
            if (text) merged.set(hit, text.text);
          }
        }
        pages = [...merged.entries()].sort((a, b) => a[0] - b[0]).map(([page, text]) => ({ page, text }));
      } catch {
        pages = searchStatement.all(bookId, likePattern(trimmed)) as { page: number; text: string }[];
      }
      for (const page of pages) {
        addCandidate({ source: "pdf", sourceId: `${page.page}:0`, page: page.page, text: page.text }, ftsPages.has(page.page) ? 0.8 : 1);
      }

      // 早期对话同样是候选来源；表不存在时保持向后兼容（首次启动尚未创建会话表）。
      try {
        const conversationHits = database.prepare(`
          SELECT m.id AS source_id, m.body AS text
          FROM agent_messages m
          JOIN agent_sessions s ON s.id = m.session_id
          WHERE s.book_id = ? AND m.role IN ('reader', 'assistant')
            AND m.status = 'complete' AND m.body LIKE ?
          ORDER BY m.created_at DESC
          LIMIT 20
        `).all(bookId, likePattern(trimmed)) as Array<{ source_id: string; text: string }>;
        for (const hit of conversationHits) {
          addCandidate({ source: "conversation", sourceId: hit.source_id, text: hit.text }, 0.9);
        }
      } catch {
        // 会话表由 Agent Host 懒创建；没有它时只使用 PDF 候选。
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
          const focusBoost = candidate.source === "pdf"
            ? (candidate.page === selectedPage ? 0.3 : 0) + (candidate.page === currentPage ? 0.1 : 0)
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

      const hits: BookSearchHit[] = scored.slice(0, Math.max(1, limit)).map(({ candidate, score }) => ({
        source: candidate.source,
        ...(candidate.page === undefined ? {} : { page: candidate.page }),
        sourceId: candidate.sourceId,
        snippet: buildSnippet(candidate.text, trimmed),
        score: Number(score.toFixed(6)),
      }));
      const indexedPages = indexedPagesStatement.get(bookId) as { count: number };
      const base = {
        hits,
        indexedPages: indexedPages.count,
        totalPages: row.page_count,
        retrievalMode,
      };
      if (indexedPages.count < row.page_count) {
        return {
          status: "partial",
          ...base,
          note: `索引尚未完成（${indexedPages.count}/${row.page_count} 页），结果只覆盖已索引页面。`,
        };
      }
      return { status: "ok", ...base };
    },

    ensureIndexed,

    ensureEmbeddings,

    indexConversationMessage,

    /** 按书库记录读取原文件字节（含已记住的密码）；原文件只读，永不修改。 */
    async loadBookByBookId(bookId: string) {
      const row = bookRowStatement.get(bookId) as BookRow | undefined;
      if (!row) throw new Error("书库中没有这本书。");
      return loadBookBytes(row.current_path, row.saved_password ?? undefined);
    },

    stats(bookId: string) {
      const row = bookRowStatement.get(bookId) as BookRow | undefined;
      const indexed = indexedPagesStatement.get(bookId) as { count: number };
      return {
        indexedPages: indexed.count,
        totalPages: row?.page_count ?? 0,
      };
    },

    close() {
      database.close();
    },
  };
}

/** 从原文件读取书籍字节用于索引；原文件永不修改。 */
export async function loadBookBytes(currentPath: string, password?: string) {
  const bytes = new Uint8Array(await readFile(currentPath));
  return { bytes, ...(password ? { password } : {}) };
}

export type BookIndex = ReturnType<typeof createBookIndex>;
