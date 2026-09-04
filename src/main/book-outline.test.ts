import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildOutlineTree,
  createBookOutlineModule,
  detectHeadingCandidates,
  type OpenOutlineDocument,
  type OutlineTextLine,
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
});
