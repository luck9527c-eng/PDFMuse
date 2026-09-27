import { readFile } from "node:fs/promises";
import path from "node:path";

import { getDocument, Util } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";

import {
  collectOcrBlockSelection,
  evaluatePageSelection,
  joinBlockTexts,
  normalizePageRects,
  unionRects,
  type OcrBlockCandidate,
  type Rectangle,
} from "./selection-geometry";

function rect(left: number, top: number, right: number, bottom: number): Rectangle {
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

describe("Selected Passage geometry", () => {
  it("通过固定 PDF 将同页文字矩形转换为稳定的页面坐标", async () => {
    const bytes = new Uint8Array(await readFile(path.resolve("src", "main", "fixtures", "navigation.pdf")));
    const standardFontsPath = `${path.resolve("node_modules", "pdfjs-dist", "standard_fonts").replaceAll("\\", "/")}/`;
    const loadingTask = getDocument({ data: bytes, standardFontDataUrl: standardFontsPath });
    try {
      const document = await loadingTask.promise;
      const page = await document.getPage(1);
      const viewport = page.getViewport({ scale: 1.75 });
      const content = await page.getTextContent();
      const heading = content.items.find((item) => "str" in item && item.str === "Chapter One");
      if (!heading || !("transform" in heading) || !("width" in heading)) throw new Error("固定 PDF 缺少标题文字");
      const transform = Util.transform(viewport.transform, heading.transform);
      const pageRect = {
        left: 120,
        top: 80,
        right: 120 + viewport.width,
        bottom: 80 + viewport.height,
        width: viewport.width,
        height: viewport.height,
      };
      const textRect = {
        left: pageRect.left + transform[4],
        top: pageRect.top + transform[5] - Math.abs(transform[3]),
        right: pageRect.left + transform[4] + heading.width * viewport.scale,
        bottom: pageRect.top + transform[5],
        width: heading.width * viewport.scale,
        height: Math.abs(transform[3]),
      };

      const [normalized] = normalizePageRects(pageRect, [textRect]);

      expect(normalized).toBeDefined();
      expect(normalized!.x).toBeCloseTo(72 / 595.2756, 4);
      expect(normalized!.width).toBeGreaterThan(0);
      expect(normalized!.height).toBeGreaterThan(0);
      expect(normalized!.x + normalized!.width).toBeLessThanOrEqual(1);
      expect(normalized!.y + normalized!.height).toBeLessThanOrEqual(1);
    } finally {
      await loadingTask.destroy();
    }
  });

  it("裁剪超出页面的矩形并忽略完全位于页面外的矩形", () => {
    expect(normalizePageRects(
      { left: 100, top: 50, right: 500, bottom: 650, width: 400, height: 600 },
      [
        { left: 80, top: 40, right: 180, bottom: 110, width: 100, height: 70 },
        { left: 520, top: 80, right: 560, bottom: 120, width: 40, height: 40 },
      ],
    )).toEqual([{ x: 0, y: 0, width: 0.2, height: 0.1 }]);
  });
});

describe("拖选块级量化（T56）", () => {
  function para(text: string, top: number): OcrBlockCandidate {
    return { type: "text", text, rect: rect(100, top, 500, top + 40) };
  }

  it("途经块全部纳入并保持 DOM 序（阅读序）", () => {
    const blocks = [para("第一块", 100), para("第二块", 160), para("第三块", 220)];
    const result = collectOcrBlockSelection({ selectionRects: [rect(100, 110, 500, 250)], blocks });
    expect(result.touchedRaw).toBe(3);
    expect(result.included.map((block) => block.text)).toEqual(["第一块", "第二块", "第三块"]);
  });

  it("噪声块（页眉/页脚/页码）无条件排除，touchedRaw 仍计入", () => {
    const blocks = [
      { type: "header", text: "页眉", rect: rect(100, 20, 500, 40) },
      para("第一块", 100),
      para("第二块", 160),
      { type: "footer", text: "页脚", rect: rect(100, 600, 500, 620) },
      { type: "page_number", text: "12", rect: rect(480, 630, 500, 650) },
    ];
    const result = collectOcrBlockSelection({ selectionRects: [rect(100, 30, 500, 180)], blocks });
    expect(result.touchedRaw).toBe(3);
    expect(result.included.map((block) => block.text)).toEqual(["第一块", "第二块"]);
  });

  it("纯噪声拖选：触及 OCR 层但纳入为零（调用方据此抑制 popover）", () => {
    const blocks = [
      { type: "header", text: "页眉", rect: rect(100, 20, 500, 40) },
      { type: "page_number", text: "12", rect: rect(480, 600, 500, 620) },
    ];
    const result = collectOcrBlockSelection({ selectionRects: [rect(100, 25, 500, 610)], blocks });
    expect(result.touchedRaw).toBe(2);
    expect(result.included).toHaveLength(0);
  });

  it("单块内选区 touchedRaw=1：量化不触发，维持字符级现状（R2-Q1）", () => {
    const blocks = [para("第一块", 100), para("第二块", 160)];
    const result = collectOcrBlockSelection({ selectionRects: [rect(120, 110, 300, 130)], blocks });
    expect(result.touchedRaw).toBe(1);
    expect(result.included.map((block) => block.text)).toEqual(["第一块"]);
  });

  it("不相交时 touchedRaw=0（调用方走原生路径）", () => {
    const blocks = [para("第一块", 100)];
    const result = collectOcrBlockSelection({ selectionRects: [rect(100, 300, 500, 320)], blocks });
    expect(result.touchedRaw).toBe(0);
    expect(result.included).toHaveLength(0);
  });

  it("按选区逐矩形判定相交，不用边界盒外扩（多栏页防误收未途经块）", () => {
    const middleBlock: OcrBlockCandidate = { type: "text", text: "中缝块", rect: rect(250, 120, 350, 180) };
    const result = collectOcrBlockSelection({
      selectionRects: [rect(100, 110, 200, 190), rect(400, 110, 500, 190)],
      blocks: [middleBlock],
    });
    expect(result.touchedRaw).toBe(0);
  });

  it("零面积选区矩形不参与相交判定", () => {
    const blocks = [para("第一块", 100)];
    const result = collectOcrBlockSelection({
      selectionRects: [rect(120, 110, 120, 130), rect(300, 500, 400, 520)],
      blocks,
    });
    expect(result.touchedRaw).toBe(0);
  });

  it("量化退化形态：跨噪声边界后纳入单块（touchedRaw≥2）", () => {
    const blocks = [{ type: "header", text: "页眉", rect: rect(100, 20, 500, 40) }, para("第一块", 100)];
    const result = collectOcrBlockSelection({ selectionRects: [rect(100, 30, 300, 130)], blocks });
    expect(result.touchedRaw).toBe(2);
    expect(result.included.map((block) => block.text)).toEqual(["第一块"]);
  });
});

describe("joinBlockTexts（T56 文本拼接）", () => {
  it("块全文按 DOM 序以双换行拼接，插图占位与公式 LaTeX 照常参与", () => {
    const blocks: OcrBlockCandidate[] = [
      { type: "text", text: "第一段全文", rect: rect(100, 100, 500, 140) },
      { type: "image", text: "［插图］", rect: rect(100, 150, 500, 300) },
      { type: "equation", text: "y = x^2", rect: rect(100, 310, 500, 350) },
    ];
    expect(joinBlockTexts(blocks)).toBe("第一段全文\n\n［插图］\n\ny = x^2");
  });

  it("纳入单块时返回块全文（跨噪声边界量化的退化形态）", () => {
    expect(joinBlockTexts([{ type: "text", text: "唯一内容块", rect: rect(0, 0, 10, 10) }])).toBe("唯一内容块");
  });

  it("空纳入集返回空串（调用方在更早分支已抑制，防御用）", () => {
    expect(joinBlockTexts([])).toBe("");
  });
});

describe("unionRects（T56 popover 并集锚点）", () => {
  it("多矩形并集为包住全部的 bbox", () => {
    expect(unionRects([rect(10, 20, 110, 50), rect(12, 60, 112, 90)])).toEqual(rect(10, 20, 112, 90));
  });

  it("单矩形并集为自身", () => {
    const single = rect(1, 2, 3, 4);
    expect(unionRects([single])).toEqual(single);
  });

  it("空集返回 null（调用方在此之前已保证非空，防御用）", () => {
    expect(unionRects([])).toBeNull();
  });
});

describe("evaluatePageSelection（T56 选中链路判定）", () => {
  function para(text: string, top: number): OcrBlockCandidate {
    return { type: "text", text, rect: rect(100, top, 500, top + 40) };
  }
  function evaluate(overrides: Partial<Parameters<typeof evaluatePageSelection>[0]> = {}) {
    return evaluatePageSelection({
      selectionRects: [],
      ocrBlocks: [],
      startBlockRect: null,
      nativeText: "原生拖选文本",
      nativeSelectionRect: rect(0, 0, 10, 10),
      wholeBlockClick: false,
      ...overrides,
    });
  }

  it("量化多块：文本按阅读序拼接、高亮为纳入块集、popover 锚并集", () => {
    const blocks = [para("第一块", 100), para("第二块", 160), para("第三块", 220)];
    const evaluation = evaluate({ selectionRects: [rect(100, 110, 500, 250)], ocrBlocks: blocks });
    expect(evaluation!.text).toBe("第一块\n\n第二块\n\n第三块");
    expect(evaluation!.highlightRects).toEqual(blocks.map((block) => block.rect));
    expect(evaluation!.popoverRect).toEqual(rect(100, 100, 500, 260));
    expect(evaluation!.passageRects).toEqual(blocks.map((block) => block.rect));
  });

  it("纯噪声拖选返回 null（调用方清 popover）", () => {
    const evaluation = evaluate({
      selectionRects: [rect(100, 30, 500, 610)],
      ocrBlocks: [
        { type: "header", text: "页眉", rect: rect(100, 20, 500, 40) },
        { type: "page_number", text: "12", rect: rect(480, 600, 500, 620) },
      ],
    });
    expect(evaluation).toBeNull();
  });

  it("R1-Q6 守卫：点击合成的整块选区不量化——bbox 与邻块重叠仍走单块形态", () => {
    const clickedRect = rect(100, 100, 500, 140);
    const evaluation = evaluate({
      selectionRects: [rect(100, 110, 500, 250)],
      ocrBlocks: [para("被点块", 100), para("邻块", 160)],
      startBlockRect: clickedRect,
      nativeText: "被点块全文",
      wholeBlockClick: true,
    });
    expect(evaluation!.text).toBe("被点块全文");
    expect(evaluation!.highlightRects).toEqual([clickedRect]);
    expect(evaluation!.popoverRect).toEqual(clickedRect);
    expect(evaluation!.passageRects).toEqual([clickedRect]);
  });

  it("单块内拖选（touchedRaw=1）：字符级文本 + 起点块高亮，量化不触发", () => {
    const startBlock = rect(100, 100, 500, 140);
    const evaluation = evaluate({
      selectionRects: [rect(120, 110, 300, 130)],
      ocrBlocks: [para("第一块", 100), para("第二块", 160)],
      startBlockRect: startBlock,
      nativeText: "块内片段",
    });
    expect(evaluation!.text).toBe("块内片段");
    expect(evaluation!.highlightRects).toEqual([startBlock]);
    expect(evaluation!.passageRects).toEqual([startBlock]);
  });

  it("原生页无 OCR 层：字形矩形进选区、无高亮、popover 锚原生选区", () => {
    const selectionRects = [rect(100, 110, 500, 130)];
    const evaluation = evaluate({ selectionRects, nativeSelectionRect: rect(100, 110, 500, 130) });
    expect(evaluation!.text).toBe("原生拖选文本");
    expect(evaluation!.highlightRects).toEqual([]);
    expect(evaluation!.popoverRect).toEqual(rect(100, 110, 500, 130));
    expect(evaluation!.passageRects).toEqual(selectionRects);
  });
});
