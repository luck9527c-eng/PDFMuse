import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assembleOutline,
  buildOutlineTree,
  createBookOutlineModule,
  detectHeadingCandidates,
  findOutlineSectionPath,
  harvestTocRows,
  type OpenOutlineDocument,
  type OutlineTextLine,
  type OutlineHeading,
  type TocRow,
} from "./book-outline.js";
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

  it("detects explicit and typographic headings and builds hierarchy", () => {
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
    expect(buildOutlineTree([...first, ...second], 2)).toMatchObject([
      { label: "第一章 基础", page: 1, children: [{ label: "1.1 核心概念", page: 2 }] },
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

  it("uses recognized text when a scanned page has no native text", async () => {
    closeOcr?.();
    const engine: OcrEngine = {
      name: "测试 OCR",
      model: "测试模型",
      async recognize(input) {
        const heading = input.page === 1 ? "第一章 扫描内容" : "1.1 识别小节";
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
    for (const page of [1, 2]) {
      await ocr.recognizePage({ bookId: BOOK_ID, page, imageData: "a", width: 600, height: 800 });
    }
    const outline = createBookOutlineModule(dataHome, { openDocument: documentSource([[], []]) });
    closeOutline = outline.close;
    const result = await outline.rebuild(BOOK_ID, async () => ({ bytes: new Uint8Array() }));
    expect(result.status).toBe("generated");
    expect(outline.get(BOOK_ID)).toMatchObject([
      { label: "第一章 扫描内容", page: 1, children: [{ label: "1.1 识别小节", page: 2 }] },
    ]);
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
  it("finds the deepest section path for a reading page", () => {
    const nodes = buildOutlineTree([
      { label: "第5章 存储系统", page: 120, level: 1, explicit: true },
      { label: "5.2 主存储器", page: 140, level: 2, explicit: true },
      { label: "5.2.3 技术指标", page: 146, level: 3, explicit: true },
      { label: "第6章 中央处理器", page: 200, level: 1, explicit: true },
    ], 220);
    expect(findOutlineSectionPath(nodes, 147)).toBe("第5章 存储系统 › 5.2 主存储器 › 5.2.3 技术指标");
    expect(findOutlineSectionPath(nodes, 143)).toBe("第5章 存储系统 › 5.2 主存储器");
    expect(findOutlineSectionPath(nodes, 210)).toBe("第6章 中央处理器");
    expect(findOutlineSectionPath([], 100)).toBeUndefined();
  });

  it("harvests printed toc rows by merging same-row fragments", () => {
    // 数据取自高等数学第 12 页的真实 OCR 输出（y 为距页顶距离，size 为行框高度）。
    const { tocPage, rows } = harvestTocRows([
      { text: "目录", size: 37, y: 101 },
      { text: "第一章 函数与极限", size: 21, y: 232 },
      { text: "第一节", size: 13, y: 264 },
      { text: "映射与函数", size: 14, y: 264 },
      { text: "一、映射(1)", size: 14, y: 282 },
      { text: "习题1-1(15)", size: 17, y: 282 },
      { text: "第二节", size: 15, y: 299 },
      { text: "数列的极限", size: 14, y: 299 },
      { text: "18", size: 12, y: 304 },
      { text: "一、数列极限的定义(18)", size: 18, y: 316 },
      { text: "习题1-2(25)", size: 14, y: 321 },
      { text: "极限运算法则", size: 16, y: 406 },
      { text: "第五节", size: 15, y: 407 },
      { text: "……37", size: 10, y: 412 },
    ]);
    expect(tocPage).toBe(true);
    expect(rows.find((row) => row.type === "chapter")).toMatchObject({
      label: "第一章 函数与极限",
      printedPage: 1,
    });
    expect(rows.find((row) => row.type === "section" && row.ordinal === 1)).toMatchObject({
      label: "第一节 映射与函数",
      printedPage: 1,
    });
    expect(rows.find((row) => row.type === "section" && row.ordinal === 2)).toMatchObject({
      label: "第二节 数列的极限",
      printedPage: 18,
    });
    expect(rows.find((row) => row.type === "section" && row.ordinal === 5)).toMatchObject({
      label: "第五节 极限运算法则",
      printedPage: 37,
    });
    expect(rows.some((row) => row.label.includes("习题") || row.label.startsWith("一、"))).toBe(false);
  });

  it("harvests numeric-section toc rows (计算机组成原理 style)", () => {
    const { tocPage, rows } = harvestTocRows([
      { text: "目", size: 30, y: 100 },
      { text: "录", size: 30, y: 100 },
      { text: "CONTENTS", size: 18, y: 140 },
      { text: "第1章 概论", size: 16, y: 200 },
      { text: "1.1", size: 14, y: 230 },
      { text: "电子计算机与存储程序控制", size: 14, y: 231 },
      { text: "1.1.1 电子计算机的发展…", size: 13, y: 260 },
      { text: "2", size: 11, y: 266 },
      { text: "1.2", size: 14, y: 290 },
      { text: "计算机的硬件组成", size: 14, y: 291 },
      { text: "3", size: 11, y: 296 },
      { text: "1.3", size: 14, y: 320 },
      { text: "计算机系统", size: 14, y: 321 },
      { text: "8", size: 11, y: 326 },
      { text: "1.4", size: 14, y: 350 },
      { text: "计算机的工作过程和主要性能指标", size: 14, y: 351 },
      { text: "30", size: 11, y: 356 },
    ]);
    expect(tocPage).toBe(true);
    expect(rows).toEqual([
      expect.objectContaining({ label: "第1章 概论", type: "chapter", ordinal: 1, printedPage: 2 }),
      expect.objectContaining({ label: "1.1 电子计算机与存储程序控制", type: "section", ordinal: 1, scope: 1, printedPage: 2 }),
      expect.objectContaining({ label: "1.2 计算机的硬件组成", type: "section", ordinal: 2, scope: 1, printedPage: 3 }),
      expect.objectContaining({ label: "1.3 计算机系统", type: "section", ordinal: 3, scope: 1, printedPage: 8 }),
      expect.objectContaining({ label: "1.4 计算机的工作过程和主要性能指标", type: "section", ordinal: 4, scope: 1, printedPage: 30 }),
    ]);
  });

  it("does not classify a clause-numbered body page as a printed toc", () => {
    // 数据取自招标文件正文：条款编号 9.2/10.1 形似数字节，页码来自句中 (1)。
    const { tocPage, rows } = harvestTocRows([
      { text: "第四章 评标", size: 18, y: 60 },
      { text: "9.2除非招标文件的技术规格中另有规定，投标人在投标文件中及其与采购人和采购代理机构的所有往来文件中的计量单位均应采用中华人民共和国法定计量单位", size: 14, y: 140 },
      { text: "9.3投标人所提供的货物和服务均应以人民币报价，货币单位：元。", size: 14, y: 180 },
      { text: "10.1招标文件规定组织踏勘现场的，采购人按招标文件规定的时间、地点组织投标人踏勘项目现场。", size: 14, y: 220 },
      { text: "10.2投标人自行承担踏勘现场发生的责任、风险和自身费用。", size: 14, y: 260 },
      { text: "9.4报价包含一切税费(1)", size: 14, y: 300 },
      { text: "9.5报价有效期满足要求(1)", size: 14, y: 340 },
      { text: "9.6投标保证金已缴纳(1)", size: 14, y: 380 },
      { text: "9.7账户信息真实有效(1)", size: 14, y: 420 },
    ]);
    expect(tocPage).toBe(false);
    expect(rows).toEqual([]);
  });

  it("does not classify a body page as a printed toc", () => {
    const { tocPage, rows } = harvestTocRows([
      { text: "第一章 品数与板哦", size: 15, y: 18 },
      { text: "f(3)=1+3=4.这个函数的图形如图1-6所示.", size: 17, y: 97 },
      { text: "y=[x]", size: 15, y: 158 },
      { text: "V-β", size: 22, y: 200 },
      { text: "v≥V0,", size: 23, y: 260 },
      { text: "习题1-2", size: 14, y: 700 },
    ]);
    expect(tocPage).toBe(false);
    expect(rows).toEqual([]);
  });

  it("drops list items and math fragments from heading candidates", () => {
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
  });

  it("resolves the printed-to-pdf offset by voting and clips out-of-range entries", () => {
    const tocRows: TocRow[] = [
      { label: "第一章 函数与极限", printedPage: 1, type: "chapter", ordinal: 1 },
      { label: "第一节 映射与函数", printedPage: 2, type: "section", ordinal: 1 },
      { label: "第二节 数列的极限", printedPage: 18, type: "section", ordinal: 2 },
      { label: "第二章 导数与微分", printedPage: 60, type: "chapter", ordinal: 2 },
      { label: "第一节 导数概念", printedPage: 61, type: "section", ordinal: 1 },
      { label: "第十二章 无穷级数", printedPage: 330, type: "chapter", ordinal: 12 },
    ];
    const headings: OutlineHeading[] = [
      { label: "第一章 函数与极限", page: 18, level: 1, explicit: true },
      { label: "第一节 映射与函数", page: 19, level: 2, explicit: true },
      { label: "第二节 数列的极限", page: 35, level: 2, explicit: true },
      { label: "第一章 品数与板哦", page: 23, level: 1, explicit: true },
      { label: "第一节 映射与函数", page: 40, level: 2, explicit: true },
      { label: "第二章 导数与微分", page: 77, level: 1, explicit: true },
    ];
    const result = assembleOutline([{ page: 12, headings, tocRows }], 150);
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

  it("lets a numberless chapter inherit its first resolvable section", () => {
    const tocRows: TocRow[] = [
      { label: "第一章 函数与极限", printedPage: undefined, type: "chapter", ordinal: 1 },
      { label: "第一节 映射与函数", printedPage: 2, type: "section", ordinal: 1 },
      { label: "第二章 导数与微分", printedPage: 60, type: "chapter", ordinal: 2 },
    ];
    const headings: OutlineHeading[] = [
      { label: "第一章 函数与极限", page: 18, level: 1, explicit: true },
      { label: "第一节 映射与函数", page: 19, level: 2, explicit: true },
      { label: "第二章 导数与微分", page: 77, level: 1, explicit: true },
    ];
    const result = assembleOutline([{ page: 12, headings, tocRows }], 150);
    expect(result.strategy).toBe("toc");
    expect(result.nodes[0]).toMatchObject({ label: "第一章 函数与极限", page: 19 });
  });

  it("falls back to hardened heuristics when offset votes are insufficient", () => {
    const tocRows: TocRow[] = [
      { label: "第一章 函数与极限", printedPage: 1, type: "chapter", ordinal: 1 },
      { label: "第一节 映射与函数", printedPage: 2, type: "section", ordinal: 1 },
    ];
    const headings: OutlineHeading[] = [
      { label: "第一章 函数与极限", page: 18, level: 1, explicit: true },
      { label: "1. 映射概念", page: 20, level: 3, explicit: false },
    ];
    const result = assembleOutline([{ page: 12, headings, tocRows }], 150);
    expect(result.strategy).toBe("heuristic");
    expect(result.nodes).toMatchObject([{ label: "第一章 函数与极限", page: 18, children: [{ label: "1. 映射概念", page: 20 }] }]);
  });

  it("suppresses running headers by scoped ordinal first occurrence", () => {
    const headings: OutlineHeading[] = [
      { label: "第一章 函数与极限", page: 18, level: 1, explicit: true },
      { label: "第一节 映射与函数", page: 18, level: 2, explicit: true },
      { label: "第一章 品数与板哦", page: 23, level: 1, explicit: true },
      { label: "第一节 映射与函数", page: 24, level: 2, explicit: true },
      { label: "第一章 品数与极限", page: 40, level: 1, explicit: true },
      { label: "第二章 导数与微分", page: 77, level: 1, explicit: true },
      { label: "第一节 导数概念", page: 77, level: 2, explicit: true },
    ];
    const result = assembleOutline([{ page: 1, headings, tocRows: [] }], 150);
    expect(result.strategy).toBe("heuristic");
    expect(result.nodes).toMatchObject([
      {
        label: "第一章 函数与极限", page: 18,
        children: [{ label: "第一节 映射与函数", page: 18 }],
      },
      {
        label: "第二章 导数与微分", page: 77,
        children: [{ label: "第一节 导数概念", page: 77 }],
      },
    ]);
  });

  it("generates a toc-first outline from printed toc pages in rebuild", async () => {
    const tocPage = [
      { text: "目录", size: 37, y: 101 },
      { text: "第一章 函数与极限", size: 21, y: 232 },
      { text: "1", size: 12, y: 240 },
      { text: "第一节", size: 13, y: 264 },
      { text: "映射与函数(2)", size: 14, y: 264 },
      { text: "第二章 导数与微分", size: 21, y: 340 },
      { text: "3", size: 12, y: 348 },
      { text: "第一节", size: 13, y: 372 },
      { text: "导数概念(3)", size: 14, y: 372 },
    ];
    const pages: OutlineTextLine[][] = [
      tocPage,
      [
        { text: "第一章 函数与极限", size: 32, y: 700 },
        { text: "初等数学的研究对象基本上是不变的量，而高等数学的研究对象则是变动的", size: 19, y: 650 },
        { text: "量.所谓函数关系就是变量之间的一种依赖关系，极限方法是研究变量的一种基本方", size: 20, y: 630 },
      ],
      [
        { text: "第一章 函数与极限", size: 16, y: 780 },
        { text: "第一节 映射与函数", size: 23, y: 700 },
        { text: "映射是现代数学中的一个基本概念，而函数是微积分的研究对象，也是映射的一", size: 19, y: 650 },
        { text: "种.本节主要介绍映射、函数及有关概念，函数的性质与运算等.", size: 18, y: 630 },
      ],
      [
        { text: "第二章 导数与微分", size: 30, y: 700 },
        { text: "第一节 导数概念", size: 22, y: 660 },
        { text: "为了进一步说明导数概念，我们下面来讨论两个具体问题.", size: 19, y: 620 },
      ],
    ];
    const outline = createBookOutlineModule(dataHome, { openDocument: documentSource(pages) });
    closeOutline = outline.close;
    const result = await outline.rebuild(BOOK_ID, async () => ({ bytes: new Uint8Array() }));
    expect(result.status).toBe("generated");
    expect(outline.get(BOOK_ID)).toMatchObject([
      {
        label: "第一章 函数与极限", page: 2,
        children: [{ label: "第一节 映射与函数", page: 3 }],
      },
      {
        label: "第二章 导数与微分", page: 4,
        children: [{ label: "第一节 导数概念", page: 4 }],
      },
    ]);
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
    expect(outline.get(BOOK_ID)).toMatchObject([{ label: "第一章 标题1", page: 1 }]);
  });
});
