// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import type { RecognizedPageText } from "../../shared/contracts";
import { fitSpanFontSize, mountRecognizedTextLayer } from "./ocr-text-layer";

function recognizedPageWith(blocks: RecognizedPageText["blocks"]): RecognizedPageText {
  return {
    bookId: "a".repeat(64),
    page: 2,
    blocks,
    engine: "MinerU Worker",
    model: "basic",
    inputHash: "b".repeat(64),
    engineVersion: "4.0.2",
    createdAt: new Date(0).toISOString(),
  };
}

describe("OCR text layer", () => {
  it("can be mounted after the PDF.js page appears and replaces stale layers", () => {
    const recognizedPage = recognizedPageWith([
      { type: "text", text: "可选择文字", bbox: [0.1, 0.2, 0.5, 0.26] },
    ]);
    const viewer = document.createElement("div");
    expect(mountRecognizedTextLayer(viewer, recognizedPage)).toBe(false);

    const page = document.createElement("div");
    page.className = "page";
    page.dataset.pageNumber = "2";
    viewer.appendChild(page);

    expect(mountRecognizedTextLayer(viewer, recognizedPage)).toBe(true);
    const span = page.querySelector(".ocr-text-layer span");
    expect(span?.textContent).toBe("可选择文字");
    expect((span as HTMLElement).style.left).toBe("10%");
    expect((span as HTMLElement).style.top).toBe("20%");
    expect(mountRecognizedTextLayer(viewer, recognizedPage)).toBe(true);
    expect(page.querySelectorAll(".ocr-text-layer")).toHaveLength(1);
  });

  it("renders each block as a whole-block span with type-aware labels", () => {
    const recognizedPage = recognizedPageWith([
      { type: "text", text: "正文段落", bbox: [0.1, 0.2, 0.5, 0.26] },
      { type: "equation", text: "y = \\left| x \\right|", bbox: [0.35, 0.3, 0.54, 0.35] },
      { type: "header", text: "第一节 映射与函数", bbox: [0.67, 0.02, 0.82, 0.04] },
    ]);
    const viewer = document.createElement("div");
    const page = document.createElement("div");
    page.className = "page";
    page.dataset.pageNumber = "2";
    viewer.appendChild(page);

    mountRecognizedTextLayer(viewer, recognizedPage);
    const spans = Array.from(page.querySelectorAll<HTMLElement>(".ocr-text-layer span"));
    expect(spans).toHaveLength(3);
    expect(spans.map((span) => span.dataset.ocrType)).toEqual(["text", "equation", "header"]);
    expect(spans.map((span) => span.title)).toEqual(["文本", "公式（LaTeX）", "页眉"]);
    // 公式块以 LaTeX 原文参与选中，划选提问拿到的是可复述的公式而不是乱码。
    expect(spans[1]?.textContent).toBe("y = \\left| x \\right|");
  });

  it("skips empty-text blocks and non-finite bounding boxes", () => {
    const recognizedPage = recognizedPageWith([
      { type: "image", text: "", bbox: [0.1, 0.1, 0.9, 0.9] },
      { type: "text", text: "   ", bbox: [0.1, 0.1, 0.9, 0.2] },
      { type: "text", text: "异常坐标", bbox: [Number.NaN, 0.1, 0.9, 0.2] },
      { type: "text", text: "正常文本", bbox: [0.1, 0.1, 0.9, 0.2] },
    ]);
    const viewer = document.createElement("div");
    const page = document.createElement("div");
    page.className = "page";
    page.dataset.pageNumber = "2";
    viewer.appendChild(page);

    mountRecognizedTextLayer(viewer, recognizedPage);
    const spans = Array.from(page.querySelectorAll<HTMLElement>(".ocr-text-layer span"));
    expect(spans).toHaveLength(1);
    expect(spans[0]?.textContent).toBe("正常文本");
  });
});

describe("fitSpanFontSize", () => {
  function stubBox(offsetWidth: number, offsetHeight: number, scrollWidth: number) {
    return {
      offsetWidth,
      offsetHeight,
      scrollWidth,
      style: { fontSize: "", whiteSpace: "" },
    };
  }

  it("按盒面积与单行总宽解出字号：100×50 盒、单行 80000px → 25px 并恢复折行", () => {
    const span = stubBox(100, 50, 80_000);
    expect(fitSpanFontSize(span)).toBe(25);
    expect(span.style.fontSize).toBe("25px");
    expect(span.style.whiteSpace).toBe("normal");
  });

  it("字号夹在上限 64px：短文本大盒子不再放大", () => {
    const span = stubBox(200, 50, 8_000);
    expect(fitSpanFontSize(span)).toBe(64);
    expect(span.style.fontSize).toBe("64px");
  });

  it("字号夹在下限 6px：超长文本小盒子不再缩小", () => {
    const span = stubBox(100, 50, 80_000_000);
    expect(fitSpanFontSize(span)).toBe(6);
    expect(span.style.fontSize).toBe("6px");
  });

  it("无布局（测试/隐藏页）时跳过拟合且不碰样式", () => {
    const span = stubBox(0, 50, 8_000);
    expect(fitSpanFontSize(span)).toBeUndefined();
    expect(span.style.fontSize).toBe("");
    expect(span.style.whiteSpace).toBe("");
  });

  it("单行总宽为 0（空内容）时跳过拟合", () => {
    const span = stubBox(100, 50, 0);
    expect(fitSpanFontSize(span)).toBeUndefined();
    expect(span.style.fontSize).toBe("");
  });
});
