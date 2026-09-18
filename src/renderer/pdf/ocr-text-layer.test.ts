// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import type { RecognizedPageText } from "../../shared/contracts";
import { mountRecognizedTextLayer } from "./ocr-text-layer";

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
