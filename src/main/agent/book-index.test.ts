import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBookIndex, keepStrongHits, tokenizeForIndex, type EmbeddingProvider } from "./book-index.js";
import { createLibraryModule } from "../library.js";

const FIXTURE = path.resolve(import.meta.dirname, "../fixtures/navigation.pdf");

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

describe("book index", () => {
  let dataHome: string;
  let library: ReturnType<typeof createLibraryModule>;
  let index: ReturnType<typeof createBookIndex>;
  let bookId: string;
  let fixtureBytes: Uint8Array;

  beforeEach(async () => {
    dataHome = await mkdtemp(path.join(os.tmpdir(), "pdfmuse-index-"));
    library = createLibraryModule(dataHome);
    index = createBookIndex(dataHome);
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
    index = createBookIndex(dataHome);
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
    expect(versions).toEqual([{ extraction_version: "v2-structured-lines" }]);
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
    index = createBookIndex(dataHome, { getEmbeddingProvider: () => provider });
    await index.ensureIndexed(bookId, async () => ({ bytes: fixtureBytes }));

    const search = await index.search(bookId, "第一章", 3, { currentPage: 1 });
    expect(search.status).toBe("ok");
    if (search.status !== "ok") return;
    expect(search.retrievalMode).toBe("hybrid");
    expect(search.hits[0]).toMatchObject({ source: "pdf", page: 1 });
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
    });

    await expect(index.ensureEmbeddings(bookId)).resolves.toBe(false);
    expect(onEmbeddingError).toHaveBeenCalledOnce();
    expect(onEmbeddingError).toHaveBeenCalledWith(failure);
  });

  it("returns earlier conversation messages as a separate source", async () => {
    index.close();
    const provider: EmbeddingProvider = {
      model: "test-embedding-v1",
      embed: async (inputs) => inputs.map((input) => (
        input.includes("记忆") || input.includes("回顾") ? [0, 1] : [1, 0]
      )),
    };
    index = createBookIndex(dataHome, { getEmbeddingProvider: () => provider });
    await index.ensureIndexed(bookId, async () => ({ bytes: fixtureBytes }));
    await index.indexConversationMessage(bookId, {
      id: "message-1",
      role: "assistant",
      body: "这是一条可供后续回顾的记忆",
      status: "complete",
    });

    const search = await index.search(bookId, "回顾", 8);
    expect(search.status).toBe("ok");
    if (search.status !== "ok") return;
    expect(search.hits.some((hit) => hit.source === "conversation" && hit.sourceId === "message-1")).toBe(true);
    expect(search.hits.find((hit) => hit.source === "conversation")?.page).toBeUndefined();
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
});
