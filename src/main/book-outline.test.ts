import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assembleBodyHeadingOutline,
  assembleOutline,
  createBookOutlineModule,
  detectHeadingCandidates,
  detectRecognizedHeadings,
  evaluateEmbeddedOutline,
  findOutlineChapterRange,
  findOutlineSectionPath,
  locateTocPages,
  repairOutlineMonotonicity,
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
const ANCHOR_FIXTURE = path.resolve(import.meta.dirname, "fixtures/outline-anchors.pdf");

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
    expect(outline.strategy(BOOK_ID)).toBe("embedded");
  });

  it("assembles the outline from ai entries and body anchors", async () => {
    closeOcr?.();
    // p.1 被布局模型标成 index（印刷目录页），p.2/p.3 是正文真标题页。
    const engine: MineruEngine = {
      name: "测试 OCR",
      model: "测试模型",
      async recognizePage(input) {
        if (input.page === 1) {
          return {
            blocks: [
              { type: "index", text: "第一章 扫描内容…………………………1\n1.1 识别小节………………………………2", bbox: [0.1, 0.1, 0.9, 0.5] },
            ],
            markdown: "目录",
          };
        }
        const heading = input.page === 2 ? "第一章 扫描内容" : "1.1 识别小节";
        return {
          blocks: [
            { type: "paragraph_title", text: heading, bbox: [0.01, 0.01, 0.5, 0.05] },
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
    expect(outline.strategy(BOOK_ID)).toBe("ai_toc");
    // 第一章 锚定到正文页 p.2，而不是目录页 p.1。
    expect(outline.get(BOOK_ID)).toMatchObject([
      { label: "第一章 扫描内容", page: 2, children: [{ label: "1.1 识别小节", page: 3 }] },
    ]);
  });

  it("caches ai entries across rebuilds and clears them on invalidate", async () => {
    const ai = aiOutlineDeps([{ label: "第一章 缓存", level: 1, printedPage: 1 }]);
    const pages: OutlineTextLine[][] = [
      [
        { text: "全书目录", size: 18, y: 740 },
        { text: "第一章 缓存……………………………………1", size: 12, y: 700 },
        { text: "1.1 缓存内容…………………………………3", size: 12, y: 660 },
        { text: "第二章 收束…………………………………5", size: 12, y: 620 },
        { text: "附录 参考答案………………………………9", size: 12, y: 580 },
      ],
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
    const pages: OutlineTextLine[][] = [
      [
        { text: "第一章 断网………………………………1", size: 14, y: 700 },
        { text: "第一节 断网内容…………………………2", size: 14, y: 660 },
        { text: "第二节 断网要点…………………………3", size: 14, y: 620 },
        { text: "第三节 断网延伸…………………………4", size: 14, y: 580 },
      ],
    ];
    const outline = createBookOutlineModule(dataHome, {
      openDocument: documentSource(pages),
      aiOutline: deps,
    });
    closeOutline = outline.close;
    const result = await outline.rebuild(BOOK_ID, async () => ({ bytes: new Uint8Array() }));
    // 失败≠判无：不缓存、不降第三档、保留现状，本次以未完成收场。
    expect(result).toMatchObject({ status: "partial", nodes: [] });
    // 失败不落缓存：下一次重建会重新调用模型。
    await outline.rebuild(BOOK_ID, async () => ({ bytes: new Uint8Array() }));
    expect(calls).toBe(2);
  });

  it("does not cache an aborted ai run as a no-toc verdict", async () => {
    const ai = aiOutlineDeps([{ label: "第一章 中止", level: 1, printedPage: 1 }]);
    const pages: OutlineTextLine[][] = [
      [
        { text: "第一章 中止………………………………1", size: 14, y: 700 },
        { text: "第一节 中止内容…………………………2", size: 14, y: 660 },
        { text: "第二节 中止要点…………………………3", size: 14, y: 620 },
        { text: "第三节 中止延伸…………………………4", size: 14, y: 580 },
      ],
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
    // 证据闸门使每次重建先读一遍探测窗口（3 页），页候选循环再续扫未持久化的页。
    expect(visited).toEqual([1, 2, 3, 1, 1, 2, 3, 2, 3]);
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
    // 窗口闸门预读 [1,2]，过期载荷作废后候选循环全书重算 [1,2]。
    expect(visited).toEqual([1, 2, 1, 2]);
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
    // Fit 型 dest 无页内坐标，不造锚点（跳页顶）。
    expect(nodes?.every((node) => node.anchor === undefined && node.children.every((child) => child.anchor === undefined))).toBe(true);
  });

  it("preserves in-page anchors from XYZ bookmark destinations", async () => {
    const outline = createBookOutlineModule(dataHome);
    closeOutline = outline.close;
    const bytes = new Uint8Array(await readFile(ANCHOR_FIXTURE));
    const result = await outline.rebuild(BOOK_ID, async () => ({ bytes }));
    expect(result.status).toBe("embedded");
    // 同页多条目（Chapter One 与 1.1 同在 p.1）靠 XYZ top 区分落点，坐标原样保留交查看器换算。
    const nodes = outline.get(BOOK_ID) ?? [];
    expect(nodes[0]).toMatchObject({ label: "Chapter One", page: 1, anchor: { top: 500 } });
    expect(nodes[0]?.children[0]).toMatchObject({ label: "Section 1.1", page: 1, anchor: { top: 100 } });
    expect(nodes[1]).toMatchObject({ label: "Chapter Two", page: 2, anchor: { top: 400 } });
  });

  it("falls through to ai generation when the embedded outline is per-page junk", async () => {
    const junk = [1, 2, 3].map((page) => ({ id: `j-${page}`, label: `第${page}页`, page, children: [] }));
    const ai = aiOutlineDeps([{ label: "第一章 正文生成", level: 1, printedPage: 1 }]);
    const tocPage = [
      { text: "第一章 假目录………………………………1", size: 12, y: 700 },
      { text: "第一节 假目录内容…………………………2", size: 12, y: 660 },
      { text: "第二节 假目录要点…………………………3", size: 12, y: 620 },
      { text: "第三节 假目录延伸…………………………4", size: 12, y: 580 },
    ];
    const outline = createBookOutlineModule(dataHome, {
      openDocument: documentSource([tocPage, tocPage, tocPage], { embeddedNodes: junk }),
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
      [{ text: "普通正文第二页，长度足够参与统计。", size: 12, y: 650 }],
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
    // 页级失效只删该页候选，已落库目录保留（渐进改善不闪空）——管线已裁决第一档，快检不再开书。
    outline.invalidate(BOOK_ID, 1);
    expect(await outline.ensureEmbedded(BOOK_ID, loadBook)).toEqual([]);
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

  it("resolves the offset from dense printed-page votes when body anchors are few", () => {
    const tocRows: TocRow[] = [
      { label: "第一章 函数与极限", level: 1, printedPage: 1 },
      { label: "第一节 映射与函数", level: 2, printedPage: 2 },
    ];
    const headings: OutlineHeading[] = [
      { label: "第一章 函数与极限", page: 18, level: 1, explicit: true },
    ];
    // 每页一块的印刷页码（page_number 块 / 孤立数字行）：全书页脚与目录页码同源投票。
    const printedVotes = Array.from({ length: 10 }, (_, index) => ({ page: 18 + index, printed: 1 + index }));
    const result = assembleOutline(headings, tocRows, 150, printedVotes);
    expect(result.strategy).toBe("ai_toc");
    expect(result.nodes).toMatchObject([
      { label: "第一章 函数与极限", page: 18, children: [{ label: "第一节 映射与函数", page: 19 }] },
    ]);
  });

  it("absorbs chapter-restart printed-page peaks by majority voting", () => {
    const tocRows: TocRow[] = [
      { label: "第一章 函数", level: 1, printedPage: 1 },
      { label: "1.1 概念", level: 2, printedPage: 2 },
    ];
    const headings: OutlineHeading[] = [
      { label: "第一章 函数", page: 18, level: 1, explicit: true },
    ];
    // 主峰 offset=17（20 票密集页脚）；章节重启页码造出 offset=217 的次峰（4 票）——
    // 多数派 + 最少票数阈值吸收次峰，不误判整档偏移。
    const printedVotes = [
      ...Array.from({ length: 20 }, (_, index) => ({ page: 18 + index, printed: 1 + index })),
      ...Array.from({ length: 4 }, (_, index) => ({ page: 218 + index, printed: 1 + index })),
    ];
    const result = assembleOutline(headings, tocRows, 400, printedVotes);
    expect(result.strategy).toBe("ai_toc");
    expect(result.nodes).toMatchObject([
      { label: "第一章 函数", page: 18, children: [{ label: "1.1 概念", page: 19 }] },
    ]);
  });

  it("resolves the offset against anchors when toc-page footers vote a different sequence", () => {
    const tocRows: TocRow[] = [
      { label: "第一章 起点", level: 1, printedPage: 1 },
      { label: "第二章 收束", level: 1, printedPage: 30 },
    ];
    const headings: OutlineHeading[] = [
      { label: "第一章 起点", page: 10, level: 1, explicit: true },
    ];
    // 目录页 1~3 自带的页脚编号是独立序列（offset=0 ×3 票）；一个锚点 + 一张正文票
    // 共同指向 offset=9——锚点一致性择峰不听目录页脚的多数。
    const printedVotes = [
      { page: 1, printed: 1 },
      { page: 2, printed: 2 },
      { page: 3, printed: 3 },
      { page: 11, printed: 2 },
    ];
    const result = assembleOutline(headings, tocRows, 100, printedVotes, new Set([1, 2, 3]));
    expect(result.strategy).toBe("ai_toc");
    expect(result.nodes).toMatchObject([
      { label: "第一章 起点", page: 10 },
      { label: "第二章 收束", page: 39 },
    ]);
  });

  it("anchors part-restart chapters exactly while the global offset follows the anchor plurality", () => {
    // 多峰书（分部重启页码）：上半本 offset=10、下半本 offset=110。锚点多数簇定全局偏移，
    // 第四 章（下半本印刷页 5）靠自身锚点精确落位，不被偏移换算到上半本的 15。
    const tocRows: TocRow[] = [
      { label: "第一章", level: 1, printedPage: 5 },
      { label: "第二章", level: 1, printedPage: 25 },
      { label: "第三章", level: 1, printedPage: 45 },
      { label: "第四章", level: 1, printedPage: 5 },
    ];
    const headings: OutlineHeading[] = [
      { label: "第一章", page: 15, level: 1, explicit: true },
      { label: "第二章", page: 35, level: 1, explicit: true },
      { label: "第三章", page: 55, level: 1, explicit: true },
      { label: "第四章", page: 115, level: 1, explicit: true },
    ];
    const printedVotes = [
      ...Array.from({ length: 20 }, (_, index) => ({ page: 15 + index, printed: 5 + index })),
      ...Array.from({ length: 8 }, (_, index) => ({ page: 115 + index, printed: 5 + index })),
    ];
    const result = assembleOutline(headings, tocRows, 300, printedVotes);
    expect(result.strategy).toBe("ai_toc");
    expect(result.nodes).toMatchObject([
      { label: "第一章", page: 15 },
      { label: "第二章", page: 35 },
      { label: "第三章", page: 55 },
      { label: "第四章", page: 115 },
    ]);
  });

  it("falls back to toc-page footer votes only when anchors and body votes are absent", () => {
    const tocRows: TocRow[] = [{ label: "第一章", level: 1, printedPage: 4 }];
    const printedVotes = [
      { page: 1, printed: 1 },
      { page: 2, printed: 2 },
      { page: 3, printed: 3 },
    ];
    const result = assembleOutline([], tocRows, 50, printedVotes, new Set([1, 2, 3]));
    expect(result.strategy).toBe("ai_toc");
    expect(result.nodes).toMatchObject([{ label: "第一章", page: 4 }]);
  });

  it("lets dense body votes win over a single unconfirmed anchor", () => {
    const tocRows: TocRow[] = [
      { label: "第一章", level: 1, printedPage: 1 },
      { label: "第二章", level: 1, printedPage: 20 },
    ];
    // 孤立锚点（offset=8，无第二票佐证）不过阈值，不劫持正文页脚多数派（offset=10）。
    const headings: OutlineHeading[] = [
      { label: "第一章", page: 9, level: 1, explicit: true },
    ];
    const printedVotes = Array.from({ length: 5 }, (_, index) => ({ page: 11 + index, printed: 1 + index }));
    const result = assembleOutline(headings, tocRows, 100, printedVotes);
    expect(result.strategy).toBe("ai_toc");
    expect(result.nodes).toMatchObject([
      { label: "第一章", page: 9 },
      { label: "第二章", page: 30 },
    ]);
  });

  it("lets two agreeing anchors override a denser body cluster", () => {
    const tocRows: TocRow[] = [
      { label: "第一章", level: 1, printedPage: 1 },
      { label: "第二章", level: 1, printedPage: 20 },
      { label: "第三章", level: 1, printedPage: 40 },
    ];
    // 两个锚点同证 offset=8；更密的正文簇（offset=10 ×5）是另一序列——冲突听锚点。
    const headings: OutlineHeading[] = [
      { label: "第一章", page: 9, level: 1, explicit: true },
      { label: "第二章", page: 28, level: 1, explicit: true },
    ];
    const printedVotes = Array.from({ length: 5 }, (_, index) => ({ page: 11 + index, printed: 1 + index }));
    const result = assembleOutline(headings, tocRows, 100, printedVotes);
    expect(result.strategy).toBe("ai_toc");
    expect(result.nodes).toMatchObject([
      { label: "第一章", page: 9 },
      { label: "第二章", page: 28 },
      { label: "第三章", page: 48 },
    ]);
  });

  it("clamps out-of-order pages along reading order", () => {
    const nodes: BookOutlineNode[] = [
      {
        id: "1", label: "第一章", page: 50, children: [
          { id: "2", label: "第一节", page: 30, children: [] },
          { id: "3", label: "第二节", page: 60, children: [] },
        ],
      },
    ];
    expect(repairOutlineMonotonicity(nodes)).toEqual([
      {
        id: "1", label: "第一章", page: 50, children: [
          { id: "2", label: "第一节", page: 50, children: [] },
          { id: "3", label: "第二节", page: 60, children: [] },
        ],
      },
    ]);
  });

  it("keeps already-monotonic page sequences untouched", () => {
    const nodes: BookOutlineNode[] = [
      {
        id: "1", label: "第一章", page: 10, children: [
          { id: "2", label: "1.1 小节", page: 10, children: [] },
          { id: "3", label: "1.2 小节", page: 15, children: [] },
        ],
      },
      { id: "4", label: "第二章", page: 20, children: [] },
    ];
    expect(repairOutlineMonotonicity(nodes)).toEqual(nodes);
  });

  it("admits only ordinal or known-name paragraph titles as recognized headings", () => {
    const blocks = [
      { type: "paragraph_title", text: "1.2 计算机的硬件组成", bbox: [0.1, 0.1, 0.9, 0.16] },
      { type: "paragraph_title", text: "1.2.1 计算机的主要部件", bbox: [0.1, 0.2, 0.9, 0.26] },
      { type: "paragraph_title", text: "1. 输入设备", bbox: [0.1, 0.3, 0.9, 0.36] },
      { type: "paragraph_title", text: "（1）字编址", bbox: [0.1, 0.4, 0.9, 0.46] },
      { type: "paragraph_title", text: "指令系统", bbox: [0.1, 0.5, 0.9, 0.56] },
      { type: "paragraph_title", text: "参考文献", bbox: [0.1, 0.6, 0.9, 0.66] },
      { type: "header", text: "第一章 页眉", bbox: [0.1, 0.01, 0.9, 0.05] },
      { type: "text", text: "第一章 伪装标题", bbox: [0.1, 0.7, 0.9, 0.76] },
    ];
    expect(detectRecognizedHeadings(7, blocks)).toEqual([
      { label: "1.2 计算机的硬件组成", page: 7, level: 2, explicit: true },
      { label: "1.2.1 计算机的主要部件", page: 7, level: 3, explicit: true },
      { label: "参考文献", page: 7, level: 1, explicit: true },
    ]);
  });

  it("builds a body-heading tree with a strictly increasing chapter spine", () => {
    const headings: OutlineHeading[] = [
      { label: "第一章 起点", page: 10, level: 1, explicit: true },
      { label: "1.1 内容", page: 12, level: 2, explicit: true },
      { label: "1.1.1 背景", page: 13, level: 3, explicit: true },
      { label: "第二章 转折", page: 20, level: 1, explicit: true },
      { label: "第三章 收束", page: 30, level: 1, explicit: true },
      { label: "参考文献", page: 40, level: 1, explicit: true },
    ];
    const result = assembleBodyHeadingOutline(headings);
    expect(result.strategy).toBe("body_headings");
    expect(result.nodes).toMatchObject([
      {
        label: "第一章 起点", page: 10,
        children: [{ label: "1.1 内容", page: 12, children: [{ label: "1.1.1 背景", page: 13 }] }],
      },
      { label: "第二章 转折", page: 20 },
      { label: "第三章 收束", page: 30 },
      { label: "参考文献", page: 40 },
    ]);
  });

  it("rejects body-heading trees without enough ordinal chapters or with a broken spine", () => {
    // 序数章不足：特名凑数不算脊柱。
    expect(assembleBodyHeadingOutline([
      { label: "第一章 起点", page: 10, level: 1, explicit: true },
      { label: "1.1 内容", page: 12, level: 2, explicit: true },
      { label: "参考文献", page: 40, level: 1, explicit: true },
    ]).strategy).toBe("empty");
    // 章序数倒挂（页眉噪声幸存者的签名）。
    expect(assembleBodyHeadingOutline([
      { label: "第二章 转折", page: 10, level: 1, explicit: true },
      { label: "第一章 起点", page: 20, level: 1, explicit: true },
      { label: "第三章 收束", page: 30, level: 1, explicit: true },
    ]).strategy).toBe("empty");
  });

  it("keeps the first occurrence of a special-name chapter that doubles as a running header", () => {
    // 「参考文献」兼作章内页眉（≥3 页重复）：真身先于页眉出现，保留首现页而非整删。
    const headings: OutlineHeading[] = [
      { label: "第一章 起点", page: 10, level: 1, explicit: true },
      { label: "第二章 转折", page: 20, level: 1, explicit: true },
      { label: "第三章 收束", page: 30, level: 1, explicit: true },
      ...[31, 32, 33].map((page) => ({ label: "参考文献", page, level: 1 as const, explicit: true })),
    ];
    const result = assembleBodyHeadingOutline(headings);
    expect(result.strategy).toBe("body_headings");
    expect(result.nodes.at(-1)).toMatchObject({ label: "参考文献", page: 31 });
  });

  it("anchors a special-name toc row to the first body occurrence when it repeats as a header", () => {
    const tocRows: TocRow[] = [
      { label: "第一章 起点", level: 1, printedPage: 1 },
      { label: "参考文献", level: 1, printedPage: 30 },
    ];
    const headings: OutlineHeading[] = [
      { label: "第一章 起点", page: 5, level: 1, explicit: true },
      ...[40, 41, 42].map((page) => ({ label: "参考文献", page, level: 1 as const, explicit: true })),
    ];
    // 页脚密集票定出 offset=4；「参考文献」行靠首现正文锚点落 p.40，而非偏移换算的 p.34。
    const printedVotes = [
      { page: 5, printed: 1 },
      { page: 6, printed: 2 },
      { page: 7, printed: 3 },
    ];
    const result = assembleOutline(headings, tocRows, 100, printedVotes);
    expect(result.strategy).toBe("ai_toc");
    expect(result.nodes).toMatchObject([
      { label: "第一章 起点", page: 5 },
      { label: "参考文献", page: 40 },
    ]);
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
    expect(result.strategy).toBe("ai_toc");
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
    expect(result.strategy).toBe("ai_toc");
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
    expect(result.strategy).toBe("ai_toc");
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
      [
        { text: "目录", size: 18, y: 740 },
        { text: "第一章 清理……………………………………1", size: 12, y: 700 },
        { text: "1.1 小节………………………………………2", size: 12, y: 660 },
        { text: "1.2 备查………………………………………4", size: 12, y: 620 },
        { text: "第二章 归档…………………………………6", size: 12, y: 580 },
      ],
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

  it("keeps the stored outline when a page-level invalidation arrives during background ocr", async () => {
    // 早出的目录在后续页识别到达时不闪空：页级失效只清该页候选，
    // 已落库目录保留到整书收尾的重建整体替换（spec 故事 8/11 的「继续改善」语义）。
    const notified: string[] = [];
    const tocPage = [
      { text: "目录", size: 18, y: 740 },
      { text: "第一章 早目录………………………………1", size: 12, y: 700 },
      { text: "1.1 早小节……………………………………2", size: 12, y: 660 },
      { text: "第二章 后章…………………………………9", size: 12, y: 620 },
      { text: "附录 参考答案………………………………12", size: 12, y: 580 },
    ];
    const pages: OutlineTextLine[][] = [
      tocPage,
      [
        { text: "第一章 早目录", size: 24, y: 700 },
        { text: "普通正文内容，长度足够参与统计。", size: 12, y: 650 },
        { text: "1", size: 12, y: 60 },
      ],
      ...Array.from({ length: 10 }, (_, index) => [
        { text: `第${index + 3}页正文，内容长度足够参与统计。`, size: 12, y: 650 },
        { text: String(index + 2), size: 12, y: 60 },
      ]),
    ];
    const ai = aiOutlineDeps([{ label: "第一章 早目录", level: 1, printedPage: 1 }], [1]);
    const outline = createBookOutlineModule(dataHome, {
      openDocument: documentSource(pages),
      aiOutline: ai.deps,
      onOutlineChange: (bookId) => notified.push(bookId),
    });
    closeOutline = outline.close;
    await outline.rebuild(BOOK_ID, async () => ({ bytes: new Uint8Array() }));
    expect(outline.strategy(BOOK_ID)).toBe("ai_toc");
    const before = outline.get(BOOK_ID);
    expect(before).toMatchObject([{ label: "第一章 早目录", page: 2 }]);

    outline.invalidate(BOOK_ID, 2);
    expect(outline.get(BOOK_ID)).toEqual(before);
    expect(outline.strategy(BOOK_ID)).toBe("ai_toc");
    // 目录未变不推送；只有该页候选被清，其余页候选保留。
    expect(notified).toEqual([BOOK_ID]);
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(path.join(dataHome, "pdfmuse.db"));
    const rows = database.prepare("SELECT page FROM book_outline_pages WHERE book_id = ? ORDER BY page").all(BOOK_ID) as Array<{ page: number }>;
    database.close();
    expect(rows.map((row) => row.page)).toEqual([1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

    // 整表失效才连已落库目录一起清。
    outline.invalidate(BOOK_ID);
    expect(outline.get(BOOK_ID)).toBeUndefined();
    expect(notified).toEqual([BOOK_ID, BOOK_ID]);
  });

  it("keeps the tier verdict open when the ai call fails even if body headings would pass the gate", async () => {
    closeOcr?.();
    const engine: MineruEngine = {
      name: "测试 OCR",
      model: "测试模型",
      async recognizePage(input) {
        if (input.page === 1) {
          return {
            blocks: [{ type: "index", text: "第一章 失败目录…………………………1\n第一节 失败内容…………………………2", bbox: [0.1, 0.1, 0.9, 0.5] }],
            markdown: "",
          };
        }
        const titles: Record<number, string> = { 2: "第一章 起点", 3: "第二章 转折", 4: "第三章 收束" };
        const blocks = [{ type: "text", text: `第${input.page}页正文，长度足够参与统计。`, bbox: [0.1, 0.2, 0.9, 0.24] }];
        if (titles[input.page]) blocks.unshift({ type: "paragraph_title", text: titles[input.page]!, bbox: [0.1, 0.05, 0.9, 0.12] });
        return { blocks, markdown: "" };
      },
    };
    const ocr = createOcrModule(dataHome, engine, {
      resolvePdfPath: (bookId) => (bookId === BOOK_ID ? { path: "C:/book.pdf", encrypted: false } : undefined),
    });
    closeOcr = ocr.close;
    for (const page of [1, 2, 3, 4]) {
      await ocr.recognizePage({ bookId: BOOK_ID, page });
    }
    const outline = createBookOutlineModule(dataHome, {
      openDocument: documentSource([[], [], [], []]),
      aiOutline: {
        renderPage: async () => ({ imageData: "aW1n" }),
        complete: async () => { throw new Error("网络错误"); },
      },
      readRecognizedBlocks: (bookId, page) => ocr.getPage(bookId, page)?.blocks,
    });
    closeOutline = outline.close;
    const result = await outline.rebuild(BOOK_ID, async () => ({ bytes: new Uint8Array() }));
    // 失败≠判无：定位命中但模型调不起来——不缓存、不降第三档，保留现状等重试。
    expect(result).toMatchObject({ status: "partial", nodes: [] });
    expect(outline.get(BOOK_ID)).toBeUndefined();
    expect(outline.strategy(BOOK_ID)).toBe("empty");
  });

  it("nests three toc levels from ai entries", () => {
    const tocRows: TocRow[] = [
      { label: "第1章 绪论", level: 1, printedPage: 1 },
      { label: "1.1 概述", level: 2, printedPage: 2 },
      { label: "1.1.1 背景", level: 3, printedPage: 3 },
      { label: "1.2 目标", level: 2, printedPage: 4 },
    ];
    const headings: OutlineHeading[] = [
      { label: "第1章 绪论", page: 11, level: 1, explicit: true },
      { label: "1.1 概述", page: 12, level: 2, explicit: true },
      { label: "1.1.1 背景", page: 13, level: 2, explicit: true },
      { label: "1.2 目标", page: 14, level: 2, explicit: true },
    ];
    const result = assembleOutline(headings, tocRows, 100);
    expect(result.strategy).toBe("ai_toc");
    expect(result.nodes).toMatchObject([
      {
        label: "第1章 绪论", page: 11,
        children: [
          { label: "1.1 概述", page: 12, children: [{ label: "1.1.1 背景", page: 13 }] },
          { label: "1.2 目标", page: 14 },
        ],
      },
    ]);
  });

  it("skips the ai call entirely when no toc signal is found", async () => {
    closeOcr?.();
    const engine: MineruEngine = {
      name: "测试 OCR",
      model: "测试模型",
      async recognizePage(input) {
        return {
          blocks: [{ type: "text", text: `第${input.page}页正文，内容长度足够参与统计。`, bbox: [0.1, 0.1, 0.9, 0.16] }],
          markdown: "",
        };
      },
    };
    const ocr = createOcrModule(dataHome, engine, {
      resolvePdfPath: (bookId) => (bookId === BOOK_ID ? { path: "C:/book.pdf", encrypted: false } : undefined),
    });
    closeOcr = ocr.close;
    for (const page of [1, 2, 3, 4]) {
      await ocr.recognizePage({ bookId: BOOK_ID, page });
    }
    let calls = 0;
    const outline = createBookOutlineModule(dataHome, {
      openDocument: documentSource([[], [], [], []]),
      aiOutline: {
        renderPage: async () => ({ imageData: "aW1n" }),
        complete: async () => {
          calls += 1;
          return '{"hasToc":false,"entries":[],"continuesAt":null}';
        },
      },
      readRecognizedBlocks: (bookId, page) => ocr.getPage(bookId, page)?.blocks,
    });
    closeOutline = outline.close;
    const result = await outline.rebuild(BOOK_ID, async () => ({ bytes: new Uint8Array() }));
    expect(result).toMatchObject({ status: "generated", nodes: [] });
    expect(calls).toBe(0);
  });

  it("waits for probe window coverage before calling the ai", async () => {
    closeOcr?.();
    const engine: MineruEngine = {
      name: "测试 OCR",
      model: "测试模型",
      async recognizePage(input) {
        if (input.page === 2) {
          return {
            blocks: [{ type: "index", text: "第一章 扫描目录…………………………1\n第一节 扫描内容…………………………2", bbox: [0.1, 0.1, 0.9, 0.5] }],
            markdown: "目录",
          };
        }
        return {
          blocks: [{ type: "text", text: `第${input.page}页正文，内容长度足够参与统计。`, bbox: [0.1, 0.1, 0.9, 0.16] }],
          markdown: "",
        };
      },
    };
    const ocr = createOcrModule(dataHome, engine, {
      resolvePdfPath: (bookId) => (bookId === BOOK_ID ? { path: "C:/book.pdf", encrypted: false } : undefined),
    });
    closeOcr = ocr.close;
    let calls = 0;
    const outline = createBookOutlineModule(dataHome, {
      openDocument: documentSource([[], [], [], [], []]),
      aiOutline: {
        renderPage: async () => ({ imageData: "aW1n" }),
        complete: async () => {
          calls += 1;
          return '{"hasToc":false,"entries":[],"continuesAt":null}';
        },
      },
      readRecognizedBlocks: (bookId, page) => ocr.getPage(bookId, page)?.blocks,
    });
    closeOutline = outline.close;
    // 仅 p.2 已识别（含 index 块）：窗口未覆盖——不下结论、不调模型、不写任何持久化状态。
    await ocr.recognizePage({ bookId: BOOK_ID, page: 2 });
    const early = await outline.rebuild(BOOK_ID, async () => ({ bytes: new Uint8Array() }));
    expect(early).toMatchObject({ status: "partial", processedPages: 0 });
    expect(calls).toBe(0);
    expect(outline.get(BOOK_ID)).toBeUndefined();
    // 窗口覆盖齐全后：定位命中 → 调用一次模型并缓存结论。
    for (const page of [1, 3, 4, 5]) {
      await ocr.recognizePage({ bookId: BOOK_ID, page });
    }
    await outline.rebuild(BOOK_ID, async () => ({ bytes: new Uint8Array() }));
    expect(calls).toBe(1);
    await outline.rebuild(BOOK_ID, async () => ({ bytes: new Uint8Array() }));
    expect(calls).toBe(1);
  });

  it("holds the conclusion until the window is covered even when the toc region ended early", async () => {
    closeOcr?.();
    // 扫描书 10 页：目录区在第 2 页（index 块），OCR 只推进到第 6 页——目录区虽已结束，
    // 但窗口未覆盖（证据闸门），不出结论不调模型；扫满窗口后才提取。
    const engine: MineruEngine = {
      name: "测试 OCR",
      model: "测试模型",
      async recognizePage(input) {
        if (input.page === 2) {
          return {
            blocks: [{ type: "index", text: "第一章 测试目录…………………………1\n第一节 测试内容…………………………2", bbox: [0.1, 0.1, 0.9, 0.5] }],
            markdown: "目录",
          };
        }
        return {
          blocks: [{ type: "text", text: `第${input.page}页正文，内容长度足够参与统计。`, bbox: [0.1, 0.1, 0.9, 0.16] }],
          markdown: "",
        };
      },
    };
    const ocr = createOcrModule(dataHome, engine, {
      resolvePdfPath: (bookId) => (bookId === BOOK_ID ? { path: "C:/book.pdf", encrypted: false } : undefined),
    });
    closeOcr = ocr.close;
    for (const page of [1, 2, 3, 4, 5, 6]) {
      await ocr.recognizePage({ bookId: BOOK_ID, page });
    }
    const requested: number[][] = [];
    const outline = createBookOutlineModule(dataHome, {
      openDocument: documentSource(Array.from({ length: 10 }, () => [])),
      aiOutline: {
        renderPage: async () => ({ imageData: "aW1n" }),
        complete: async (input) => {
          requested.push(input.pages);
          return '{"hasToc":false,"entries":[],"continuesAt":null}';
        },
      },
      readRecognizedBlocks: (bookId, page) => ocr.getPage(bookId, page)?.blocks,
    });
    closeOutline = outline.close;
    const early = await outline.rebuild(BOOK_ID, async () => ({ bytes: new Uint8Array() }));
    expect(early).toMatchObject({ status: "partial", processedPages: 0 });
    expect(requested).toEqual([]);
    expect(outline.get(BOOK_ID)).toBeUndefined();
    // 窗口（全书 10 页 ≤ 30）扫满：定位命中 → 提取，候选页 = 命中页 ±1 边距。
    for (const page of [7, 8, 9, 10]) {
      await ocr.recognizePage({ bookId: BOOK_ID, page });
    }
    const result = await outline.rebuild(BOOK_ID, async () => ({ bytes: new Uint8Array() }));
    expect(result.status).toBe("generated");
    expect(requested).toEqual([[1, 2, 3]]);
  });

  it("writes nothing and marks tier one adjudicated when the probe window is uncovered", async () => {
    // 扫描书开书（零识别、无原生文本）：目录任务空转退出——不写页候选、不落库、零 AI 调用，
    // 只落「第一档已裁决」标记，开书快检不再重复开书解析书签。
    const notified: string[] = [];
    let opened = 0;
    const outline = createBookOutlineModule(dataHome, {
      openDocument: documentSource(Array.from({ length: 40 }, () => []), { onOpen: () => { opened += 1; } }),
      aiOutline: {
        renderPage: async () => ({ imageData: "aW1n" }),
        complete: async () => { throw new Error("不应调用模型。"); },
      },
      onOutlineChange: (bookId) => notified.push(bookId),
    });
    closeOutline = outline.close;
    const result = await outline.rebuild(BOOK_ID, async () => ({ bytes: new Uint8Array() }));
    expect(result).toMatchObject({ status: "partial", processedPages: 0 });
    expect(outline.get(BOOK_ID)).toBeUndefined();
    expect(notified).toEqual([]);
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(path.join(dataHome, "pdfmuse.db"));
    const candidateRows = database.prepare("SELECT COUNT(*) AS count FROM book_outline_pages WHERE book_id = ?").get(BOOK_ID) as { count: number };
    const gateRows = database.prepare("SELECT COUNT(*) AS count FROM book_outline_gate WHERE book_id = ?").get(BOOK_ID) as { count: number };
    database.close();
    expect(candidateRows.count).toBe(0);
    expect(gateRows.count).toBe(1);
    // 标记在库：快检不再开书（rebuild 已开过一次）。
    expect(await outline.ensureEmbedded(BOOK_ID, async () => ({ bytes: new Uint8Array() }))).toBeUndefined();
    expect(opened).toBe(1);
  });

  it("marks tier one adjudicated on the read path so the quick check stops reopening", async () => {
    let opened = 0;
    const outline = createBookOutlineModule(dataHome, {
      openDocument: documentSource([[{ text: "第一章 无书签", size: 24, y: 700 }]], { onOpen: () => { opened += 1; } }),
    });
    closeOutline = outline.close;
    const loadBook = async () => ({ bytes: new Uint8Array() });
    expect(await outline.ensureEmbedded(BOOK_ID, loadBook)).toBeUndefined();
    expect(await outline.ensureEmbedded(BOOK_ID, loadBook)).toBeUndefined();
    expect(opened).toBe(1);
  });

  it("treats a majority-native window with blank divider pages as covered", async () => {
    // 原生书含空白分页页（章节扉页无文字层）：窗口过半页有原生文本即整窗可判，
    // 不被一页空白卡死（spec 故事 18——没装 OCR 资源时原生书照常产出结论）。
    const bodyPage = [
      { text: "第一章 起点", size: 24, y: 700 },
      { text: "普通正文内容，长度足够参与统计。", size: 12, y: 650 },
    ];
    const pages: OutlineTextLine[][] = Array.from({ length: 10 }, (_, index) => (
      index === 3 || index === 7 || index === 9 ? [] : bodyPage
    ));
    const outline = createBookOutlineModule(dataHome, { openDocument: documentSource(pages) });
    closeOutline = outline.close;
    const result = await outline.rebuild(BOOK_ID, async () => ({ bytes: new Uint8Array() }));
    expect(result).toMatchObject({ status: "generated", processedPages: 10 });
    expect(outline.get(BOOK_ID)).toEqual([]);
  });

  it("feeds page_number blocks into the offset vote for scanned books", async () => {
    closeOcr?.();
    const engine: MineruEngine = {
      name: "测试 OCR",
      model: "测试模型",
      async recognizePage(input) {
        if (input.page === 2) {
          return {
            blocks: [{ type: "index", text: "第一章 测试目录…………………………1\n第一节 测试内容…………………………2", bbox: [0.1, 0.1, 0.9, 0.5] }],
            markdown: "目录",
          };
        }
        if (input.page === 4) {
          return {
            blocks: [
              { type: "title", text: "第一章 测试目录", bbox: [0.1, 0.05, 0.9, 0.12] },
              { type: "page_number", text: "1", bbox: [0.4, 0.95, 0.6, 0.98] },
              { type: "text", text: "正文内容，长度足够参与统计。", bbox: [0.1, 0.2, 0.9, 0.24] },
            ],
            markdown: "",
          };
        }
        if (input.page === 5 || input.page === 6) {
          return {
            blocks: [
              { type: "text", text: `第${input.page}页正文，内容长度足够参与统计。`, bbox: [0.1, 0.1, 0.9, 0.16] },
              { type: "page_number", text: String(input.page - 3), bbox: [0.4, 0.95, 0.6, 0.98] },
            ],
            markdown: "",
          };
        }
        return {
          blocks: [{ type: "text", text: `第${input.page}页正文，内容长度足够参与统计。`, bbox: [0.1, 0.1, 0.9, 0.16] }],
          markdown: "",
        };
      },
    };
    const ocr = createOcrModule(dataHome, engine, {
      resolvePdfPath: (bookId) => (bookId === BOOK_ID ? { path: "C:/book.pdf", encrypted: false } : undefined),
    });
    closeOcr = ocr.close;
    for (const page of [1, 2, 3, 4, 5, 6]) {
      await ocr.recognizePage({ bookId: BOOK_ID, page });
    }
    const ai = aiOutlineDeps([
      { label: "第一章 测试目录", level: 1, printedPage: 1 },
      { label: "第一节 测试内容", level: 2, printedPage: 2 },
    ], [2]);
    const outline = createBookOutlineModule(dataHome, {
      openDocument: documentSource([[], [], [], [], [], []]),
      aiOutline: ai.deps,
      readRecognizedBlocks: (bookId, page) => ocr.getPage(bookId, page)?.blocks,
    });
    closeOutline = outline.close;
    const result = await outline.rebuild(BOOK_ID, async () => ({ bytes: new Uint8Array() }));
    expect(result.status).toBe("generated");
    // 唯一正文锚点（第一章@4，票 4-1=3）不足以过最少票数阈值；page_number 块
    // （4-1=3、5-2=3、6-3=3）把它抬成多数派，第二节由偏移落到 p.5。
    expect(outline.get(BOOK_ID)).toMatchObject([
      { label: "第一章 测试目录", page: 4, children: [{ label: "第一节 测试内容", page: 5 }] },
    ]);
  });

  it("falls back to a body-heading tree when no toc signal exists", async () => {
    closeOcr?.();
    const engine: MineruEngine = {
      name: "测试 OCR",
      model: "测试模型",
      async recognizePage(input) {
        const titles: Record<number, string> = { 2: "第一章 起点", 3: "1.1 内容", 4: "第二章 转折", 5: "第三章 收束" };
        const title = titles[input.page];
        const blocks = [{ type: "text", text: `第${input.page}页正文，内容长度足够参与统计。`, bbox: [0.1, 0.2, 0.9, 0.24] }];
        if (title) blocks.unshift({ type: "paragraph_title", text: title, bbox: [0.1, 0.05, 0.9, 0.12] });
        return { blocks, markdown: "" };
      },
    };
    const ocr = createOcrModule(dataHome, engine, {
      resolvePdfPath: (bookId) => (bookId === BOOK_ID ? { path: "C:/book.pdf", encrypted: false } : undefined),
    });
    closeOcr = ocr.close;
    for (const page of [1, 2, 3, 4, 5]) {
      await ocr.recognizePage({ bookId: BOOK_ID, page });
    }
    let aiCalls = 0;
    const outline = createBookOutlineModule(dataHome, {
      openDocument: documentSource([[], [], [], [], []]),
      aiOutline: {
        renderPage: async () => ({ imageData: "aW1n" }),
        complete: async () => {
          aiCalls += 1;
          return '{"hasToc":false,"entries":[],"continuesAt":null}';
        },
      },
      readRecognizedBlocks: (bookId, page) => ocr.getPage(bookId, page)?.blocks,
    });
    closeOutline = outline.close;
    const result = await outline.rebuild(BOOK_ID, async () => ({ bytes: new Uint8Array() }));
    // 无目录信号 → 零 AI 调用；正文标题树兜底（页码即标题所在页）。
    expect(aiCalls).toBe(0);
    expect(result.status).toBe("generated");
    expect(outline.strategy(BOOK_ID)).toBe("body_headings");
    expect(outline.get(BOOK_ID)).toMatchObject([
      { label: "第一章 起点", page: 2, children: [{ label: "1.1 内容", page: 3 }] },
      { label: "第二章 转折", page: 4 },
      { label: "第三章 收束", page: 5 },
    ]);
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

describe("toc page locator", () => {
  const tocLines = [
    "第一章 函数与极限……………………………………1",
    "第一节 映射与函数……………………………………2",
    "第二节 数列的极限……………………………………18",
    "第二章 导数与微分……………………………………60",
  ];
  const bodyLines = [
    "这是正文的第一行，讲述一个完整的概念。",
    "第二行继续说明相关内容，没有行尾数字。",
    "Third line of ordinary body text here.",
    "第四行内容较短，同样以句号结尾。",
    "第五行还是普通的正文段落内容。",
  ];

  it("locates pages by index blocks and expands a ±1 margin", () => {
    const inputs = [
      { page: 1, lines: bodyLines, hasIndexBlock: false, covered: true },
      { page: 2, lines: tocLines, hasIndexBlock: true, covered: true },
      { page: 3, lines: bodyLines, hasIndexBlock: false, covered: true },
      { page: 4, lines: bodyLines, hasIndexBlock: false, covered: true },
      { page: 5, lines: tocLines, hasIndexBlock: false, covered: true },
    ];
    // 密度只在 index 无命中时兜底：index 命中后别处的密集页（参考文献式）不并选。
    expect(locateTocPages(inputs)).toEqual({ hits: [2], pages: [1, 2, 3], covered: true });
  });

  it("locates pages by dot-leader density and by trailing-number density", () => {
    const inputs = [
      { page: 1, lines: tocLines, hasIndexBlock: false, covered: true },
      { page: 2, lines: [
        "Smith J 2023",
        "Lee K 2021",
        "王五 2019",
        "赵六 2020",
        "钱七 2022",
      ], hasIndexBlock: false, covered: true },
      { page: 3, lines: bodyLines, hasIndexBlock: false, covered: true },
    ];
    expect(locateTocPages(inputs)).toEqual({ hits: [1, 2], pages: [1, 2, 3], covered: true });
  });

  it("does not locate ordinary body pages", () => {
    const inputs = [1, 2, 3, 4].map((page) => ({ page, lines: bodyLines, hasIndexBlock: false, covered: true }));
    expect(locateTocPages(inputs)).toEqual({ hits: [], pages: [], covered: true });
  });

  it("reports incomplete coverage when window pages lack both text sources", () => {
    const inputs = [
      { page: 1, lines: tocLines, hasIndexBlock: false, covered: true },
      { page: 2, lines: [], hasIndexBlock: false, covered: false },
      { page: 3, lines: [], hasIndexBlock: false, covered: false },
    ];
    const result = locateTocPages(inputs);
    expect(result.covered).toBe(false);
    expect(result.hits).toEqual([1]);
    expect(result.pages).toEqual([1, 2]);
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
