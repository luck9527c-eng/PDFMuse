import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBookIndex } from "./book-index.js";
import { createLibraryModule } from "../library.js";
import { createPageRenderer } from "../page-render.js";
import { createToolRegistry, type PageImageBudget } from "./tool-registry.js";
import { validateToolArguments } from "./openclaw-core.js";
import { createToolMedia } from "../tool-media.js";

const FIXTURE = path.resolve(import.meta.dirname, "../fixtures/navigation.pdf");

describe("tool registry", () => {
  let dataHome: string;
  let library: ReturnType<typeof createLibraryModule>;
  let bookIndex: ReturnType<typeof createBookIndex>;
  let pageRenderer: ReturnType<typeof createPageRenderer>;
  let bookId: string;
  const recognizedPagesByPage = new Map<string, Array<{ type: string; text: string; bbox: [number, number, number, number] }>>();

  beforeEach(async () => {
    recognizedPagesByPage.clear();
    dataHome = await mkdtemp(path.join(os.tmpdir(), "pdfmuse-tools-"));
    library = createLibraryModule(dataHome);
    bookIndex = createBookIndex(dataHome, {
      getBookSource: (id) => library.getBookSource(id),
      // 识别页判定走同一读接口：indexRecognizedPage 写过的页按 OCR 来源挂模态声明。
      readRecognizedBlocks: (id, page) => recognizedPagesByPage.get(`${id}:${page}`),
    });
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

  function context(
    reportEvidence: (evidence: unknown[]) => void = () => undefined,
    budget: PageImageBudget = { pagesDelivered: 0, deliveredMedia: new Map() },
  ) {
    return {
      bookId,
      bookIndex,
      renderPageImage: (id: string, page: number, scale: number) => pageRenderer.renderPage(id, page, scale),
      renderRegionImage: (id: string, page: number, bbox: [number, number, number, number], scale: number) => pageRenderer.renderRegion(id, page, bbox, scale),
      savePageImage: async (id: string, page: number, _bytes: string, figure?: number) => (
        { relativePath: `${id}/p${page}${figure ? `-f${figure}` : ""}-test.png` }
      ),
      pageBudget: budget,
      reportEvidence: reportEvidence as (evidence: never[]) => void,
    };
  }

  it("exposes the four reading and search tools", () => {
    const registry = createToolRegistry();
    expect(registry.toolNames()).toEqual(["search_book", "read_pages", "view_page", "search_web"]);
  });

  it("delivers figure placeholders inline and retires the batch modality note (T53)", async () => {
    const registry = createToolRegistry();
    const tool = registry.buildAgentTools(context).find((item) => item.name === "read_pages")!;
    // 原生文本页：没有版面解析，没有占位。
    const nativeResult = await tool.execute("call-note-0", { pages: [1] });
    const nativeText = (nativeResult.content[0] as { text: string }).text;
    expect(nativeText).not.toContain("版面解析生成");
    expect(nativeText).not.toContain("[插图");

    // 纯文本/公式块的识别页：无图可升级，零占位零注记。
    recognizedPagesByPage.set(`${bookId}:2`, [
      { type: "text", text: "扫描页识别文本", bbox: [0, 0, 1, 1] },
      { type: "equation", text: "E=mc^{2}", bbox: [0, 0, 1, 0.1] },
    ]);
    bookIndex.indexRecognizedPage(bookId, 2, [
      { text: "扫描页识别文本", type: "text", bbox: [0, 0, 1, 1] },
      { text: "E=mc^{2}", type: "equation", bbox: [0, 0, 1, 0.1] },
    ]);
    const plainOcr = await tool.execute("call-note-1", { pages: [2] });
    const plainOcrText = (plainOcr.content[0] as { text: string }).text;
    expect(plainOcrText).not.toContain("[插图");
    expect(plainOcrText).not.toContain("版面解析生成");

    // 含插图块的识别页：自描述占位行落在图所在的位置，整批注记已退役（占位与注记互斥）。
    recognizedPagesByPage.set(`${bookId}:3`, [
      { type: "text", text: "带插图的扫描页", bbox: [0, 0, 1, 1] },
      { type: "image", text: "", bbox: [0.1, 0.2, 0.6, 0.9] },
    ]);
    bookIndex.indexRecognizedPage(bookId, 3, [
      { text: "带插图的扫描页", type: "text", bbox: [0, 0, 1, 1] },
      { text: "", type: "image", bbox: [0.1, 0.2, 0.6, 0.9] },
    ]);
    const figureResult = await tool.execute("call-note-2", { pages: [3] });
    const figureText = (figureResult.content[0] as { text: string }).text;
    expect(figureText).toContain("[插图 1·约占页面 35%：内容不可见，可用 view_page 查看第 3 页插图 1]");
    expect(figureText).not.toContain("版面解析生成");
  });

  it("returns rendered page images as image content blocks via view_page", async () => {
    const registry = createToolRegistry();
    const tool = registry.buildAgentTools(context).find((item) => item.name === "view_page")!;
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

  it("persists page image files to the media directory with references in details (T44)", async () => {
    const toolMedia = createToolMedia(dataHome);
    const registry = createToolRegistry();
    const tool = registry.buildAgentTools(() => ({ ...context(), savePageImage: toolMedia.savePageImage }))
      .find((item) => item.name === "view_page")!;
    const result = await tool.execute("call-media-1", { pages: [1, 2] });

    const details = result.details as { media?: Array<{ page: number; path: string }> };
    expect(details.media?.map((item) => item.page)).toEqual([1, 2]);
    for (const item of details.media ?? []) {
      // 落盘字节 = 随结果发给模型的字节（live 与回放同源）。
      const stored = await readFile(path.join(dataHome, "media", item.path));
      expect(stored.length).toBeGreaterThan(100);
    }
    const content = result.content as Array<{ type: string; data?: string }>;
    expect(content.filter((block) => block.type === "image")).toHaveLength(2);
  });

  it("describes view_page as the responsibility-scoped tool without invitations or procedures (T54)", () => {
    const registry = createToolRegistry();
    const description = registry.buildAgentTools(context)
      .find((item) => item.name === "view_page")!.description;
    // 职责要素：文本层没有的内容、读者点名触发、可疑核对、figure 页内寻址。
    expect(description).toContain("文本层没有的内容");
    expect(description).toContain("[插图 N·…] 占位");
    expect(description).toContain("读者要求查看或解释某个图、表时直接调用");
    expect(description).toContain("文本形式可疑");
    expect(description).toContain("原生文本页的复杂表格与公式在纯文本中同样可能失真");
    expect(description).toContain("公式与表格通常已完整转为文本");
    expect(description).toContain("页内编号，从 1 开始");
    expect(description).toContain("figure=N");
    // 邀请式/流程式/不可判前提/失实措辞不得回流（T54 禁词）。
    expect(description).not.toContain("没有次数限制");
    expect(description).not.toContain("额度");
    expect(description).not.toContain("默认只查看 1 页");
    expect(description).not.toContain("定位准");
    expect(description).not.toContain("无法保留");
  });

  it("describes the three text tools with responsibility scope and page-number conventions (T54)", () => {
    const registry = createToolRegistry();
    const descriptions = new Map(registry.buildAgentTools(context).map((tool) => [tool.name, tool.description]));
    const searchBook = descriptions.get("search_book")!;
    expect(searchBook).toContain("定位相关页码");
    expect(searchBook).toContain("页码为 PDF 页序号（从 1 开始），不是书内印刷页码");
    expect(searchBook).toContain("检索摘录只是片段");
    expect(searchBook).not.toContain("没有每问次数限制");
    expect(searchBook).not.toContain("标准顺序");
    expect(searchBook).not.toContain("反复检索");

    const readPages = descriptions.get("read_pages")!;
    expect(readPages).toContain("页序号，从 1 开始");
    expect(readPages).toContain("前 20,000 字符");
    expect(readPages).toContain("字符偏移（不是页码偏移）");
    expect(readPages).toContain("OCR 识别文本");
    expect(readPages).not.toContain("没有每问次数限制");
    expect(readPages).not.toContain("章节跨页");
    expect(readPages).not.toContain("从头部截断");

    const searchWeb = descriptions.get("search_web")!;
    expect(searchWeb).toContain("优先使用书内工具");
    expect(searchWeb).toContain("冲突时，分别说明双方及各自出处");
    expect(searchWeb).not.toContain("每问最多");
    expect(searchWeb).not.toContain("额度");
  });

  it("clamps view_page to the twenty-page per-question quota with a note and echo annotation", async () => {
    const registry = createToolRegistry();
    const budget = { pagesDelivered: 18, deliveredMedia: new Map<string, string>() };
    const tool = registry.buildAgentTools(() => context(undefined, budget))
      .find((item) => item.name === "view_page")!;

    const first = await tool.execute("call-budget-1", { pages: [1, 2, 3] });
    const firstText = (first.content[0] as { text: string }).text;
    expect(first.content.filter((block) => block.type === "image")).toHaveLength(2);
    // 额度回显走注解层（T50）：逐次变化的文本不进指纹哈希，也不直接出现在基础文本里。
    expect(firstText).not.toContain("本问图片预算");
    expect((first.details as { annotations?: string[] }).annotations).toEqual(["本问图片预算：已用 20/20 页。"]);
    // 只剩 2 页：钳制交付页 1、2，页 3 不渲染、不进证据。
    expect(firstText).toContain("额度只剩 2 页");
    expect(firstText).toContain("第 3 页未附上");
    const details = first.details as { evidence?: Array<{ page: number }> };
    expect(details.evidence?.map((item) => item.page)).toEqual([1, 2]);

    // 额度用满后的新请求：软提示不再出图，模型可改用文字工具继续。
    const second = await tool.execute("call-budget-2", { pages: [4] });
    expect(second.content.filter((block) => block.type === "image")).toHaveLength(0);
    const secondText = (second.content[0] as { text: string }).text;
    expect(secondText).toContain("图片额度已用完（20 页）");
    expect(secondText).toContain("不要再调用 view_page，用文字工具继续");
    expect((second.details as { evidence?: unknown }).evidence).toBeUndefined();
  });

  it("reuses same-question delivered pages without re-rendering and without spending quota", async () => {
    const toolMedia = createToolMedia(dataHome);
    const registry = createToolRegistry();
    const budget = { pagesDelivered: 0, deliveredMedia: new Map<string, string>() };
    let renders = 0;
    const countingContext = () => ({
      ...context(undefined, budget),
      savePageImage: toolMedia.savePageImage,
      loadPageImage: toolMedia.loadPageImage,
      renderPageImage: async (id: string, page: number, scale: number) => {
        renders += 1;
        return pageRenderer.renderPage(id, page, scale);
      },
    });
    const tool = registry.buildAgentTools(countingContext).find((item) => item.name === "view_page")!;
    const first = await tool.execute("call-reuse-1", { pages: [1] });
    const firstBytes = (first.content.find((block) => block.type === "image") as { data: string }).data;
    expect(renders).toBe(1);

    // 同问同页复用：字节恒同、不重复渲染、不扣页数额度。
    const second = await tool.execute("call-reuse-2", { pages: [1] });
    expect(renders).toBe(1);
    const secondBytes = (second.content.find((block) => block.type === "image") as { data: string }).data;
    expect(secondBytes).toBe(firstBytes);
    expect(budget.pagesDelivered).toBe(1);
    const secondDetails = second.details as { media?: Array<{ page: number; path: string }> };
    expect(secondDetails.media?.[0]?.path).toBe((first.details as { media?: Array<{ page: number; path: string }> }).media?.[0]?.path);
  });

  it("views a single figure crop via the figure parameter with reuse and quota accounting (T53)", async () => {
    const registry = createToolRegistry();
    const toolMedia = createToolMedia(dataHome);
    const budget = { pagesDelivered: 0, deliveredMedia: new Map<string, string>() };
    let regionRenders = 0;
    const countingContext = () => ({
      ...context(undefined, budget),
      savePageImage: toolMedia.savePageImage,
      loadPageImage: toolMedia.loadPageImage,
      renderRegionImage: async (id: string, page: number, bbox: [number, number, number, number], scale: number) => {
        regionRenders += 1;
        return pageRenderer.renderRegion(id, page, bbox, scale);
      },
    });
    // 识别页 2 带两幅插图：figure 寻址与占位编号同序（第 2 幅 = 第二个 image 块）。
    recognizedPagesByPage.set(`${bookId}:2`, [
      { type: "text", text: "带图页", bbox: [0, 0, 1, 0.1] },
      { type: "image", text: "", bbox: [0.1, 0.1, 0.45, 0.5] },
      { type: "image", text: "", bbox: [0.55, 0.1, 0.9, 0.5] },
    ]);
    const tool = registry.buildAgentTools(countingContext).find((item) => item.name === "view_page")!;

    const first = await tool.execute("call-figure-1", { pages: [2], figure: 2 });
    expect(regionRenders).toBe(1);
    const firstImage = first.content.find((block) => block.type === "image") as { data: string };
    expect(firstImage.data.length).toBeGreaterThan(100);
    const firstText = (first.content[0] as { text: string }).text;
    expect(firstText).toContain("第 2 页插图 2 的原图裁剪");
    const firstDetails = first.details as {
      media?: Array<{ page: number; path: string }>;
      evidence?: Array<{ page: number }>;
      annotations?: string[];
    };
    expect(firstDetails.media?.[0]?.path).toContain("p2-f2-");
    expect(firstDetails.evidence?.[0]?.page).toBe(2);
    expect(firstDetails.annotations).toEqual(["本问图片预算：已用 1/20 页。"]);

    // 同问同幅复用：不重复渲染、字节恒同、不扣额度；整页查看键独立、互不挤占。
    const second = await tool.execute("call-figure-2", { pages: [2], figure: 2 });
    expect(regionRenders).toBe(1);
    expect((second.content.find((block) => block.type === "image") as { data: string }).data).toBe(firstImage.data);
    const wholePage = await tool.execute("call-figure-3", { pages: [2] });
    expect(wholePage.content.filter((block) => block.type === "image")).toHaveLength(1);
    expect(budget.pagesDelivered).toBe(2);

    // 编号越界与多页请求：软错误结果指引修正，不抛错。
    const beyond = await tool.execute("call-figure-4", { pages: [2], figure: 3 });
    expect((beyond.content[0] as { text: string }).text).toContain("没有第 3 号插图");
    const multiPage = await tool.execute("call-figure-5", { pages: [1, 2], figure: 1 });
    expect((multiPage.content[0] as { text: string }).text).toContain("只传该插图所在的一页");

    // 额度用完后的插图查看：与整页同文案软拒绝。
    budget.pagesDelivered = 20;
    const exhausted = await tool.execute("call-figure-6", { pages: [2], figure: 1 });
    expect((exhausted.content[0] as { text: string }).text).toContain("图片额度已用完（20 页）");
  });

  it("keeps image quotas separate across questions", async () => {
    const registry = createToolRegistry();
    const toolOf = (budget: PageImageBudget) => registry.buildAgentTools(() => context(undefined, budget))
      .find((item) => item.name === "view_page")!;
    await toolOf({ pagesDelivered: 0, deliveredMedia: new Map() }).execute("call-q1", { pages: [1, 2] });

    // 新的一问：页数额度与复用键都随运行重建（agent-host 每问新建预算对象）。
    const secondBudget = { pagesDelivered: 0, deliveredMedia: new Map<string, string>() };
    const second = await toolOf(secondBudget).execute("call-q2", { pages: [3] });
    expect(second.content.filter((block) => block.type === "image")).toHaveLength(1);
    expect((second.details as { annotations?: string[] }).annotations).toEqual(["本问图片预算：已用 1/20 页。"]);
  });

  it("continues reading truncated pages with the offset parameter", async () => {
    const registry = createToolRegistry();
    const tool = registry.buildAgentTools(context).find((item) => item.name === "read_pages")!;
    const first = await tool.execute("call-offset-1", { pages: [1] });
    const firstText = (first.content[0] as { text: string }).text;

    // 续读：从 offset 3 起读同一批页码，正文是同一全文的切片并附完成注记。
    const second = await tool.execute("call-offset-2", { pages: [1], offset: 3 });
    const secondText = (second.content[0] as { text: string }).text;
    expect(secondText.startsWith(firstText.slice(3))).toBe(true);
    expect(secondText).toContain("已读完整");

    // offset 超过全文长度：明确说明没有更多内容。
    const beyond = await tool.execute("call-offset-3", { pages: [1], offset: firstText.length + 10 });
    const beyondText = (beyond.content[0] as { text: string }).text;
    expect(beyondText).toContain("没有更多内容");
  });

  it("returns a soft timeout result when a tool call exceeds the unified limit", async () => {
    const registry = createToolRegistry({ toolTimeoutMs: 40 });
    const hangingSearch = { search: () => new Promise(() => undefined) };
    const tool = registry.buildAgentTools(() => ({ ...context(), webSearch: hangingSearch as never }))
      .find((item) => item.name === "search_web")!;
    const result = await tool.execute("call-timeout-1", { query: "挂死搜索" });
    const text = (result.content[0] as { text: string }).text;
    // 420 秒软超时文案（注入时限按比例呈现）：软错误结果，模型可继续，不抛错。
    expect(text).toContain("工具调用超时");
    expect(text).toContain("本次调用已中断");
    expect(text).toContain("换参数缩小范围");
    expect((result.details as { timeout?: boolean }).timeout).toBe(true);
  });

  it("returns web results with provider notes via search_web", async () => {
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
    const tool = registry.buildAgentTools(() => ({ ...context(), webSearch: fakeSearch })).find((item) => item.name === "search_web")!;
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

  it("executes search_book with indexing, evidence and a model-facing summary", async () => {
    const registry = createToolRegistry();
    const tool = registry.buildAgentTools(context)[0]!;
    expect(tool.name).toBe("search_book");
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

  it("points to read_pages when a search misses the book", async () => {
    const registry = createToolRegistry();
    const tool = registry.buildAgentTools(() => ({ ...context(), focus: { currentPage: 10 } }))[0]!;

    // 空命中：把下一步写进结果——改用 read_pages 读当前页附近的整页原文。
    const empty = await tool.execute("call-hint-0", { query: "绝对不存在的词组" });
    const emptyText = (empty.content[0] as { text: string }).text;
    expect(emptyText).toContain("没有在书中找到相关内容");
    expect(emptyText).toContain("read_pages");
    expect(emptyText).toContain("第 10 页");
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
