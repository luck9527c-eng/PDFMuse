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
 * 扫描页选区的高亮矩形：只取选区起点所在的 OCR 块 bbox（MinerU 坐标直接定位）。
 * 不取"所有相交块"——块 bbox 彼此重叠，大范围选区会叠成整页色块（Reader 截图复盘）；
 * 点击选整块交互下起点块恒为被点击块。起点不在 OCR 层时返回 null，调用方回落原生字形矩形。
 */
export function ocrAnchorRect(page: HTMLElement, range: Range): Rectangle | null {
  const container = range.startContainer;
  const element = container instanceof Element ? container : container.parentElement;
  const span = element?.closest<HTMLElement>(".ocr-text-layer span");
  if (!span || !page.contains(span)) return null;
  const rect = span.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}
