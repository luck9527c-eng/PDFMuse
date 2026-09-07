import { describe, expect, it } from "vitest";

import { prioritizedPageOrder } from "./ocr-page-order.js";

describe("OCR page priority", () => {
  it("expands from the current page to its neighbors before the rest of the book", () => {
    expect(prioritizedPageOrder(7, 4)).toEqual([4, 5, 3, 6, 2, 7, 1]);
    expect(prioritizedPageOrder(3, 1)).toEqual([1, 2, 3]);
    expect(prioritizedPageOrder(3, 99)).toEqual([3, 2, 1]);
  });
});
