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
