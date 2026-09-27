import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assembleOutline,
  createBookOutlineModule,
  detectHeadingCandidates,
  evaluateEmbeddedOutline,
  findOutlineChapterRange,
  findOutlineSectionPath,
  type BookOutlineAiDeps,
  type OpenOutlineDocument,
  type OutlineHeading,
  type OutlineTextLine,
  type TocRow,
} from "./book-outline.js";
import type { BookOutlineNode } from "../shared/contracts.js";
import { createOcrModule } from "./ocr.js";
import type { MineruEngine } from "./mineru.js";

const BOOK_ID = "a".repeat(64);
const NAVIGATION_FIXTURE = path.resolve(import.meta.dirname, "fixtures/navigation.pdf");
const NO_OUTLINE_FIXTURE = path.resolve(import.meta.dirname, "fixtures/three-page.pdf");

function documentSource(
  pages: OutlineTextLine[][],
  options: { embeddedNodes?: BookOutlineNode[]; visited?: number[]; onOpen?: () => void } = {},
): OpenOutlineDocument {
  return async () => {
    options.onOpen?.();
    return {
      pageCount: pages.length,
      async getEmbeddedNodes() {
        return options.embeddedNodes ?? [];
      },
      async getNativeLines(page) {
        options.visited?.push(page);
        return pages[page - 1] ?? [];
      },
      async close() { return undefined; },
    };
  };
}

function aiOutlineDeps(
  entries: Array<{ label: string; level: 1 | 2; printedPage: number | null }>,
  tocPages: number[] = [],
): {
  deps: BookOutlineAiDeps;
  completeCalls: number;
} {
  const state = { completeCalls: 0 };
  return {
    deps: {
      renderPage: async () => ({ imageData: "aW1n" }),
      complete: async () => {
        state.completeCalls += 1;
        return JSON.stringify({
          hasToc: entries.length > 0,
          tocPages,
          entries: entries.map((entry) => ({ ...entry, printedPage: entry.printedPage })),
          continuesAt: null,
        });
      },
    },
    get completeCalls() { return state.completeCalls; },
  };
}

