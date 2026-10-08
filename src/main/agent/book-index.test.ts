import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBookIndex, keepStrongHits, pageTextSemanticFactor, splitSearchTerms, tokenizeForIndex, type EmbeddingProvider } from "./book-index.js";
import { createLibraryModule } from "../library.js";
import { createPdfDocumentBroker } from "../pdf-document-broker.js";

const FIXTURE = path.resolve(import.meta.dirname, "../fixtures/navigation.pdf");

/** 构造单页无文字 PDF：Recognized Text 兜底需要原生文本缺失的页面。 */
function blankPagePdf(): Uint8Array {
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, position) => {
    offsets.push(pdf.length);
    pdf += `${position + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

describe("keepStrongHits", () => {
  it("drops hits below 60% of the top score and always keeps the best", () => {
    const hits = [
      { score: 0.9, page: 1 },
      { score: 0.7, page: 2 },
      { score: 0.5, page: 3 },
      { score: 0.2, page: 4 },
    ];
    expect(keepStrongHits(hits).map((hit) => hit.page)).toEqual([1, 2]);
    expect(keepStrongHits([{ score: 0.4, page: 1 }])).toHaveLength(1);
    expect(keepStrongHits([])).toEqual([]);
  });
});

describe("tokenizeForIndex", () => {
  it("splits CJK text into single-character tokens and keeps words intact", () => {
    expect(tokenizeForIndex("能量守恒 energy")).toBe("能 量 守 恒 energy");
    expect(tokenizeForIndex("Chapter One")).toBe("Chapter One");
  });
});

describe("splitSearchTerms", () => {
  it("splits multi-term queries on whitespace and CJK punctuation, dedupes and caps", () => {
    expect(splitSearchTerms("请假 审批 年假")).toEqual(["请假", "审批", "年假"]);
    expect(splitSearchTerms("请假，审批、年假;事假")).toEqual(["请假", "审批", "年假", "事假"]);
    expect(splitSearchTerms("重复 重复 其他")).toEqual(["重复", "其他"]);
    expect(splitSearchTerms("单个词")).toEqual(["单个词"]);
    expect(splitSearchTerms("   ")).toEqual([]);
  });
});

describe("pageTextSemanticFactor", () => {
  it("discounts short pages and dot-leader TOC lines", () => {
    expect(pageTextSemanticFactor("长正文的页，".repeat(40))).toBe(1);
    // 封面页：二十来个字符的短文本压到下限。
    expect(pageTextSemanticFactor("广州通易科技有限公司员工手册")).toBe(0.4);
    // 目录页：点导引不承载语义，有效长度只按正文行计。
    const toc = "目 录\n" + Array.from({ length: 10 }, (_, index) => `第${index}章 标题.......... ${index + 3}`).join("\n");
    expect(pageTextSemanticFactor(toc)).toBeLessThan(0.6);
  });
});

describe("book index", () => {
  let dataHome: string;
  let library: ReturnType<typeof createLibraryModule>;
  let index: ReturnType<typeof createBookIndex>;
  let bookId: string;
  let fixtureBytes: Uint8Array;

  beforeEach(async () => {
    dataHome = await mkdtemp(path.join(os.tmpdir(), "pdfmuse-index-"));
    library = createLibraryModule(dataHome);
    index = createBookIndex(dataHome, { getBookSource: (bookId) => library.getBookSource(bookId) });
    const { readFile } = await import("node:fs/promises");
    fixtureBytes = new Uint8Array(await readFile(FIXTURE));
    const opened = await library.openPath(FIXTURE);
    expect(opened.ok).toBe(true);
    if (opened.ok) bookId = opened.book.id;
  });

  afterEach(async () => {
    index?.close();
    library?.close();
    await rm(dataHome, { recursive: true, force: true });
  });

  it("reports empty coverage before indexing", () => {
    expect(index.stats(bookId)).toEqual({ indexedPages: 0, totalPages: 3 });
  });

  it("indexes the whole book and finds English phrases with page numbers", async () => {
    const outcome = await index.ensureIndexed(bookId, async () => ({ bytes: fixtureBytes }));
    expect(outcome.indexedPages).toBe(3);
    expect(outcome.note).toBeUndefined();

    const search = await index.search(bookId, "Chapter One");
    expect(search.status).toBe("ok");
    if (search.status === "unavailable") return;
    expect(search.indexedPages).toBe(3);
    expect(search.hits.length).toBeGreaterThan(0);
    expect(search.hits[0]!.page).toBe(1);
    expect(search.hits[0]!.snippet).toContain("Chapter One");
  });

  it("finds text on later pages", async () => {
    await index.ensureIndexed(bookId, async () => ({ bytes: fixtureBytes }));
    const search = await index.search(bookId, "PDFMuse search target");
    if (search.status === "unavailable") throw new Error("unexpected unavailable");
    const pages = search.hits.map((hit) => hit.page);
    expect(pages).toContain(1);
  });

  it("returns partial status when the index is incomplete", async () => {
    const search = await index.search(bookId, "Chapter");
    expect(search.status).toBe("partial");
    if (search.status !== "partial") return;
    expect(search.note).toContain("索引尚未完成");
  });

  it("rejects unknown books", async () => {
    const search = await index.search("c".repeat(64), "任何");
    expect(search).toEqual({ status: "unavailable", note: "书库中没有这本书。" });
  });

  it("skips re-indexing when coverage is complete", async () => {
    const first = await index.ensureIndexed(bookId, async () => ({ bytes: fixtureBytes }));
    expect(first.indexedPages).toBe(3);
    let loads = 0;
    const second = await index.ensureIndexed(bookId, async () => {
      loads += 1;
      return { bytes: fixtureBytes };
    });
    expect(second.indexedPages).toBe(3);
    expect(loads).toBe(0);
  });

  it("rebuilds legacy flat page text with the structured extraction version", async () => {
    await index.ensureIndexed(bookId, async () => ({ bytes: fixtureBytes }));
    index.close();
    const database = new DatabaseSync(path.join(dataHome, "pdfmuse.db"));
    database.prepare("UPDATE book_pages SET extraction_version = 'v1-flat-text' WHERE book_id = ?").run(bookId);
    const timestamp = new Date().toISOString();
    database.prepare(`
      INSERT INTO semantic_embeddings
        (book_id, source, source_id, page, text, vector_json, model, dimensions, content_hash, created_at, updated_at)
      VALUES (?, 'pdf', '1:0', 1, 'legacy', '[1,0]', 'legacy-model', 2, 'legacy-hash', ?, ?)
    `).run(bookId, timestamp, timestamp);
    database.close();
    index = createBookIndex(dataHome, { getBookSource: (bookId) => library.getBookSource(bookId) });
    let sourceLoads = 0;

    await index.ensureIndexed(bookId, async () => {
      sourceLoads += 1;
      return { bytes: fixtureBytes };
    });

    expect(sourceLoads).toBe(1);
    const verified = new DatabaseSync(path.join(dataHome, "pdfmuse.db"), { readOnly: true });
    const versions = verified.prepare("SELECT DISTINCT extraction_version FROM book_pages WHERE book_id = ?").all(bookId);
    const oldVectors = verified.prepare("SELECT COUNT(*) AS count FROM semantic_embeddings WHERE book_id = ? AND source_id = '1:0'").get(bookId);
    verified.close();
    expect(versions).toEqual([{ extraction_version: "v3-figure-placeholders" }]);
    expect(oldVectors).toEqual({ count: 0 });
  });

  it("continues from the last committed page after interruption", async () => {
    const controller = new AbortController();
    const firstProgress: number[] = [];
    const partial = await index.ensureIndexed(
      bookId,
      async () => ({ bytes: fixtureBytes }),
      controller.signal,
      (page) => {
        firstProgress.push(page);
        if (page === 1) controller.abort();
      },
    );
    expect(partial.indexedPages).toBe(1);
    expect(index.stats(bookId).indexedPages).toBe(1);

    const resumedProgress: number[] = [];
    const completed = await index.ensureIndexed(
      bookId,
      async () => ({ bytes: fixtureBytes }),
      undefined,
      (page) => resumedProgress.push(page),
    );
    expect(completed.indexedPages).toBe(3);
    expect(resumedProgress).toEqual([2, 3]);
  });

  it("uses semantic embeddings to find a synonym and applies reading focus", async () => {
    index.close();
    const provider: EmbeddingProvider = {
      model: "test-embedding-v1",
      embed: async (inputs) => inputs.map((input) => (
        input.includes("第一章") || input.includes("Chapter One") ? [1, 0] : [0, 1]
      )),
    };
    index = createBookIndex(dataHome, { getEmbeddingProvider: () => provider, getBookSource: (bookId) => library.getBookSource(bookId) });
    await index.ensureIndexed(bookId, async () => ({ bytes: fixtureBytes }));

    const search = await index.search(bookId, "第一章", 3, { currentPage: 1 });
    expect(search.status).toBe("ok");
    if (search.status !== "ok") return;
    expect(search.retrievalMode).toBe("hybrid");
    expect(search.hits[0]).toMatchObject({ source: "pdf", page: 1 });
  });

  it("接线构建转交通道后：向量缺失时检索改排后台构建、本次 fts-only，补建完成升 hybrid 且不重复排", async () => {
    // 先无 provider 建好全文索引（模拟「先索引、后配置嵌入连接」），再换带 provider 与转交通道的实例。
    await index.ensureIndexed(bookId, async () => ({ bytes: fixtureBytes }));
    index.close();
    const scheduled: string[] = [];
    const provider: EmbeddingProvider = {
      model: "defer-embedding-v1",
      embed: async (inputs) => inputs.map((input) => (input.includes("Chapter One") ? [1, 0] : [0, 1])),
    };
    index = createBookIndex(dataHome, {
      getEmbeddingProvider: () => provider,
      scheduleEmbeddingBuild: (id) => scheduled.push(id),
      getBookSource: (id) => library.getBookSource(id),
    });

    const first = await index.search(bookId, "第一章", 3);
    expect(first.status).toBe("ok");
    if (first.status !== "ok") return;
    expect(first.retrievalMode).toBe("fts-only");
    expect(scheduled).toEqual([bookId]);

    // 后台任务执行器语义（main.ts embedding executor）：调 ensureEmbeddings 完成补建并清脏。
    await index.ensureEmbeddings(bookId);
    const second = await index.search(bookId, "第一章", 3);
    expect(second.status).toBe("ok");
    if (second.status !== "ok") return;
    expect(second.retrievalMode).toBe("hybrid");
    expect(scheduled).toEqual([bookId]);
  });

  it("向量读缓存按 COUNT+MAX(updated_at) 签名失效：外部写入的新向量立即参与检索", async () => {
    index.close();
    const provider: EmbeddingProvider = {
      model: "cache-embedding-v1",
      embed: async (inputs) => inputs.map((input) => (input.includes("Chapter One") ? [1, 0] : [0, 1])),
    };
    index = createBookIndex(dataHome, { getEmbeddingProvider: () => provider, getBookSource: (id) => library.getBookSource(id) });
    await index.ensureIndexed(bookId, async () => ({ bytes: fixtureBytes }));

    const warm = await index.search(bookId, "Chapter One");
    expect(warm.status).toBe("ok");
    if (warm.status !== "ok") return;
    expect(warm.hits.every((hit) => hit.page !== 3)).toBe(true);

    // 外部直插一条第 3 页、与查询完全同向的向量：签名变化必须让缓存让位。
    // 文本取足有效长度（≥120 字符），避免短文本语义折减把它压出相对阈值。
    const probeText = "Chapter One cache probe. ".repeat(8);
    const database = new DatabaseSync(path.join(dataHome, "pdfmuse.db"));
    const timestamp = new Date().toISOString();
    database.prepare(`
      INSERT INTO semantic_embeddings
        (book_id, source, source_id, page, text, vector_json, model, dimensions, content_hash, created_at, updated_at)
      VALUES (?, 'pdf', '3:cache-probe', 3, ?, '[1,0]', 'cache-embedding-v1', 2, 'probe-hash', ?, ?)
    `).run(bookId, probeText, timestamp, timestamp);
    database.close();

    const refreshed = await index.search(bookId, "Chapter One");
    expect(refreshed.status).toBe("ok");
    if (refreshed.status !== "ok") return;
    expect(refreshed.hits.some((hit) => hit.page === 3)).toBe(true);
  });

  it("向量读侧 blob 优先：写侧双写 blob，JSON 损坏时检索照常 hybrid", async () => {
    index.close();
    const provider: EmbeddingProvider = {
      model: "blob-embedding-v1",
      embed: async (inputs) => inputs.map((input) => (input.includes("Chapter One") ? [1, 0] : [0, 1])),
    };
    index = createBookIndex(dataHome, { getEmbeddingProvider: () => provider, getBookSource: (id) => library.getBookSource(id) });
    await index.ensureIndexed(bookId, async () => ({ bytes: fixtureBytes }));
    await index.ensureEmbeddings(bookId);

    const database = new DatabaseSync(path.join(dataHome, "pdfmuse.db"));
    const blobs = database.prepare(
      "SELECT COUNT(*) AS count FROM semantic_embeddings WHERE book_id = ? AND source = 'pdf' AND vector_blob IS NOT NULL",
    ).get(bookId) as { count: number };
    const rows = database.prepare(
      "SELECT COUNT(*) AS count FROM semantic_embeddings WHERE book_id = ? AND source = 'pdf'",
    ).get(bookId) as { count: number };
    database.exec("UPDATE semantic_embeddings SET vector_json = '[]' WHERE book_id = ? AND source = 'pdf'");
    database.close();
    expect(rows.count).toBeGreaterThan(0);
    expect(blobs.count).toBe(rows.count);

    const search = await index.search(bookId, "Chapter One");
    expect(search.status).toBe("ok");
    if (search.status !== "ok") return;
    expect(search.retrievalMode).toBe("hybrid");
  });

  it("falls back to smaller embedding batches when a provider rejects a large batch", async () => {
    index.close();
    const provider: EmbeddingProvider = {
      model: "single-input-embedding-v1",
      embed: async (inputs) => {
        if (inputs.length > 1) throw new Error("嵌入模型服务返回 HTTP 400。");
        return inputs.map(() => [1, 0]);
      },
    };
    index = createBookIndex(dataHome, {
      getEmbeddingProvider: () => provider,
      embeddingBatchSize: 32,
      getBookSource: (bookId) => library.getBookSource(bookId),
    });
    await index.ensureIndexed(bookId, async () => ({ bytes: fixtureBytes }));

    await expect(index.ensureEmbeddings(bookId)).resolves.toBe(true);
    const search = await index.search(bookId, "Chapter One");
    expect(search.status).toBe("ok");
    if (search.status !== "ok") return;
    expect(search.retrievalMode).toBe("hybrid");
  });

  it("reports the underlying embedding failure without breaking FTS fallback", async () => {
    await index.ensureIndexed(bookId, async () => ({ bytes: fixtureBytes }));
    index.close();
    const failure = new Error("嵌入模型服务返回 HTTP 429。");
    const onEmbeddingError = vi.fn();
    index = createBookIndex(dataHome, {
      getEmbeddingProvider: () => ({
        model: "limited-embedding-v1",
        embed: async () => { throw failure; },
      }),
      onEmbeddingError,
      getBookSource: (bookId) => library.getBookSource(bookId),
    });

    await expect(index.ensureEmbeddings(bookId)).resolves.toBe(false);
    expect(onEmbeddingError).toHaveBeenCalledOnce();
    expect(onEmbeddingError).toHaveBeenCalledWith(failure);
  });

  it("对话召回腿已退役：存量 conversation 向量行是死数据，不进任何检索腿（T54）", async () => {
    index.close();
    const provider: EmbeddingProvider = {
      model: "test-embedding-v1",
      embed: async (inputs) => inputs.map(() => [0, 1]),
    };
    index = createBookIndex(dataHome, {
      getEmbeddingProvider: () => provider,
      getBookSource: (bookId) => library.getBookSource(bookId),
    });
    await index.ensureIndexed(bookId, async () => ({ bytes: fixtureBytes }));
    // 直接落一行 conversation 语义向量（历史库里的真实形态）：检索必须无视它。
    const database = new DatabaseSync(path.join(dataHome, "pdfmuse.db"));
    const timestamp = new Date().toISOString();
    database.prepare(`
      INSERT INTO semantic_embeddings
        (book_id, source, source_id, page, text, vector_json, model, dimensions, content_hash, created_at, updated_at)
      VALUES (?, 'conversation', 'legacy-message', NULL, '这是一条存量会话嵌入，正文含 回顾 一词', '[0,1]', ?, 2, 'h', ?, ?)
    `).run(bookId, provider.model, timestamp, timestamp);
    database.close();

    const search = await index.search(bookId, "回顾", 8);
    expect(search.status).toBe("ok");
    if (search.status !== "ok") return;
    expect(search.hits.filter((hit) => hit.source === "conversation")).toHaveLength(0);
    expect(search.hits.every((hit) => hit.source === "pdf")).toBe(true);
  });

  it("识别页插图块出占位行：进 readPages 全文、不进 FTS 检索（T53）", async () => {
    index.indexRecognizedPage(bookId, 2, [
      { text: "带图正文", type: "text", bbox: [0, 0, 1, 0.5] },
      { text: "", type: "image", bbox: [0.1, 0.1, 0.6, 0.7] },
    ]);
    const pages = index.readPages(bookId, 2, 2);
    expect(pages[0]?.text).toContain("带图正文");
    expect(pages[0]?.text).toContain("[插图 1·约占页面 30%：内容不可见，可用 view_page 查看第 2 页插图 1]");

    // 「插图」不进倒排索引：占位行不可检索，正文照常可检索。
    const miss = await index.search(bookId, "插图");
    expect(miss.status).not.toBe("unavailable");
    if (miss.status !== "unavailable") {
      expect(miss.hits.filter((hit) => hit.source === "pdf" && hit.page === 2)).toHaveLength(0);
    }
    const hit = await index.search(bookId, "带图正文");
    expect(hit.status).not.toBe("unavailable");
    if (hit.status !== "unavailable") {
      expect(hit.hits.some((item) => item.source === "pdf" && item.page === 2)).toBe(true);
    }
  });

  it("纯插图页：占位行进页文本、FTS 无任何可检索内容", async () => {
    index.indexRecognizedPage(bookId, 3, [{ text: "", type: "image", bbox: [0.1, 0.1, 0.6, 0.7] }]);
    const pages = index.readPages(bookId, 3, 3);
    expect(pages[0]?.text).toContain("[插图 1·约占页面 30%");
    const outcome = await index.search(bookId, "插图");
    expect(outcome.status).not.toBe("unavailable");
    if (outcome.status !== "unavailable") {
      expect(outcome.hits.filter((item) => item.source === "pdf" && item.page === 3)).toHaveLength(0);
    }
  });

  it("recognizedFigureBbox 按占位同序返回第 N 幅插图 bbox（T53 插图级寻址）", () => {
    index.close();
    const blocks = [
      { type: "image", text: "", bbox: [0.1, 0.1, 0.4, 0.4] },
      { type: "text", text: "正文", bbox: [0, 0.4, 1, 0.5] },
      { type: "image", text: "", bbox: [0.5, 0.5, 0.8, 0.8] },
    ];
    index = createBookIndex(dataHome, {
      getBookSource: (id) => library.getBookSource(id),
      readRecognizedBlocks: (id, page) => (id === bookId && page === 2 ? blocks : undefined),
    });
    expect(index.recognizedFigureBbox(bookId, 2, 1)).toEqual([0.1, 0.1, 0.4, 0.4]);
    expect(index.recognizedFigureBbox(bookId, 2, 2)).toEqual([0.5, 0.5, 0.8, 0.8]);
    expect(index.recognizedFigureBbox(bookId, 2, 3)).toBeUndefined();
    expect(index.recognizedFigureBbox(bookId, 3, 1)).toBeUndefined();
  });

  it("语义切片剔除插图占位行（防「插图」二字污染检索向量）", async () => {
    const embedded: string[] = [];
    const provider: EmbeddingProvider = {
      model: "stub",
      embed: async (inputs) => {
        embedded.push(...inputs);
        return inputs.map(() => [0, 1]);
      },
    };
    index.close();
    index = createBookIndex(dataHome, { getBookSource: (id) => library.getBookSource(id), embeddingProvider: provider });
    index.indexRecognizedPage(bookId, 2, [
      { text: "带图正文", type: "text", bbox: [0, 0, 1, 0.5] },
      { text: "", type: "image", bbox: [0.1, 0.1, 0.6, 0.7] },
    ]);
    await index.ensureEmbeddings(bookId);
    expect(embedded.length).toBeGreaterThan(0);
    expect(embedded.join("\n")).toContain("带图正文");
    for (const text of embedded) expect(text).not.toContain("插图");
  });

  it("falls back to recognized lines for pages without native text", async () => {
    const scannedPath = path.join(dataHome, "扫描样例.pdf");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(scannedPath, blankPagePdf());
    const opened = await library.openPath(scannedPath);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    index.close();
    index = createBookIndex(dataHome, {
      getBookSource: (bookId) => library.getBookSource(bookId),
      readRecognizedBlocks: (bookId, page) => (
        bookId === opened.book.id && page === 1
          ? [{ type: "text", text: "扫描页独有的识别文本", bbox: [0, 0, 1, 1] }]
          : undefined
      ),
    });

    const outcome = await index.ensureIndexed(opened.book.id, async () => ({ bytes: opened.book.bytes }));
    expect(outcome.indexedPages).toBe(1);

    const search = await index.search(opened.book.id, "识别文本");
    expect(search.status).toBe("ok");
    if (search.status !== "ok") return;
    expect(search.hits[0]).toMatchObject({ source: "pdf", page: 1 });
    expect(search.hits[0]?.snippet).toContain("扫描页独有的识别文本");
  });

  it("deleteBookData 清掉本书页面、FTS 与全部语义向量且不影响他书", async () => {
    await index.ensureIndexed(bookId, async () => ({ bytes: fixtureBytes }));
    const otherBookId = "c".repeat(64);
    const setup = new DatabaseSync(path.join(dataHome, "pdfmuse.db"));
    setup.prepare("INSERT INTO book_pages (book_id, page, text, extraction_version) VALUES (?, 1, 'other', 'v2-structured-lines')").run(otherBookId);
    setup.prepare("INSERT INTO book_pages_fts (book_id, page, tokens) VALUES (?, 1, 'other')").run(otherBookId);
    const timestamp = new Date().toISOString();
    setup.prepare(`
      INSERT INTO semantic_embeddings
        (book_id, source, source_id, page, text, vector_json, model, dimensions, content_hash, created_at, updated_at)
      VALUES (?, 'pdf', '1:0', 1, 'text', '[1]', 'm', 1, 'h', ?, ?)
    `).run(otherBookId, timestamp, timestamp);
    setup.close();

    const connection = new DatabaseSync(path.join(dataHome, "pdfmuse.db"));
    index.deleteBookData(bookId, connection);
    connection.close();

    const verified = new DatabaseSync(path.join(dataHome, "pdfmuse.db"), { readOnly: true });
    const count = (sql: string, ...params: unknown[]) => (
      (verified.prepare(sql).get(...params) as { count: number }).count
    );
    expect(count("SELECT COUNT(*) AS count FROM book_pages WHERE book_id = ?", bookId)).toBe(0);
    expect(count("SELECT COUNT(*) AS count FROM book_pages_fts WHERE book_id = ?", bookId)).toBe(0);
    expect(count("SELECT COUNT(*) AS count FROM semantic_embeddings WHERE book_id = ?", bookId)).toBe(0);
    expect(count("SELECT COUNT(*) AS count FROM book_pages WHERE book_id = ?", otherBookId)).toBe(1);
    expect(count("SELECT COUNT(*) AS count FROM book_pages_fts WHERE book_id = ?", otherBookId)).toBe(1);
    expect(count("SELECT COUNT(*) AS count FROM semantic_embeddings WHERE book_id = ?", otherBookId)).toBe(1);
    verified.close();
  });

  it("deleteConversationEmbeddings 只清本书会话来源的向量", () => {
    const otherBookId = "c".repeat(64);
    const setup = new DatabaseSync(path.join(dataHome, "pdfmuse.db"));
    const timestamp = new Date().toISOString();
    const insert = (bookId: string, source: "pdf" | "conversation") => setup.prepare(`
      INSERT INTO semantic_embeddings
        (book_id, source, source_id, page, text, vector_json, model, dimensions, content_hash, created_at, updated_at)
      VALUES (?, ?, '1', 1, 'text', '[1]', 'm', 1, 'h', ?, ?)
    `).run(bookId, source, timestamp, timestamp);
    insert(bookId, "pdf");
    insert(bookId, "conversation");
    insert(otherBookId, "conversation");
    setup.close();

    const connection = new DatabaseSync(path.join(dataHome, "pdfmuse.db"));
    index.deleteConversationEmbeddings(bookId, connection);
    connection.close();

    const verified = new DatabaseSync(path.join(dataHome, "pdfmuse.db"), { readOnly: true });
    expect(verified.prepare("SELECT book_id, source FROM semantic_embeddings ORDER BY book_id, source").all()).toEqual([
      { book_id: bookId, source: "pdf" },
      { book_id: otherBookId, source: "conversation" },
    ]);
    verified.close();
  });

  it("marks retrieval as FTS-only when no embedding provider is available", async () => {
    await index.ensureIndexed(bookId, async () => ({ bytes: fixtureBytes }));
    const search = await index.search(bookId, "Chapter One");
    expect(search.status).toBe("ok");
    if (search.status !== "ok") return;
    expect(search.retrievalMode).toBe("fts-only");
  });

  it("replaces an empty native page with recognized text and invalidates its vectors", async () => {
    await index.ensureIndexed(bookId, async () => ({ bytes: fixtureBytes }));
    expect(index.indexRecognizedPage(bookId, 2, [{ text: "扫描页面独有术语" }])).toBe(true);
    const search = await index.search(bookId, "独有术语");
    expect(search.status).toBe("ok");
    if (search.status !== "ok") return;
    expect(search.hits[0]).toMatchObject({ source: "pdf", page: 2 });
  });

  it("注入共享句柄后整书抽取只取一次句柄，覆盖完整的快路径不再取（T60）", async () => {
    index.close();
    let acquires = 0;
    const broker = createPdfDocumentBroker({
      loadBook: async () => ({ bytes: fixtureBytes }),
      idleTimeoutMs: 0,
    });
    index = createBookIndex(dataHome, {
      getBookSource: (id) => library.getBookSource(id),
      acquireDocument: async (id) => {
        acquires += 1;
        return broker.acquire(id);
      },
    });

    const outcome = await index.ensureIndexed(bookId, async () => ({ bytes: fixtureBytes }));
    expect(outcome.indexedPages).toBe(3);
    expect(acquires).toBe(1);

    // 覆盖完整快路径：无需文档，也不取句柄。
    const again = await index.ensureIndexed(bookId, async () => { throw new Error("不应再加载书源"); });
    expect(again.indexedPages).toBe(3);
    expect(acquires).toBe(1);
    broker.dispose();
  });

  it("boosts in-chapter pages when a chapter range is provided", async () => {
    await index.ensureIndexed(bookId, async () => ({ bytes: fixtureBytes }));
    expect(index.indexRecognizedPage(bookId, 1, [{ text: "同一术语分布在两页" }])).toBe(true);
    expect(index.indexRecognizedPage(bookId, 3, [{ text: "同一术语分布在两页" }])).toBe(true);

    // 两页都在当前页 ±1 窗口内（同享页距加权），章节加权是唯一区分信号。
    const withoutRange = await index.search(bookId, "同一术语", 6, { currentPage: 2 });
    const withRange = await index.search(bookId, "同一术语", 6, { currentPage: 2, chapterRange: { from: 3, to: 3 } });

    expect(withoutRange.status).toBe("ok");
    expect(withRange.status).toBe("ok");
    if (withoutRange.status !== "ok" || withRange.status !== "ok") return;
    // 同分基线下按页码升序；章节加权让命中章节的页面反超。
    expect(withoutRange.hits[0]?.page).toBe(1);
    expect(withRange.hits[0]?.page).toBe(3);
  });
});
