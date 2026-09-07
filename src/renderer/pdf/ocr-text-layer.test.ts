// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import type { RecognizedPageText } from "../../shared/contracts";
import { mountRecognizedTextLayer } from "./ocr-text-layer";

const recognizedPage: RecognizedPageText = {
  bookId: "a".repeat(64),
  page: 2,
  width: 1000,
  height: 1500,
  orientation: 0,
  lines: [{
    text: "可选择文字",
    confidence: 0.98,
    polygon: [{ x: 100, y: 200 }, { x: 500, y: 200 }, { x: 500, y: 260 }, { x: 100, y: 260 }],
  }],
  engine: "测试引擎",
  model: "测试模型",
  inputHash: "b".repeat(64),
  engineVersion: "1",
  createdAt: new Date(0).toISOString(),
};

describe("OCR text layer", () => {
  it("can be mounted after the PDF.js page appears and replaces stale layers", () => {
    const viewer = document.createElement("div");
    expect(mountRecognizedTextLayer(viewer, recognizedPage)).toBe(false);

    const page = document.createElement("div");
    page.className = "page";
    page.dataset.pageNumber = "2";
    viewer.appendChild(page);

    expect(mountRecognizedTextLayer(viewer, recognizedPage)).toBe(true);
    expect(page.querySelector(".ocr-text-layer span")?.textContent).toBe("可选择文字");
    expect(mountRecognizedTextLayer(viewer, recognizedPage)).toBe(true);
    expect(page.querySelectorAll(".ocr-text-layer")).toHaveLength(1);
  });
});