describe("book outline", () => {
  let dataHome: string;
  let closeOutline: (() => void) | undefined;
  let closeOcr: (() => void) | undefined;

  beforeEach(async () => {
    dataHome = await mkdtemp(path.join(os.tmpdir(), "pdfmuse-outline-"));
    const ocr = createOcrModule(dataHome, {
      name: "测试 OCR",
      model: "测试模型",
      async recognize(input) {
        return { width: input.width, height: input.height, orientation: 0, lines: [] };
      },
    });
    closeOcr = ocr.close;
  });

  afterEach(async () => {
    closeOutline?.();
    closeOcr?.();
    closeOutline = undefined;
    closeOcr = undefined;
    await rm(dataHome, { recursive: true, force: true });
  });

  it("detects explicit and typographic headings", () => {
    const first = detectHeadingCandidates(1, [
      { text: "第一章 基础", size: 24, y: 700 },
      { text: "普通正文内容。", size: 12, y: 650 },
    ]);
    const second = detectHeadingCandidates(2, [
      { text: "1.1 核心概念", size: 16, y: 700 },
      { text: "More body text.", size: 12, y: 650 },
    ]);
    expect(first[0]).toMatchObject({ label: "第一章 基础", level: 1, explicit: true });
    expect(second[0]).toMatchObject({ label: "1.1 核心概念", level: 2, explicit: true });
  });

  it("drops list items and math fragments but keeps pinyin-annotated titles", () => {
    const candidates = detectHeadingCandidates(23, [
      { text: "第一章 品数与板哦", size: 15, y: 18 },
      { text: "2. 函数的几种特性", size: 21, y: 300 },
      { text: "这个函数的图形如图1-6所示.", size: 17, y: 400 },
      { text: "对任一x∈X都成立，那么称函数f(x)在X上有上界，而K称为函数f(x)在X上的", size: 19, y: 500 },
      { text: "V-β", size: 24, y: 600 },
      { text: "v≥V0,", size: 25, y: 660 },
    ]);
    expect(candidates).toEqual([
      expect.objectContaining({ label: "第一章 品数与板哦", level: 1, explicit: true }),
    ]);
    const titles = detectHeadingCandidates(7, [
      { text: "窃(qiè)读记", size: 40, y: 100 },
      { text: "转过街角，看见饭店的招牌，闻见炒菜的香味，听", size: 18, y: 200 },
      { text: "见锅勺敲打的声音，我放慢了脚步。放学后急匆匆地", size: 18, y: 240 },
    ]);
    expect(titles).toEqual([
      expect.objectContaining({ label: "窃(qiè)读记" }),
    ]);
  });

  it("keeps a valid embedded outline authoritative and persists its nodes", async () => {
    const embeddedNodes: BookOutlineNode[] = [
      { id: "e-1", label: "Chapter One", page: 1, children: [] },
      { id: "e-2", label: "Chapter Two", page: 2, children: [] },
      { id: "e-3", label: "Chapter Three", page: 4, children: [] },
    ];
    const outline = createBookOutlineModule(dataHome, {
      openDocument: documentSource([[], [], [], [], []], { embeddedNodes }),
    });
    closeOutline = outline.close;
    const result = await outline.rebuild(BOOK_ID, async () => ({ bytes: new Uint8Array() }));
    expect(result).toMatchObject({ status: "embedded", nodes: embeddedNodes });
    expect(outline.get(BOOK_ID)).toEqual(embeddedNodes);
  });

  it("assembles the outline from ai entries and body anchors", async () => {
    closeOcr?.();
    // p.1 是印刷目录页（同名列出章节），p.2/p.3 是正文真标题页。
    const engine: MineruEngine = {
      name: "测试 OCR",
      model: "测试模型",
      async recognizePage(input) {
        const heading = input.page === 1 ? "第一章 扫描内容" : input.page === 2 ? "第一章 扫描内容" : "1.1 识别小节";
        return {
          blocks: [
            { type: "text", text: heading, bbox: [0.01, 0.01, 0.5, 0.05] },
            { type: "text", text: "这是扫描页正文。", bbox: [0.01, 0.1, 0.5, 0.118] },
          ],
          markdown: heading,
        };
      },
    };
    const ocr = createOcrModule(dataHome, engine, {
      resolvePdfPath: (bookId) => (bookId === BOOK_ID ? { path: "C:/book.pdf", encrypted: false } : undefined),
    });
    closeOcr = ocr.close;
    for (const page of [1, 2, 3]) {
      await ocr.recognizePage({ bookId: BOOK_ID, page });
    }
    const ai = aiOutlineDeps([
      { label: "第一章 扫描内容", level: 1, printedPage: 1 },
      { label: "1.1 识别小节", level: 2, printedPage: 2 },
    ], [1]);
    const outline = createBookOutlineModule(dataHome, {
      openDocument: documentSource([[], [], []]),
      aiOutline: ai.deps,
      readRecognizedBlocks: (bookId, page) => ocr.getPage(bookId, page)?.blocks,
    });
    closeOutline = outline.close;
    const result = await outline.rebuild(BOOK_ID, async () => ({ bytes: new Uint8Array() }));
    expect(result.status).toBe("generated");
    expect(ai.completeCalls).toBe(1);
    // 第一章 锚定到正文页 p.2，而不是目录页 p.1。
    expect(outline.get(BOOK_ID)).toMatchObject([
      { label: "第一章 扫描内容", page: 2, children: [{ label: "1.1 识别小节", page: 3 }] },
    ]);
  });

  it("caches ai entries across rebuilds and clears them on invalidate", async () => {
    const ai = aiOutlineDeps([{ label: "第一章 缓存", level: 1, printedPage: 1 }]);
    const pages: OutlineTextLine[][] = [
      [{ text: "第一章 缓存", size: 24, y: 700 }, { text: "普通正文内容，长度足够参与统计。", size: 12, y: 650 }],
    ];
    const outline = createBookOutlineModule(dataHome, { openDocument: documentSource(pages), aiOutline: ai.deps });
    closeOutline = outline.close;
    await outline.rebuild(BOOK_ID, async () => ({ bytes: new Uint8Array() }));
    await outline.rebuild(BOOK_ID, async () => ({ bytes: new Uint8Array() }));
    expect(ai.completeCalls).toBe(1);
    outline.invalidate(BOOK_ID);
    await outline.rebuild(BOOK_ID, async () => ({ bytes: new Uint8Array() }));
    expect(ai.completeCalls).toBe(2);
  });

  it("falls back to an empty outline when the model finds no toc", async () => {
    const ai = aiOutlineDeps([]);
    const outline = createBookOutlineModule(dataHome, {
      openDocument: documentSource([[{ text: "第一章 无目录", size: 24, y: 700 }]]),
      aiOutline: ai.deps,
    });
    closeOutline = outline.close;
    const result = await outline.rebuild(BOOK_ID, async () => ({ bytes: new Uint8Array() }));
    expect(result).toMatchObject({ status: "generated", nodes: [] });
    expect(outline.get(BOOK_ID)).toEqual([]);
  });

  it("does not cache a failed ai run", async () => {
    let calls = 0;
    const deps: BookOutlineAiDeps = {
      renderPage: async () => ({ imageData: "aW1n" }),
      complete: async () => {
        calls += 1;
        throw new Error("网络错误");
      },
    };
    const outline = createBookOutlineModule(dataHome, {
      openDocument: documentSource([[{ text: "第一章 断网", size: 24, y: 700 }]]),
      aiOutline: deps,
    });
    closeOutline = outline.close;
    const result = await outline.rebuild(BOOK_ID, async () => ({ bytes: new Uint8Array() }));
    expect(result).toMatchObject({ status: "generated", nodes: [] });
    // 失败不落缓存：下一次重建会重新调用模型。
    await outline.rebuild(BOOK_ID, async () => ({ bytes: new Uint8Array() }));
    expect(calls).toBe(2);
  });

  it("does not cache an aborted ai run as a no-toc verdict", async () => {    const ai = aiOutlineDeps([{ label: "第一章 中止", level: 1, printedPage: 1 }]);
    const pages: OutlineTextLine[][] = [
      [{ text: "第一章 中止", size: 24, y: 700 }, { text: "普通正文内容，长度足够参与统计。", size: 12, y: 650 }],
    ];
    const outline = createBookOutlineModule(dataHome, { openDocument: documentSource(pages), aiOutline: ai.deps });
    closeOutline = outline.close;
    const controller = new AbortController();
    controller.abort();
    const result = await outline.rebuild(BOOK_ID, async () => ({ bytes: new Uint8Array() }), controller.signal);
    expect(result).toMatchObject({ status: "partial", processedPages: 0 });
    // 半成品未入库：下一次重建会重新调用模型。
    await outline.rebuild(BOOK_ID, async () => ({ bytes: new Uint8Array() }));
    expect(ai.completeCalls).toBe(1);
  });

  it("resumes from persisted page candidates after interruption", async () => {
    const visited: number[] = [];
    const pages = [1, 2, 3].map((page) => [
      { text: `Chapter ${page}`, size: 22, y: 700 },
      { text: "Body text.", size: 12, y: 650 },
    ]);
    const outline = createBookOutlineModule(dataHome, { openDocument: documentSource(pages, { visited }) });
    closeOutline = outline.close;
    const controller = new AbortController();
    const partial = await outline.rebuild(
      BOOK_ID,
      async () => ({ bytes: new Uint8Array() }),
      controller.signal,
      (page) => { if (page === 1) controller.abort(); },
    );
    expect(partial).toMatchObject({ status: "partial", processedPages: 1 });
    const completed = await outline.rebuild(BOOK_ID, async () => ({ bytes: new Uint8Array() }));
    expect(completed).toMatchObject({ status: "generated", processedPages: 3 });
    expect(visited).toEqual([1, 2, 3]);
  });

  it("discards stale page candidates when the outline version changes", async () => {
    const visited: number[] = [];
    const pages = [1, 2].map((page) => [
      { text: `第一章 标题${page}`, size: 24, y: 700 },
      { text: "普通正文内容，长度足够参与统计。", size: 12, y: 650 },
    ]);
    const stale = createBookOutlineModule(dataHome, { openDocument: documentSource(pages) });
    await stale.rebuild(BOOK_ID, async () => ({ bytes: new Uint8Array() }));
    stale.close();
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(path.join(dataHome, "pdfmuse.db"));
    database.exec(`
      UPDATE book_outlines SET version = 1 WHERE book_id = '${BOOK_ID}';
      UPDATE book_outline_pages SET candidates_json = '[]' WHERE book_id = '${BOOK_ID}';
    `);
    database.close();
    const outline = createBookOutlineModule(dataHome, { openDocument: documentSource(pages, { visited }) });
    closeOutline = outline.close;
    const result = await outline.rebuild(BOOK_ID, async () => ({ bytes: new Uint8Array() }));
    expect(result).toMatchObject({ status: "generated", processedPages: 2 });
    expect(visited).toEqual([1, 2]);
    expect(outline.get(BOOK_ID)).toEqual([]);
  });

  it("recognizes the real fixture embedded outline and persists it for retrieval weighting", async () => {
    const outline = createBookOutlineModule(dataHome);
    closeOutline = outline.close;
    const bytes = new Uint8Array(await readFile(NAVIGATION_FIXTURE));
    const result = await outline.rebuild(BOOK_ID, async () => ({ bytes }));
    expect(result.status).toBe("embedded");
    // 内嵌书签落库为可读目录：渲染端继续直接消费 PDF 大纲，检索的所在章加权读这份。
    const nodes = outline.get(BOOK_ID);
    expect(nodes?.map((node) => node.label)).toEqual(["Chapter One", "Chapter Two", "Chapter Three"]);
    expect(nodes?.every((node) => node.page !== undefined)).toBe(true);
    expect(nodes?.[0]?.children[0]).toMatchObject({ label: "Section One", page: 1 });
  });

  it("falls through to ai generation when the embedded outline is per-page junk", async () => {
    const junk = [1, 2, 3].map((page) => ({ id: `j-${page}`, label: `第${page}页`, page, children: [] }));
    const ai = aiOutlineDeps([{ label: "第一章 正文生成", level: 1, printedPage: 1 }]);
    const outline = createBookOutlineModule(dataHome, {
      openDocument: documentSource([[], [], []], { embeddedNodes: junk }),
      aiOutline: ai.deps,
    });
    closeOutline = outline.close;
    const result = await outline.rebuild(BOOK_ID, async () => ({ bytes: new Uint8Array() }));
    // 3 条逐页书签（页码 1,2,3 严格连续）被闸门拒收后直接弃用，AI 兜底生成。
    expect(result.status).toBe("generated");
    expect(ai.completeCalls).toBe(1);
    expect(outline.get(BOOK_ID)).toEqual([]);
  });

  it("fast path persists embedded nodes synchronously and skips re-opening on cache hit", async () => {
    const embeddedNodes: BookOutlineNode[] = [
      { id: "e-1", label: "Chapter One", page: 1, children: [] },
      { id: "e-2", label: "Chapter Two", page: 2, children: [] },
      { id: "e-3", label: "Chapter Three", page: 4, children: [] },
    ];
    let opened = 0;
    const outline = createBookOutlineModule(dataHome, {
      openDocument: documentSource([[], [], [], [], []], { embeddedNodes, onOpen: () => { opened += 1; } }),
    });
    closeOutline = outline.close;
    const loadBook = async () => ({ bytes: new Uint8Array() });
    expect(await outline.ensureEmbedded(BOOK_ID, loadBook)).toEqual(embeddedNodes);
    expect(outline.get(BOOK_ID)).toEqual(embeddedNodes);
    expect(await outline.ensureEmbedded(BOOK_ID, loadBook)).toEqual(embeddedNodes);
    expect(opened).toBe(1);
  });

  it("fast path skips re-opening once the pipeline has adjudicated tier one", async () => {
    const ai = aiOutlineDeps([{ label: "第一章 在途", level: 1, printedPage: 1 }]);
    const pages: OutlineTextLine[][] = [
      [{ text: "第一章 在途", size: 24, y: 700 }, { text: "普通正文内容，长度足够参与统计。", size: 12, y: 650 }],
    ];
    let opened = 0;
    const outline = createBookOutlineModule(dataHome, {
      openDocument: documentSource(pages, { onOpen: () => { opened += 1; } }),
      aiOutline: ai.deps,
    });
    closeOutline = outline.close;
    const loadBook = async () => ({ bytes: new Uint8Array() });
    await outline.rebuild(BOOK_ID, loadBook);
    expect(opened).toBe(1);
    // 页级失效只删 book_outlines 行与单页候选，AI 缓存仍在——管线已裁决第一档，快检不再开书。
    outline.invalidate(BOOK_ID, 1);
    expect(await outline.ensureEmbedded(BOOK_ID, loadBook)).toBeUndefined();
    expect(opened).toBe(1);
  });

  it("fast path returns undefined without persisting for books without a usable embedded outline", async () => {
    let opened = 0;
    const outline = createBookOutlineModule(dataHome, {
      openDocument: documentSource([[{ text: "第一章 无书签", size: 24, y: 700 }]], { onOpen: () => { opened += 1; } }),
    });
    closeOutline = outline.close;
    expect(await outline.ensureEmbedded(BOOK_ID, async () => ({ bytes: new Uint8Array() }))).toBeUndefined();
    expect(outline.get(BOOK_ID)).toBeUndefined();
    expect(opened).toBe(1);
  });

  it("does not turn a repeated page header into a generated outline", async () => {
    const outline = createBookOutlineModule(dataHome);
    closeOutline = outline.close;
    const bytes = new Uint8Array(await readFile(NO_OUTLINE_FIXTURE));
    const result = await outline.rebuild(BOOK_ID, async () => ({ bytes }));
    expect(result).toMatchObject({ status: "generated", nodes: [] });
    expect(outline.get(BOOK_ID)).toEqual([]);
  });

  it("resolves the printed-to-pdf offset by voting and clips out-of-range entries", () => {
    const tocRows: TocRow[] = [
      { label: "第一章 函数与极限", level: 1, printedPage: 1 },
      { label: "第一节 映射与函数", level: 2, printedPage: 2 },
      { label: "第二节 数列的极限", level: 2, printedPage: 18 },
      { label: "第二章 导数与微分", level: 1, printedPage: 60 },
      { label: "第一节 导数概念", level: 2, printedPage: 61 },
      { label: "第十二章 无穷级数", level: 1, printedPage: 330 },
    ];
    const headings: OutlineHeading[] = [
      { label: "第一章 函数与极限", page: 18, level: 1, explicit: true },
      { label: "第一节 映射与函数", page: 19, level: 2, explicit: true },
      { label: "第二节 数列的极限", page: 35, level: 2, explicit: true },
      { label: "第一章 品数与板哦", page: 23, level: 1, explicit: true },
      { label: "第一节 映射与函数", page: 40, level: 2, explicit: true },
      { label: "第二章 导数与微分", page: 77, level: 1, explicit: true },
    ];
    const result = assembleOutline(headings, tocRows, 150);
    expect(result.strategy).toBe("toc");
    expect(result.nodes).toMatchObject([
      {
        label: "第一章 函数与极限", page: 18,
        children: [
          { label: "第一节 映射与函数", page: 19 },
          { label: "第二节 数列的极限", page: 35 },
        ],
      },
      {
        label: "第二章 导数与微分", page: 77,
        children: [{ label: "第一节 导数概念", page: 78 }],
      },
    ]);
    expect(result.nodes.some((node) => node.label.includes("无穷级数"))).toBe(false);
  });

  it("anchors chapters without printed pages to body headings", () => {
    const tocRows: TocRow[] = [
      { label: "第三章 无锚", level: 1, printedPage: undefined },
      { label: "3.1 有页码", level: 2, printedPage: 5 },
      { label: "3.2 有页码", level: 2, printedPage: 8 },
    ];
    const headings: OutlineHeading[] = [
      { label: "3.1 有页码", page: 22, level: 2, explicit: true },
      { label: "3.2 有页码", page: 25, level: 2, explicit: true },
    ];
    const result = assembleOutline(headings, tocRows, 150);
    expect(result.strategy).toBe("toc");
    expect(result.nodes).toMatchObject([
      { label: "第三章 无锚", page: 22, children: [{ label: "3.1 有页码", page: 22 }, { label: "3.2 有页码", page: 25 }] },
    ]);
  });

  it("matches lesson titles across pinyin annotations and adopts leading lessons", () => {
    const tocRows: TocRow[] = [
      { label: "1 窃读记", level: 2, printedPage: 2 },
      { label: "第一组", level: 1, printedPage: undefined },
      { label: "2* 小苗与大树的对话", level: 2, printedPage: 7 },
    ];
    const headings: OutlineHeading[] = [
      { label: "窃(qiè)读记", page: 7, level: 1, explicit: false },
      { label: "第一组", page: 6, level: 1, explicit: true },
      { label: "小苗与大树的对话", page: 12, level: 1, explicit: false },
    ];
    const result = assembleOutline(headings, tocRows, 189);
    expect(result.strategy).toBe("toc");
    expect(result.nodes).toMatchObject([
      {
        label: "第一组", page: 6,
        children: [
          { label: "1 窃读记", page: 7 },
          { label: "2* 小苗与大树的对话", page: 12 },
        ],
      },
    ]);
  });

  it("returns an empty outline when offset votes are insufficient", () => {
    const tocRows: TocRow[] = [
      { label: "第一章 函数与极限", level: 1, printedPage: 1 },
      { label: "1. 映射概念", level: 2, printedPage: 2 },
    ];
    const headings: OutlineHeading[] = [
      { label: "第一章 函数与极限", page: 18, level: 1, explicit: true },
    ];
    const result = assembleOutline(headings, tocRows, 150);
    expect(result).toEqual({ nodes: [], strategy: "empty" });
  });

  it("deleteBookData 在给定连接上清掉本书目录三表且不影响他书", async () => {
    const otherBookId = "b".repeat(64);
    const ai = aiOutlineDeps([
      { label: "第一章 清理", level: 1, printedPage: 1 },
      { label: "1.1 小节", level: 2, printedPage: 2 },
    ]);
    const pages: OutlineTextLine[][] = [
      [{ text: "第一章 清理", size: 24, y: 700 }, { text: "普通正文内容，长度足够参与统计。", size: 12, y: 650 }],
      [{ text: "1.1 小节", size: 18, y: 700 }, { text: "小节正文内容，长度足够参与统计。", size: 12, y: 650 }],
    ];
    const outline = createBookOutlineModule(dataHome, { openDocument: documentSource(pages), aiOutline: ai.deps });
    closeOutline = outline.close;
    await outline.rebuild(BOOK_ID, async () => ({ bytes: new Uint8Array() }));
    await outline.rebuild(otherBookId, async () => ({ bytes: new Uint8Array() }));
    expect(outline.get(BOOK_ID)).toMatchObject([
      { label: "第一章 清理", children: [{ label: "1.1 小节" }] },
    ]);

    const { DatabaseSync } = await import("node:sqlite");
    const connection = new DatabaseSync(path.join(dataHome, "pdfmuse.db"));
    outline.deleteBookData(BOOK_ID, connection);
    connection.close();

    const verified = new DatabaseSync(path.join(dataHome, "pdfmuse.db"), { readOnly: true });
    const count = (sql: string, ...params: unknown[]) => (
      (verified.prepare(sql).get(...params) as { count: number }).count
    );
    for (const table of ["book_outlines", "book_outline_pages", "book_outline_ai"]) {
      expect(count(`SELECT COUNT(*) AS count FROM ${table} WHERE book_id = ?`, BOOK_ID)).toBe(0);
      expect(count(`SELECT COUNT(*) AS count FROM ${table} WHERE book_id = ?`, otherBookId)).toBeGreaterThan(0);
    }
    verified.close();
    expect(outline.get(otherBookId)).toMatchObject([
      { label: "第一章 清理", children: [{ label: "1.1 小节" }] },
    ]);
  });

  it("notifies outline changes for push delivery", async () => {
    const notified: string[] = [];
    const ai = aiOutlineDeps([{ label: "第一章 推送", level: 1, printedPage: 1 }]);
    const pages: OutlineTextLine[][] = [
      [{ text: "第一章 推送", size: 24, y: 700 }, { text: "普通正文内容，长度足够参与统计。", size: 12, y: 650 }],
    ];
    const outline = createBookOutlineModule(dataHome, {
      openDocument: documentSource(pages),
      aiOutline: ai.deps,
      onOutlineChange: (bookId) => notified.push(bookId),
    });
    closeOutline = outline.close;
    const result = await outline.rebuild(BOOK_ID, async () => ({ bytes: new Uint8Array() }));
    expect(result.status).toBe("generated");
    expect(notified).toEqual([BOOK_ID]);
    outline.invalidate(BOOK_ID);
    expect(notified).toEqual([BOOK_ID, BOOK_ID]);
    outline.invalidate("not-a-book-id");
    expect(notified).toEqual([BOOK_ID, BOOK_ID]);
  });

  it("finds the deepest section path for a reading page", () => {
    const nodes: BookOutlineNode[] = [
      {
        id: "1", label: "第5章 存储系统", page: 120, children: [
          { id: "2", label: "5.2 主存储器", page: 140, children: [
            { id: "3", label: "5.2.3 技术指标", page: 146, children: [] },
          ] },
        ],
      },
      { id: "4", label: "第6章 中央处理器", page: 200, children: [] },
    ];
    expect(findOutlineSectionPath(nodes, 147)).toBe("第5章 存储系统 › 5.2 主存储器 › 5.2.3 技术指标");
    expect(findOutlineSectionPath(nodes, 143)).toBe("第5章 存储系统 › 5.2 主存储器");
    expect(findOutlineSectionPath(nodes, 210)).toBe("第6章 中央处理器");
    expect(findOutlineSectionPath([], 100)).toBeUndefined();
  });

  it("finds the top-level chapter page range for a reading page", () => {
    const nodes: BookOutlineNode[] = [
      { id: "1", label: "第1章", page: 3, children: [] },
      { id: "2", label: "第2章", page: 40, children: [] },
      { id: "3", label: "第3章", page: 120, children: [] },
    ];
    expect(findOutlineChapterRange(nodes, 50, 200)).toEqual({ from: 40, to: 119 });
    expect(findOutlineChapterRange(nodes, 3, 200)).toEqual({ from: 3, to: 39 });
    expect(findOutlineChapterRange(nodes, 200, 200)).toEqual({ from: 120, to: 200 });
    expect(findOutlineChapterRange(nodes, 2, 200)).toBeUndefined();
    expect(findOutlineChapterRange([], 5, 200)).toBeUndefined();
  });
});

