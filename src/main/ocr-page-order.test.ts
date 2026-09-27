import { describe, expect, it } from "vitest";

import { linearPageOrder } from "./ocr-page-order.js";

describe("OCR page order", () => {
  it("scans linearly from the first page regardless of where the book was opened", () => {
    expect(linearPageOrder(5)).toEqual([1, 2, 3, 4, 5]);
    expect(linearPageOrder(1)).toEqual([1]);
    // 探测窗口（目录定位）最先覆盖：批量序不再从开书页向两侧扩散。
    expect(linearPageOrder(7).slice(0, 3)).toEqual([1, 2, 3]);
  });

  it("returns an empty order for invalid page counts", () => {
    expect(linearPageOrder(0)).toEqual([]);
    expect(linearPageOrder(-3)).toEqual([]);
    expect(linearPageOrder(Number.NaN)).toEqual([]);
  });
});
