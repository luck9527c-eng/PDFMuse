import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assembleOutline,
  createBookOutlineModule,
  detectHeadingCandidates,
  findOutlineSectionPath,
  type BookOutlineAiDeps,
  type OpenOutlineDocument,
  type OutlineHeading,
  type OutlineTextLine,
  type TocRow,
} from "./book-outline.js";
import type { BookOutlineNode } from "../shared/contracts.js";
import { createOcrModule, type OcrEngine } from "./ocr.js";

const BOOK_ID = "a".repeat(64);
const NAVIGATION_FIXTURE = path.resolve(import.meta.dirname, "fixtures/navigation.pdf");
const NO_OUTLINE_FIXTURE = path.resolve(import.meta.dirname, "fixtures/three-page.pdf");

function documentSource(
  pages: OutlineTextLine[][],
  options: { embedded?: boolean; visited?: number[] } = {},
): OpenOutlineDocument {
  return async () => ({
    pageCount: pages.length,
    hasValidEmbeddedOutline: options.embedded ?? false,
    async getNativeLines(page) {
      options.visited?.push(page);
      return pages[page - 1] ?? [];
    },
    async close() { return undefined; },
  });
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

  it("keeps a valid embedded outline authoritative", async () => {
    const outline = createBookOutlineModule(dataHome, {
      openDocument: documentSource([[{ text: "Generated Heading", size: 24, y: 700 }]], { embedded: true }),
    });
    closeOutline = outline.close;
    const result = await outline.rebuild(BOOK_ID, async () => ({ bytes: new Uint8Array() }));
    expect(result).toMatchObject({ status: "embedded", nodes: [] });
    expect(outline.get(BOOK_ID)).toBeUndefined();
  });

  it("assembles the outline from ai entries and body anchors", async () => {
    closeOcr?.();
    // p.1 是印刷目录页（同名列出章节），p.2/p.3 是正文真标题页。
    const engine: OcrEngine = {
      name: "测试 OCR",
      model: "测试模型",
      async recognize(input) {
        const heading = input.page === 1 ? "第一章 扫描内容" : input.page === 2 ? "第一章 扫描内容" : "1.1 识别小节";
        return {
          width: input.width,
          height: input.height,
          orientation: 0,
          lines: [
            { text: heading, confidence: 0.98, polygon: [{ x: 10, y: 10 }, { x: 300, y: 10 }, { x: 300, y: 50 }, { x: 10, y: 50 }] },
            { text: "这是扫描页正文。", confidence: 0.96, polygon: [{ x: 10, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 118 }, { x: 10, y: 118 }] },
          ],
        };
      },
    };
    const ocr = createOcrModule(dataHome, engine);
    closeOcr = ocr.close;
    for (const page of [1, 2, 3]) {
      await ocr.recognizePage({ bookId: BOOK_ID, page, imageData: "a", width: 600, height: 800 });
    }
    const ai = aiOutlineDeps([
      { label: "第一章 扫描内容", level: 1, printedPage: 1 },
      { label: "1.1 识别小节", level: 2, printedPage: 2 },
    ], [1]);
    const outline = createBookOutlineModule(dataHome, {
      openDocument: documentSource([[], [], []]),
      aiOutline: ai.deps,
      readRecognizedLines: (bookId, page) => ocr.getPage(bookId, page)?.lines,
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

  it("recognizes the real fixture embedded outline without persisting a replacement", async () => {
    const outline = createBookOutlineModule(dataHome);
    closeOutline = outline.close;
    const bytes = new Uint8Array(await readFile(NAVIGATION_FIXTURE));
    const result = await outline.rebuild(BOOK_ID, async () => ({ bytes }));
    expect(result.status).toBe("embedded");
    expect(outline.get(BOOK_ID)).toBeUndefined();
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
});