describe("embedded outline gate", () => {
  function node(label: string, page: number | undefined, children: BookOutlineNode[] = []): BookOutlineNode {
    return { id: label, label, ...(page === undefined ? {} : { page }), children };
  }

  it("accepts a real chapter tree including section duplicates and sparse pages", () => {
    const navigationLike = [
      node("Chapter One", 1, [node("Section One", 1)]),
      node("Chapter Two", 2, [node("Section Two", 2)]),
      node("Chapter Three", 3, [node("Section Three", 3)]),
    ];
    expect(evaluateEmbeddedOutline(navigationLike, 3)).toMatchObject({ accepted: true, entryCount: 6, distinctPages: 3 });
    const sparse = [
      node("第一章 基础", 10),
      node("第二章 进阶", 20),
      node("第三章 高级", 30),
      node("第四章 专题", 40),
      node("第五章 前沿", 50),
    ];
    expect(evaluateEmbeddedOutline(sparse, 100).accepted).toBe(true);
    const minorityUnresolvable = [node("A", 1), node("B", 2), node("C", undefined), node("D", undefined)];
    expect(evaluateEmbeddedOutline(minorityUnresolvable, 100).accepted).toBe(true);
  });

  it("rejects thin, unresolvable, or single-page trees", () => {
    expect(evaluateEmbeddedOutline([node("A", 1), node("B", 2)], 100).accepted).toBe(false);
    expect(evaluateEmbeddedOutline(
      [node("A", 1), node("B", undefined), node("C", undefined), node("D", undefined)],
      100,
    ).accepted).toBe(false);
    expect(evaluateEmbeddedOutline([node("A", 1), node("B", 1), node("C", 1)], 100).accepted).toBe(false);
  });

  it("rejects garbage labels", () => {
    expect(evaluateEmbeddedOutline([node("A", 5), node("A", 9), node("A", 13)], 100).accepted).toBe(false);
    expect(evaluateEmbeddedOutline(
      [node("未命名章节 1", 5), node("未命名章节 2", 9), node("未命名章节 3", 13)],
      100,
    ).accepted).toBe(false);
    expect(evaluateEmbeddedOutline([node("1", 5), node("2", 9), node("3", 13)], 100).accepted).toBe(false);
  });

  it("rejects the per-page bookmark junk pattern but not real trees with duplicates", () => {
    const perPage = [
      node("第一章 基础", 1),
      node("第二章 进阶", 2),
      node("第三章 高级", 3),
      node("第四章 专题", 4),
      node("第五章 前沿", 5),
    ];
    expect(evaluateEmbeddedOutline(perPage, 5).accepted).toBe(false);
    // 与逐页垃圾同页数，但分节带来的重复页打破严格连续——真实结构放行。
    expect(evaluateEmbeddedOutline(
      [
        node("第一章 基础", 1, [node("1.1 概念", 1)]),
        node("第二章 进阶", 2, [node("2.1 模型", 2)]),
        node("第三章 高级", 3, [node("3.1 实践", 3)]),
      ],
      3,
    ).accepted).toBe(true);
  });
});
