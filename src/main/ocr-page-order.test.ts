import { describe, expect, it } from "vitest";

import { prioritizedPageOrder } from "./ocr-page-order.js";

describe("OCR page priority", () => {
  it("scans linearly from the first page regardless of where the book was opened", () => {
    expect(prioritizedPageOrder(5)).toEqual([1, 2, 3, 4, 5]);
    expect(prioritizedPageOrder(1)).toEqual([1]);
    // 探测窗口（目录定位）最先覆盖：批量序不再从开书页向两侧扩散。
    expect(prioritizedPageOrder(7).slice(0, 3)).toEqual([1, 2, 3]);
  });

  it("returns an empty order for invalid page counts", () => {
    expect(prioritizedPageOrder(0)).toEqual([]);
    expect(prioritizedPageOrder(-3)).toEqual([]);
    expect(prioritizedPageOrder(Number.NaN)).toEqual([]);
  });
});
