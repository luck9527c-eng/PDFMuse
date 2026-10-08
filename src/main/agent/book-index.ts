import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { MineruBlock, ReadingFocus } from "../../shared/contracts.js";
import type { RegionBbox } from "../../shared/region.js";
import type { BookSource } from "../library.js";
import { openPdfMuseDatabase } from "../database.js";
import { assembleBlockText, figureBlocks, stripFigurePlaceholderLines, type RecognizedBlockLike } from "./figure-placeholder.js";
import { chunkPageText } from "./semantic-chunker.js";

/**
 * 整本书的页级全文索引（FTS5）。
 * 中文按单字切分写入，查询词同样预处理，使任意长度的中文子串都能命中；
 * 英文单词保持原样由 unicode61 分词。
 */
const CJK_PATTERN = /[\u3000-\u9fff\uff00-\uffef]/;
const BOOK_ID_PATTERN = /^[a-f0-9]{64}$/;
const TEXT_EXTRACTION_VERSION = "v3-figure-placeholders";
/** 单次检索参与关键词腿的词数上限：查询串更长时只取前 N 个词，避免检索式无限膨胀。 */
const MAX_SEARCH_TERMS = 8;
/** 语义分按页文本有效长度折减的下限：短页（封面/目录页）的向量不可靠，但不能完全作废。 */
const SEMANTIC_LENGTH_FLOOR = 0.4;
const SEMANTIC_FULL_LENGTH = 120;
/** 连续点导引（目录行的「…… 3」）不承载语义，按每个字符 3 个字符的长度扣减。 */
const DOT_LEADER_RUN = /[.．·・…‥]{3,}/g;

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

/**
 * 查询串 → 检索词：按空白与中英文标点切分，去重后截断。
 * 多词查询必须逐词检索——整串当一个短语时，中文查询（模型常写「请假 审批 年假」）
 * 在 FTS 与 LIKE 两腿都命中 0 页，关键词腿等于没有。
 */
export function splitSearchTerms(query: string): string[] {
  const terms: string[] = [];
  for (const raw of query.split(/[\s,，、;；:：/|]+/)) {
    const term = raw.trim();
    if (term && !terms.includes(term)) terms.push(term);
    if (terms.length >= MAX_SEARCH_TERMS) break;
  }
  return terms;
}

/**
 * 页文本对语义分的可信度折减：点导引不计长度，短文本（封面、扉页）的向量不可靠。
 * 目录页因此被显著降权——它按目录行罗列章节名，余弦相似度常常虚高于正文本体。
 */
export function pageTextSemanticFactor(text: string): number {
  const dotLeaderChars = (text.match(DOT_LEADER_RUN) ?? []).reduce((total, run) => total + run.length, 0);
  const effectiveLength = Math.max(0, text.length - dotLeaderChars * 3);
  if (effectiveLength >= SEMANTIC_FULL_LENGTH) return 1;
  return Math.max(SEMANTIC_LENGTH_FLOOR, effectiveLength / SEMANTIC_FULL_LENGTH);
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
  /**
   * 语义向量待构建时的转交通道（生产装配传入）：检索/索引路径发现向量缺失或过期时
   * 改排后台任务并立即返回（首问不再阻塞整书补建）；缺省时同步补建，保持独立使用语义。
   * 任务去重由后台任务模块按（书, kind）负责。
   */
  scheduleEmbeddingBuild?(bookId: string): void;
  /** 书目元数据最小读接口（library_books 表属 Library）：索引、检索与原文件加载经此取源。 */
  getBookSource?(bookId: string): BookSource | undefined;
  /** Recognized Text 行最小读接口（recognized_pages 表属 OCR）：原生文本不足时兜底取识别行。 */
  readRecognizedBlocks?(bookId: string, page: number): ReadonlyArray<MineruBlock> | undefined;
};

