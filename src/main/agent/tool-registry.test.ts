import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBookIndex } from "./book-index.js";
import { createLibraryModule } from "../library.js";
import { createToolRegistry } from "./tool-registry.js";
import { createMemoryModule } from "./memory.js";

const FIXTURE = path.resolve(import.meta.dirname, "../fixtures/navigation.pdf");

describe("tool registry", () => {
  let dataHome: string;
  let library: ReturnType<typeof createLibraryModule>;
  let bookIndex: ReturnType<typeof createBookIndex>;
  let bookId: string;

  beforeEach(async () => {
    dataHome = await mkdtemp(path.join(os.tmpdir(), "pdfmuse-tools-"));
    library = createLibraryModule(dataHome);
    bookIndex = createBookIndex(dataHome);
    const opened = await library.openPath(FIXTURE);
    expect(opened.ok).toBe(true);
    if (opened.ok) bookId = opened.book.id;
  });

  afterEach(async () => {
    bookIndex?.close();
    library?.close();
    await rm(dataHome, { recursive: true, force: true });
  });

  function context(reportEvidence: (evidence: unknown[]) => void = () => undefined, memory?: ReturnType<typeof createMemoryModule>) {
    return {
      bookId,
      bookIndex,
      memory,
      reportEvidence: reportEvidence as (evidence: never[]) => void,
    };
  }

  it("plans book_search as always available", () => {
    const registry = createToolRegistry();
    expect(registry.toolNames()).toEqual(["book_search"]);
    expect(registry.toolNames()).toEqual(createToolRegistry({ embeddingConfigured: false }).toolNames());
  });

  it("exposes memory tools only when the memory module is configured", async () => {
    const memory = createMemoryModule(dataHome);
    try {
      const registry = createToolRegistry({ memoryConfigured: true });
      expect(registry.toolNames()).toEqual(["book_search", "memory_search", "memory_propose"]);
      const tool = registry.buildAgentTools(() => context(() => undefined, memory)).find((item) => item.name === "memory_propose");
      expect(tool).toBeDefined();
      const result = await tool!.execute("call-memory", { content: "Reader 认可的核心概念", source: "conversation" });
      expect((result.content[0] as { text: string }).text).toContain("待确认");
      expect(memory.listProposals(bookId)[0]?.status).toBe("pending");
    } finally {
      memory.close();
    }
  });

  it("executes book_search with indexing, evidence and a model-facing summary", async () => {
    const registry = createToolRegistry();
    const tool = registry.buildAgentTools(context)[0]!;
    expect(tool.name).toBe("book_search");
    expect(tool.label).toBe("检索本书");
    expect(tool.parameters).toBeTruthy();

    const result = await tool.execute("call-1", { query: "Chapter One" });
    expect(result.content[0]).toMatchObject({ type: "text" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("第 1 页");
    expect(text).toContain("Chapter One");
    const details = result.details as { evidence?: Array<{ page: number; snippet: string }> };
    expect(details.evidence?.[0]?.page).toBe(1);
    expect(details.displaySummary).toContain("Chapter One");
  });

  it("reports evidence through the run context", async () => {
    const registry = createToolRegistry();
    const reported: Array<{ page: number }> = [];
    const tool = registry.buildAgentTools(() => context((evidence) => {
      reported.push(...(evidence as Array<{ page: number }>));
    }))[0]!;
    await tool.execute("call-1", { query: "PDFMuse search target" });
    expect(reported.length).toBeGreaterThan(0);
    expect(reported[0]!.page).toBe(1);
  });

  it("rejects invalid tool input inside the executor", async () => {
    const registry = createToolRegistry();
    const tool = registry.buildAgentTools(context)[0]!;
    await expect(tool.execute("call-1", { query: "" })).rejects.toThrow("检索词");
    await expect(tool.execute("call-1", { query: 42 })).rejects.toThrow("检索词");
    await expect(tool.execute("call-1", "not-an-object")).rejects.toThrow("参数无效");
    await expect(tool.execute("call-1", { query: "x".repeat(201) })).rejects.toThrow("检索词");
  });

  it("describes an empty result set without fabricating content", async () => {
    const registry = createToolRegistry();
    const tool = registry.buildAgentTools(context)[0]!;
    const result = await tool.execute("call-1", { query: "绝对不存在的词组" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("没有在书中找到相关内容");
  });

  it("reuses the persisted index across executions", async () => {
    const registry = createToolRegistry();
    const tool = registry.buildAgentTools(context)[0]!;
    await tool.execute("call-1", { query: "Chapter" });
    const readsBefore = (await readFile(path.join(dataHome, "pdfmuse.db"))).byteLength > 0;
    expect(readsBefore).toBe(true);
    const second = await tool.execute("call-2", { query: "Chapter Two" });
    const text = (second.content[0] as { text: string }).text;
    expect(text).toContain("第 2 页");
  });
});
