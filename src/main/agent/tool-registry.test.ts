import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBookIndex } from "./book-index.js";
import { createLibraryModule } from "../library.js";
import { createPageRenderer } from "../page-render.js";
import { createToolRegistry } from "./tool-registry.js";
import { validateToolArguments } from "./openclaw-core.js";

const FIXTURE = path.resolve(import.meta.dirname, "../fixtures/navigation.pdf");

describe("tool registry", () => {
  let dataHome: string;
  let library: ReturnType<typeof createLibraryModule>;
  let bookIndex: ReturnType<typeof createBookIndex>;
  let pageRenderer: ReturnType<typeof createPageRenderer>;
  let bookId: string;

  beforeEach(async () => {
    dataHome = await mkdtemp(path.join(os.tmpdir(), "pdfmuse-tools-"));
    library = createLibraryModule(dataHome);
    bookIndex = createBookIndex(dataHome, { getBookSource: (id) => library.getBookSource(id) });
    pageRenderer = createPageRenderer((id) => bookIndex.loadBookByBookId(id));
    const opened = await library.openPath(FIXTURE);
    expect(opened.ok).toBe(true);
    if (opened.ok) bookId = opened.book.id;
  });

  afterEach(async () => {
    bookIndex?.close();
    library?.close();
    await rm(dataHome, { recursive: true, force: true });
  });

  function context(reportEvidence: (evidence: unknown[]) => void = () => undefined) {
    return {
      bookId,
      bookIndex,
      renderPageImage: (id: string, page: number, scale: number) => pageRenderer.renderPage(id, page, scale),
      reportEvidence: reportEvidence as (evidence: never[]) => void,
    };
  }

  it("exposes the four reading and search tools", () => {
    const registry = createToolRegistry();
    expect(registry.toolNames()).toEqual(["book_search", "read_pages", "read_page_image", "web_search"]);
  });

  it("attaches the OCR modality note to read_pages results", async () => {
    const registry = createToolRegistry();
    const tool = registry.buildAgentTools(context).find((item) => item.name === "read_pages")!;
    const result = await tool.execute("call-note-1", { pages: [1] });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("read_page_image");
    expect(text).toContain("二维结构必然失真");
  });

  it("returns rendered page images as image content blocks via read_page_image", async () => {
    const registry = createToolRegistry();
    const tool = registry.buildAgentTools(context).find((item) => item.name === "read_page_image")!;
    const result = await tool.execute("call-image-1", { pages: [1, 1, 2] });
    const blocks = result.content as Array<{ type: string; data?: string }>;
    expect(blocks[0]?.type).toBe("text");
    const images = blocks.filter((block) => block.type === "image");
    expect(images).toHaveLength(2);
    expect(images[0]?.data?.length).toBeGreaterThan(100);
    const details = result.details as { evidence?: Array<{ page: number; snippet: string }>; displaySummary?: string };
    expect(details.evidence?.map((item) => item.page)).toEqual([1, 2]);
    expect(details.displaySummary).toContain("第 1、2 页");
  });

  it("returns web results with provider notes via web_search", async () => {
    const registry = createToolRegistry();
    const fakeSearch = {
      search: async (query: string) => ({
        status: "ok" as const,
        provider: "duckduckgo" as const,
        results: [
          { title: "作者简介", url: "https://example.com/author", snippet: "计算机组成原理的作者…" },
        ],
      }),
    };
    const tool = registry.buildAgentTools(() => ({ ...context(), webSearch: fakeSearch })).find((item) => item.name === "web_search")!;
    const result = await tool.execute("call-web-1", { query: "计算机组成原理 作者" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("https://example.com/author");
    expect(text).toContain("书外资料");
  });

  it("reads full page text with per-page evidence via read_pages", async () => {
    const registry = createToolRegistry();
    const tool = registry.buildAgentTools(context).find((item) => item.name === "read_pages")!;
    const result = await tool.execute("call-read-1", { pages: [1] });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("【第 1 页】");
    expect(text.replace("【第 1 页】", "").trim().length).toBeGreaterThan(0);
    const details = result.details as { evidence?: Array<{ page: number }> };
    expect(details.evidence?.[0]?.page).toBe(1);
  });

  it("reads discontiguous pages in one read_pages call and skips gaps", async () => {
    const registry = createToolRegistry();
    const tool = registry.buildAgentTools(context).find((item) => item.name === "read_pages")!;
    const result = await tool.execute("call-read-2", { pages: [3, 1] });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("【第 1 页】");
    expect(text).toContain("【第 3 页】");
    expect(text).not.toContain("【第 2 页】");
    const details = result.details as { evidence?: Array<{ page: number }>; displaySummary?: string };
    expect(details.evidence?.map((item) => item.page)).toEqual([1, 3]);
    expect(details.displaySummary).toContain("第 1、3 页");
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

  it("relies on the schema to reject invalid tool input before execution", async () => {
    const registry = createToolRegistry();
    const tool = registry.buildAgentTools(context)[0]!;
    // agent-loop 在执行前用 validateToolArguments 按 parameters schema 拦截无效参数；
    // 这里用同一实现验证 schema 契约。
    const call = (arguments_: unknown) => ({ id: "c1", name: tool.name, arguments: arguments_ });
    expect(() => validateToolArguments(tool, call({ query: "" }))).toThrow();
    // 校验器带 Convert 语义：数字会被宽松转换为字符串后通过（agent-loop 的真实契约）。
    expect(validateToolArguments(tool, call({ query: 42 }))).toEqual({ query: "42" });
    expect(() => validateToolArguments(tool, call("not-an-object"))).toThrow();
    expect(() => validateToolArguments(tool, call({ query: "x".repeat(201) }))).toThrow();
    expect(() => validateToolArguments(tool, call({ query: "ok", limit: 0 }))).toThrow();
    expect(validateToolArguments(tool, call({ query: "ok", limit: 6 }))).toEqual({ query: "ok", limit: 6 });
    // schema 表达不了的语义约束（纯空白）由执行器兜底。
    await expect(tool.execute("call-1", { query: "   " })).rejects.toThrow("检索词");
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
