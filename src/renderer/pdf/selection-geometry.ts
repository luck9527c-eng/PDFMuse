import type { NormalizedPageRect } from "../../shared/contracts";

export type Rectangle = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

const precision = 1_000_000;

function rounded(value: number) {
  return Math.round(value * precision) / precision;
}

export function normalizePageRects(page: Rectangle, selections: Rectangle[]): NormalizedPageRect[] {
  if (page.width <= 0 || page.height <= 0) return [];

  return selections.flatMap((selection) => {
    const left = Math.max(page.left, selection.left);
    const top = Math.max(page.top, selection.top);
    const right = Math.min(page.right, selection.right);
    const bottom = Math.min(page.bottom, selection.bottom);
    if (right <= left || bottom <= top) return [];
    return [{
      x: rounded((left - page.left) / page.width),
      y: rounded((top - page.top) / page.height),
      width: rounded((right - left) / page.width),
      height: rounded((bottom - top) / page.height),
    }];
  });
}

/**
 * 选区命中的 OCR 块的 bbox 矩形（MinerU 坐标直接定位高亮，替代拟合字形的错位矩形）；
 * 页面无 OCR 文字层或选区未命中任何块时返回 null，调用方回落到原生字形矩形。
 */
export function ocrSelectionRects(page: HTMLElement, range: Range): Rectangle[] | null {
  const spans = page.querySelectorAll<HTMLElement>(".ocr-text-layer span");
  if (spans.length === 0) return null;
  const rects: Rectangle[] = [];
  for (const span of spans) {
    if (!range.intersectsNode(span)) continue;
    const rect = span.getBoundingClientRect();
    rects.push({
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    });
  }
  return rects.length > 0 ? rects : null;
}

/** 多矩形的外接框（popover 锚点）；空集返回 null。 */
export function unionRect(rects: Rectangle[]): Rectangle | null {
  if (rects.length === 0) return null;
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const rect of rects) {
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  }
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}
