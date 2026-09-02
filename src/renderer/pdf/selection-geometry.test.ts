import { readFile } from "node:fs/promises";
import path from "node:path";

import { getDocument, Util } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";

import { normalizePageRects } from "./selection-geometry";

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