type EmbeddingRow = {
  source: "pdf" | "conversation";
  source_id: string;
  page: number | null;
  text: string;
  vector_json: string;
  vector_blob?: Uint8Array | null;
  model: string;
  dimensions: number;
  content_hash: string;
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

/** Float32 BLOB → 向量视图；长度非 4 的倍数、含非有限值都按损坏处理（回退 JSON）。 */
function parseVectorBlob(blob: unknown): Float32Array | undefined {
  if (!(blob instanceof Uint8Array) || blob.byteLength === 0 || blob.byteLength % 4 !== 0) return undefined;
  // SQLite 返回的缓冲区不保证 4 字节对齐；未对齐时先拷贝到对齐缓冲。
  const aligned = blob.byteOffset % 4 === 0
    ? blob
    : new Uint8Array(blob); // 拷贝构造必然从自身缓冲区 0 偏移开始
  const view = new Float32Array(aligned.buffer, aligned.byteOffset, blob.byteLength / 4);
  return view.every((value) => Number.isFinite(value)) ? view : undefined;
}

/** 行向量解析：blob 优先（Float32 视图）、JSON 兜底（历史行与测试直插行，普通数组）。 */
function rowVector(row: Pick<EmbeddingRow, "vector_json" | "vector_blob">): Float32Array | number[] | undefined {
  return parseVectorBlob(row.vector_blob) ?? parseVector(row.vector_json);
}

/** 向量 → Float32 BLOB 字节（写侧与读侧共用同一编码）。 */
function vectorBlobBytes(vector: readonly number[]): Uint8Array {
  const view = new Float32Array(vector.length);
  for (let index = 0; index < vector.length; index += 1) view[index] = vector[index]!;
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function cosineSimilarity(left: ArrayLike<number>, right: ArrayLike<number>) {
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
  const database = openPdfMuseDatabase(dataHome);
  database.exec(`
    CREATE TABLE IF NOT EXISTS book_pages (
      book_id TEXT NOT NULL,
      page INTEGER NOT NULL,
      text TEXT NOT NULL,
      indexable_text TEXT NOT NULL DEFAULT '',
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
  // indexable_text 投影列（T53）：占位行只留在 text（read_pages 交付），FTS/LIKE/语义全部吃投影列。
  if (!pageColumns.some((column) => column.name === "indexable_text")) {
    database.exec("ALTER TABLE book_pages ADD COLUMN indexable_text TEXT NOT NULL DEFAULT ''")
  }
  // 向量 BLOB 列：写侧双写（JSON 保兼容与可读），读侧 blob 优先——JSON.parse 千维浮点远慢于直接视图。
  const embeddingColumns = database.prepare("PRAGMA table_info(semantic_embeddings)").all() as Array<{ name: string }>;
  if (!embeddingColumns.some((column) => column.name === "vector_blob")) {
    database.exec("ALTER TABLE semantic_embeddings ADD COLUMN vector_blob BLOB");
  }

  const embeddingBatchSize = Math.max(1, options.embeddingBatchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE);
  const indexing = new Map<string, Promise<{ indexedPages: number; totalPages: number; note?: string }>>();
  const embeddingRuns = new Map<string, Promise<boolean>>();

  // ---- 语义向量读缓存（按书）：COUNT + MAX(updated_at) 签名做廉价失效，避免每次检索
  // 全表拉行并 JSON.parse 千维浮点；容量按 LRU 收敛（典型单书会话，两本足够交替）。
  type CachedEmbedding = {
    source: "pdf" | "conversation";
    sourceId: string;
    page: number | null;
    text: string;
    model: string;
    dimensions: number;
    contentHash: string;
    vector: Float32Array | number[];
  };
  const EMBEDDING_CACHE_BOOKS = 2;
  const embeddingCache = new Map<string, { signature: string; entries: CachedEmbedding[] }>();
  const embeddingSignatureStatement = database.prepare(
    "SELECT COUNT(*) AS count, COALESCE(MAX(updated_at), '') AS latest FROM semantic_embeddings WHERE book_id = ?",
  );
  const embeddingDirtyBooks = new Set<string>();

  function embeddingRowsCached(bookId: string): CachedEmbedding[] {
    const signatureRow = embeddingSignatureStatement.get(bookId) as { count: number; latest: string };
    const signature = `${signatureRow.count}:${signatureRow.latest}`;
    const cached = embeddingCache.get(bookId);
    if (cached && cached.signature === signature) {
      // LRU 触碰：删后重插保持新鲜序。
      embeddingCache.delete(bookId);
      embeddingCache.set(bookId, cached);
      return cached.entries;
    }
    const entries = (embeddingRowsStatement.all(bookId) as EmbeddingRow[]).flatMap((row) => {
      const vector = rowVector(row);
      return vector
        ? [{
          source: row.source,
          sourceId: row.source_id,
          page: row.page,
          text: row.text,
          model: row.model,
          dimensions: row.dimensions,
          contentHash: row.content_hash,
          vector,
        }]
        : [];
    });
    embeddingCache.set(bookId, { signature, entries });
    while (embeddingCache.size > EMBEDDING_CACHE_BOOKS) {
      const oldest = embeddingCache.keys().next().value;
      if (oldest === undefined) break;
      embeddingCache.delete(oldest);
    }
    return entries;
  }

  /** 语义向量是否需要构建：页文本写入后置脏，或当前 provider 模型下没有任何书内向量（首建/换模型）。 */
  function needsEmbeddingBuild(bookId: string, provider: EmbeddingProvider): boolean {
    return embeddingDirtyBooks.has(bookId)
      || !embeddingRowsCached(bookId).some((entry) => entry.source === "pdf" && entry.model === provider.model);
  }

  /** 构建启动方式：接线了转交通道就改排后台任务（调用方立即继续）；缺省同步补建。 */
  async function startEmbeddingBuild(bookId: string, signal?: AbortSignal) {
    if (options.scheduleEmbeddingBuild) {
      options.scheduleEmbeddingBuild(bookId);
      return;
    }
    await ensureEmbeddings(bookId, signal);
  }

  const indexedPagesStatement = database.prepare(
    "SELECT COUNT(*) AS count FROM book_pages WHERE book_id = ? AND extraction_version = ?",
  );
  const allIndexedPagesStatement = database.prepare(
    "SELECT COUNT(*) AS count FROM book_pages WHERE book_id = ?",
  );
  const insertPageStatement = database.prepare(`
    INSERT INTO book_pages (book_id, page, text, indexable_text, extraction_version) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(book_id, page) DO UPDATE SET
      text = excluded.text,
      indexable_text = excluded.indexable_text,
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
  const indexedPagesBeforeStatement = database.prepare(
    "SELECT MAX(page) AS max_page, COUNT(*) AS count FROM book_pages WHERE book_id = ? AND extraction_version = ?",
  );
  // 语义切片的输入是 indexable_text 投影列：占位行不进检索向量。
  const pageTextStatement = database.prepare(
    "SELECT page, indexable_text AS text FROM book_pages WHERE book_id = ? AND extraction_version = ? ORDER BY page ASC",
  );
  const readPagesStatement = database.prepare(
    "SELECT page, text FROM book_pages WHERE book_id = ? AND extraction_version = ? AND page >= ? AND page <= ? ORDER BY page ASC",
  );
  const embeddingRowsStatement = database.prepare(`
    SELECT source, source_id, page, text, vector_json, vector_blob, model, dimensions, content_hash
    FROM semantic_embeddings WHERE book_id = ?
  `);
  const embeddingUpsertStatement = database.prepare(`
    INSERT INTO semantic_embeddings
      (book_id, source, source_id, page, text, vector_json, vector_blob, model, dimensions, content_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(book_id, source, source_id) DO UPDATE SET
      page = excluded.page,
      text = excluded.text,
      vector_json = excluded.vector_json,
      vector_blob = excluded.vector_blob,
      model = excluded.model,
      dimensions = excluded.dimensions,
      content_hash = excluded.content_hash,
      updated_at = excluded.updated_at
  `);

  async function embeddingProvider() {
    return options.embeddingProvider ?? options.getEmbeddingProvider?.();
  }

  /** 原生文本不足一页下限时，用 Recognized Text 块兜底（经 OCR 模块的读接口）；插图块出占位行。 */
  function recognizedPageText(bookId: string, page: number) {
    const blocks = options.readRecognizedBlocks?.(bookId, page);
    return blocks ? assembleBlockText(blocks, page).text : "";
  }

  /** 识别页第 figure 个插图块的 bbox（与页文本占位编号同一序）；view_page 插图级寻址经此取裁剪区域。 */
  function recognizedFigureBbox(bookId: string, page: number, figure: number): RegionBbox | undefined {
    const blocks = options.readRecognizedBlocks?.(bookId, page);
    return blocks ? figureBlocks(blocks)[figure - 1]?.bbox : undefined;
  }

  async function ensurePdfEmbeddings(
    bookId: string,
    provider: EmbeddingProvider,
    signal?: AbortSignal,
  ) {
    const pages = pageTextStatement.all(bookId, TEXT_EXTRACTION_VERSION) as Array<{ page: number; text: string }>;
    // 语义切片的占位剔除由 pageTextStatement 读 indexable_text 投影列完成（T53：占位不进检索向量）。
    const chunks = pages.flatMap((page) => chunkPageText(page.text, page.page).map((chunk) => ({
      ...chunk,
      sourceId: `${page.page}:${chunk.id}`,
    })));
    const existing = new Map(
      embeddingRowsCached(bookId)
        .filter((row) => row.source === "pdf")
        .map((row) => [row.sourceId, row]),
    );
    const missing = chunks.filter((chunk) => {
      const row = existing.get(chunk.sourceId);
      return !row || row.model !== provider.model || row.contentHash !== contentHash(chunk.text);
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
              vectorBlobBytes(vector),
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
        if (!activeIds.has(row.sourceId)) {
          database.prepare(
            "DELETE FROM semantic_embeddings WHERE book_id = ? AND source = 'pdf' AND source_id = ?",
          ).run(bookId, row.sourceId);
        }
      }
      embeddingDirtyBooks.delete(bookId);
      return true;
    } catch (error) {
      options.onEmbeddingError?.(error);
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
      // 版本作废把语义向量一并清了：全书重建索引，向量也待重建。
      embeddingDirtyBooks.add(bookId);
    }
    if (existing.count >= row.pageCount && existing.max_page === row.pageCount) {
      const provider = await embeddingProvider();
      // 向量缺失/过期才启动构建；接线了转交通道即排后台任务，覆盖完整的快路径立即返回。
      if (provider && needsEmbeddingBuild(bookId, provider)) await startEmbeddingBuild(bookId, signal);
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
        const recognized = nativeText.length >= 16 ? "" : recognizedPageText(bookId, page);
        const text = recognized || nativeText;
        // FTS 只吃可检索文本：识别兜底的占位行进页全文、不进倒排索引。
        const indexable = recognized ? stripFigurePlaceholderLines(recognized) : text;
        database.exec("BEGIN");
        try {
          insertPageStatement.run(bookId, page, text, indexable, TEXT_EXTRACTION_VERSION);
          deleteFtsPageStatement.run(bookId, page);
          if (indexable.trim()) insertFtsStatement.run(bookId, page, tokenizeForIndex(indexable));
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
        embeddingDirtyBooks.add(bookId);
        indexed = page;
        onProgress?.(indexed, document.numPages);
      }
    } finally {
      await loadingTask.destroy();
    }
    const provider = await embeddingProvider();
    if (provider && needsEmbeddingBuild(bookId, provider)) await startEmbeddingBuild(bookId, signal);
    const partial = indexed < row.pageCount
      ? { note: `索引尚未完成（已索引 ${indexed}/${row.pageCount} 页），当前只在已索引范围内检索。` }
      : {};
    return { indexedPages: indexed, totalPages: row.pageCount, ...partial };
  }

  function indexRecognizedPage(bookId: string, page: number, lines: readonly RecognizedBlockLike[]) {
    // 装配一次出两套文本：页全文含插图占位（read_pages 交付），投影列与 FTS 只吃剔除占位后的可检索文本。
    const { text, indexableText } = assembleBlockText(lines, page);
    if (!BOOK_ID_PATTERN.test(bookId) || !Number.isSafeInteger(page) || page <= 0) return false;
    try {
      database.exec("BEGIN");
      insertPageStatement.run(bookId, page, text, indexableText, TEXT_EXTRACTION_VERSION);
      deleteFtsPageStatement.run(bookId, page);
      if (indexableText) insertFtsStatement.run(bookId, page, tokenizeForIndex(indexableText));
      database.prepare("DELETE FROM semantic_embeddings WHERE book_id = ? AND source = 'pdf' AND page = ?").run(bookId, page);
      database.exec("COMMIT");
      embeddingDirtyBooks.add(bookId);
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

      // 关键词腿：逐词 FTS5 命中 + 逐词 LIKE 兜底。整串当一个短语时，多词中文查询
      // （模型常写「请假 审批 年假」）两腿都命中 0 页，关键词腿等于没有；逐词 OR
      // 召回候选页，命中词数多的页排前（lexical 分 = 命中占比加权）。
      const terms = splitSearchTerms(trimmed);
      const singleTerm = terms.length <= 1;
      // LIKE 兜底扫 indexable_text 投影列：插图占位行（含「页面/查看」等常用词）不参与关键词召回。
      const likeConditions = terms.map(() => "indexable_text LIKE ? ESCAPE '\\'").join(" OR ");
      const termLikeStatement = database.prepare(`
        SELECT page, text FROM book_pages
        WHERE book_id = ? AND extraction_version = ? AND (${likeConditions})
        ORDER BY page ASC
        LIMIT 40
      `);
      const pageTextByIdStatement = database.prepare(
        "SELECT text FROM book_pages WHERE book_id = ? AND page = ? AND extraction_version = ?",
      );
      const hitCountByPage = new Map<number, number>();
      const merged = new Map<number, string>();
      const collectLikeHits = () => {
        for (const hit of termLikeStatement.all(bookId, TEXT_EXTRACTION_VERSION, ...terms.map((term) => likePattern(term))) as { page: number; text: string }[]) {
          merged.set(hit.page, hit.text);
        }
      };
      try {
        for (const term of terms) {
          const fts = database.prepare(`
            SELECT page FROM book_pages_fts
            WHERE book_pages_fts MATCH ? AND book_id = ?
            ORDER BY rank
            LIMIT 40
          `).all(`"${tokenizeForIndex(term).replace(/"/g, '""')}"`, bookId) as { page: number }[];
          for (const hit of fts) {
            hitCountByPage.set(hit.page, (hitCountByPage.get(hit.page) ?? 0) + 1);
            if (!merged.has(hit.page)) {
              const text = pageTextByIdStatement.get(bookId, hit.page, TEXT_EXTRACTION_VERSION) as { text: string } | undefined;
              if (text) merged.set(hit.page, text.text);
            }
          }
        }
        // LIKE 兜底：FTS5 对单字索引的 token 序列做的是「任意子序列」外的精确 phrase 匹配，
        // 词与词被原文标点/换行隔开时 phrase 不命中，逐词 OR 补召回。
        collectLikeHits();
      } catch {
        collectLikeHits();
      }
      for (const [page, hitCount] of hitCountByPage) {
        if (!merged.has(page)) {
          const text = pageTextByIdStatement.get(bookId, page, TEXT_EXTRACTION_VERSION) as { text: string } | undefined;
          if (text) merged.set(page, text.text);
        }
      }
      const pages = [...merged.entries()].sort((a, b) => a[0] - b[0]).map(([page, text]) => ({ page, text }));
      const bestHitCount = Math.max(1, ...hitCountByPage.values());
      for (const page of pages) {
        const hitCount = hitCountByPage.get(page.page) ?? 0;
        // lexical ∈ (0.5, 1]：FTS 命中按词覆盖占比排前；纯 LIKE 兜底的页多词 0.6、单词 1。
        const lexical = hitCount > 0
          ? 0.5 + 0.5 * (hitCount / bestHitCount)
          : singleTerm ? 1 : 0.6;
        addCandidate({ source: "pdf", sourceId: `${page.page}:0`, page: page.page, text: page.text }, lexical);
      }

      let retrievalMode: "hybrid" | "fts-only" = "fts-only";
      const provider = await embeddingProvider();
      let queryVector: readonly number[] | undefined;
      if (provider) {
        // 语义腿只读不建：向量缺失/过期时经转交通道排后台构建（缺省同步补建），本次仍按现有向量打分。
        if (needsEmbeddingBuild(bookId, provider)) await startEmbeddingBuild(bookId, signal);
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
        for (const row of embeddingRowsCached(bookId)) {
          // 对话召回腿已退役（T54）：存量 conversation 向量行是死数据，不参与检索。
          if (row.source === "conversation") continue;
          if (row.vector.length === 0 || row.model !== provider?.model || row.dimensions !== queryVector.length) continue;
          // 短页/目录页（点导引行堆出来的低信息密度页）向量不可靠，按有效文本长度折减。
          const factor = pageTextSemanticFactor(row.text);
          const key = `${row.source}:${row.source === "pdf" ? row.page : row.sourceId}`;
          const existing = candidates.get(key);
          const semantic = cosineSimilarity(queryVector, row.vector) * factor;
          if (existing) {
            existing.semantic = Math.max(existing.semantic, semantic);
          } else {
            candidates.set(key, {
              source: row.source,
              sourceId: row.sourceId,
              ...(row.page === null ? {} : { page: row.page }),
              text: row.text,
              lexical: 0,
              semantic,
            });
          }
        }
        if ([...candidates.values()].some((candidate) => candidate.semantic > 0)) retrievalMode = "hybrid";
      }

      const selectedPage = focus?.selectedPassage?.page;
      const currentPage = focus?.currentPage;
      const chapterRange = focus?.chapterRange;
      const scored = [...candidates.values()]
        .map((candidate) => {
          // 阅读位置先验：选段页最强，当前页 ±1 窗口次之（复习/讲解的小节通常跨 2-3 页），所在章再补一档。
          const nearCurrentPage = currentPage !== undefined
            && candidate.page !== undefined
            && Math.abs(candidate.page - currentPage) <= 1;
          const inChapter = chapterRange !== undefined
            && candidate.page !== undefined
            && candidate.page >= chapterRange.from && candidate.page <= chapterRange.to;
          const focusBoost = candidate.source === "pdf"
            ? (candidate.page === selectedPage ? 0.3 : 0) + (nearCurrentPage ? 0.2 : 0) + (inChapter ? 0.1 : 0)
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

    /** 识别页第 figure 个插图块的 bbox（与页文本占位编号同一序）；view_page 插图级寻址经此取裁剪区域。 */
    recognizedFigureBbox(bookId: string, page: number, figure: number): RegionBbox | undefined {
      return recognizedFigureBbox(bookId, page, figure);
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
      embeddingCache.delete(bookId);
      embeddingDirtyBooks.delete(bookId);
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
