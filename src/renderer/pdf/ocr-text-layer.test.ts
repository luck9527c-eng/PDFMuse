// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RecognizedPageText } from "../../shared/contracts";
import { fitSpanFontSize, mountRecognizedTextLayer } from "./ocr-text-layer";
import { ocrAnchorRect } from "./selection-geometry";

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

describe("点击选整块", () => {
  // jsdom 的 Selection 是残缺桩（addRange 不生效），装一个受控假选区：
  // 真实 Range 照常创建，选区状态由桩记录，处理逻辑经真实 DOM 事件驱动。
  function installFakeSelection() {
    let current: { range: Range } | null = null;
    const selection = {
      get isCollapsed() {
        return current === null;
      },
      get rangeCount() {
        return current === null ? 0 : 1;
      },
      getRangeAt(index: number) {
        if (current === null || index !== 0) throw new Error("Invalid range index.");
        return current.range;
      },
      removeAllRanges() {
        current = null;
      },
      addRange(range: Range) {
        current = { range };
      },
    };
    vi.stubGlobal("getSelection", () => selection);
    return selection;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mountTwoBlocks() {
    const recognizedPage = recognizedPageWith([
      { type: "text", text: "第一块全文", bbox: [0.1, 0.1, 0.5, 0.2] },
      { type: "text", text: "第二块全文", bbox: [0.55, 0.1, 0.9, 0.2] },
    ]);
    const viewer = document.createElement("div");
    const page = document.createElement("div");
    page.className = "page";
    page.dataset.pageNumber = "2";
    viewer.appendChild(page);
    mountRecognizedTextLayer(viewer, recognizedPage);
    const spans = Array.from(page.querySelectorAll<HTMLElement>(".ocr-text-layer span"));
    return { spans };
  }

  it("点击块合成整块选区", () => {
    const selection = installFakeSelection();
    const { spans } = mountTwoBlocks();
    spans[1]!.click();
    expect(selection.isCollapsed).toBe(false);
    expect(selection.getRangeAt(0).toString()).toBe("第二块全文");
  });

  it("块内已有拖选（选区与该块相交）时点击不覆盖用户选区", () => {
    const selection = installFakeSelection();
    const { spans } = mountTwoBlocks();
    const range = document.createRange();
    range.selectNodeContents(spans[0]!);
    selection.addRange(range);
    spans[0]!.click();
    expect(selection.getRangeAt(0).toString()).toBe("第一块全文");
  });

  it("选区在另一块时点击替换为新块的整块选区", () => {
    const selection = installFakeSelection();
    const { spans } = mountTwoBlocks();
    spans[0]!.click();
    expect(selection.getRangeAt(0).toString()).toBe("第一块全文");
    spans[1]!.click();
    expect(selection.getRangeAt(0).toString()).toBe("第二块全文");
  });
});

describe("OCR 块选区矩形（高亮只取选区起点所在块）", () => {
  function stubOcrPage(rects: Array<null | { left: number; top: number; right: number; bottom: number; width: number; height: number }>) {
    const page = document.createElement("div");
    const layer = document.createElement("div");
    layer.className = "ocr-text-layer";
    page.appendChild(layer);
    const spans = rects.map((rect) => {
      const span = document.createElement("span");
      span.textContent = "块文本";
      layer.appendChild(span);
      if (rect) vi.spyOn(span, "getBoundingClientRect").mockReturnValue(rect as DOMRect);
      return span;
    });
    return { page, spans };
  }

  function fakeRangeAt(container: Node | null) {
    return { startContainer: container } as unknown as Range;
  }

  it("选区起点所在块返回其 bbox 矩形（元素容器）", () => {
    const first = { left: 10, top: 20, right: 110, bottom: 50, width: 100, height: 30 };
    const second = { left: 12, top: 60, right: 112, bottom: 90, width: 100, height: 30 };
    const { page, spans } = stubOcrPage([first, second]);
    expect(ocrAnchorRect(page, fakeRangeAt(spans[1]!))).toEqual(second);
  });

  it("起点是块内文本节点时经父元素归到该块", () => {
    const first = { left: 10, top: 20, right: 110, bottom: 50, width: 100, height: 30 };
    const second = { left: 12, top: 60, right: 112, bottom: 90, width: 100, height: 30 };
    const { page, spans } = stubOcrPage([first, second]);
    expect(ocrAnchorRect(page, fakeRangeAt(spans[1]!.firstChild))).toEqual(second);
  });

  it("起点不在 OCR 层内时返回 null（原生文字层回落字形矩形）", () => {
    const first = { left: 10, top: 20, right: 110, bottom: 50, width: 100, height: 30 };
    const { page } = stubOcrPage([first]);
    expect(ocrAnchorRect(page, fakeRangeAt(page))).toBeNull();
  });

  it("页面没有 OCR 文字层时返回 null", () => {
    const page = document.createElement("div");
    expect(ocrAnchorRect(page, fakeRangeAt(page))).toBeNull();
  });
});
