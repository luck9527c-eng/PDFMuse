import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBookIndex, tokenizeForIndex, type EmbeddingProvider } from "./book-index.js";
import { createLibraryModule } from "../library.js";

const FIXTURE = path.resolve(import.meta.dirname, "../fixtures/navigation.pdf");

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
});
