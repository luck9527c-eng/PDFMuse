// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import type { RecognizedPageText } from "../../shared/contracts";
import { mountRecognizedTextLayer } from "./ocr-text-layer";

const recognizedPage: RecognizedPageText = {
  bookId: "a".repeat(64),
  page: 2,
  blocks: [
    { type: "text", text: "可选择文字", bbox: [0.1, 0.2, 0.5, 0.26] },
    { type: "equation", text: "y = x", bbox: [0.35, 0.3, 0.54, 0.35] },
  ],
  engine: "测试引擎",
  model: "basic",
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
    const spans = page.querySelectorAll(".ocr-text-layer span");
    expect(spans).toHaveLength(2);
    expect(spans[0]?.textContent).toBe("可选择文字");
    expect((spans[0] as HTMLElement).style.left).toBe("10%");
    expect((spans[0] as HTMLElement).style.top).toBe("20%");
    expect(mountRecognizedTextLayer(viewer, recognizedPage)).toBe(true);
    expect(page.querySelectorAll(".ocr-text-layer")).toHaveLength(1);
  });
});
