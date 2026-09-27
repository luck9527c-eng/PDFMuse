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

/** DOMRect → 纯数据矩形：选区链路的统一换算入口（jsdom 无布局，测试经纯数据直喂）。 */
export function toRectangle(domRect: DOMRect): Rectangle {
  return {
    left: domRect.left,
    top: domRect.top,
    right: domRect.right,
    bottom: domRect.bottom,
    width: domRect.width,
    height: domRect.height,
  };
}

/**
 * 扫描页单块选区的高亮矩形（T56 后仅作用于未量化路径）：选区起点所在 OCR 块 bbox（MinerU 坐标直接定位）。
 * 跨块拖选走 collectOcrBlockSelection 的块级量化；起点不在 OCR 层时返回 null，调用方回落原生字形矩形。
 */
export function ocrAnchorRect(page: HTMLElement, range: Range): Rectangle | null {
  const container = range.startContainer;
  const element = container instanceof Element ? container : container.parentElement;
  const span = element?.closest<HTMLElement>(".ocr-text-layer span");
  if (!span || !page.contains(span)) return null;
  return toRectangle(span.getBoundingClientRect());
}

/** OCR 块候选（T56）：渲染端从 OCR 层 span 收集的纯数据形状，量化判定不触碰 DOM。 */
export type OcrBlockCandidate = {
  rect: Rectangle;
  text: string;
  type: string;
};

/** 噪声块（T56 R1-Q4）：拖选量化时无条件排除，与 ocr-text-layer 块类型标签表对齐。 */
const NOISE_BLOCK_TYPES = new Set(["header", "footer", "page_number"]);

function rectsIntersect(a: Rectangle, b: Rectangle): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/**
 * 拖选块级量化（T56）：按选区逐矩形与块 bbox 的几何相交收集途经块——不用边界盒，
 * 多栏页边界盒水平外扩会误收未途经块；零面积选区矩形（断行桩）不参与。
 * 噪声块无条件排除，included 保持 DOM 序（MinerU 输出序即阅读序）。
 * touchedRaw = 几何触及块数（含噪声）。调用方语义：0 → 原生路径；≥2 → 量化；
 * ≥1 且 included 空 → 纯噪声拖选，抑制 popover。
 */
export function collectOcrBlockSelection(input: {
  selectionRects: ReadonlyArray<Rectangle>;
  blocks: ReadonlyArray<OcrBlockCandidate>;
}): { touchedRaw: number; included: OcrBlockCandidate[] } {
  const hit = input.blocks.filter((block) =>
    input.selectionRects.some((selection) => selection.width > 0 && selection.height > 0 && rectsIntersect(selection, block.rect)),
  );
  return { touchedRaw: hit.length, included: hit.filter((block) => !NOISE_BLOCK_TYPES.has(block.type)) };
}

/** 纳入块全文按 DOM 序以双换行拼接（T56 R1-Q4/R2-Q4），单块即块全文。 */
export function joinBlockTexts(blocks: ReadonlyArray<OcrBlockCandidate>): string {
  return blocks.map((block) => block.text).join("\n\n");
}

/** 矩形集并集 bbox（T56 popover 锚点）；空集返回 null（调用方在此之前已保证非空）。 */
export function unionRects(rects: ReadonlyArray<Rectangle>): Rectangle | null {
  if (rects.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const rect of rects) {
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  }
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

export type PageSelectionEvaluation = {
  text: string;
  /** 高亮矩形：量化 = 纳入块 bbox；单块 = 起点块 bbox；原生 = 空（清高亮）。 */
  highlightRects: Rectangle[];
  /** popover 锚定矩形：量化 = 纳入块并集；单块 = 起点块；原生 = 选区边界盒。 */
  popoverRect: Rectangle;
  /** 进 SelectedPassage 前的选区矩形（调用方再经 normalizePageRects 裁剪换算）。 */
  passageRects: ReadonlyArray<Rectangle>;
};

/**
 * 选中链路判定（T56 纯函数）：量化（touchedRaw≥2，含跨噪声边界纳入单块的退化形态）、
 * 纯噪声抑制（返回 null，调用方清 popover）、单块/原生路径（起点块 bbox + 字符级文本）。
 * wholeBlockClick 守卫 R1-Q6：点击合成的整块选区不参与量化——被点块 bbox 与邻块重叠时
 * 防止点击被升级成多块选区（2026-09-23 点击语义冻结）；此类选区恒走单块路径。
 */
export function evaluatePageSelection(input: {
  selectionRects: ReadonlyArray<Rectangle>;
  ocrBlocks: ReadonlyArray<OcrBlockCandidate>;
  startBlockRect: Rectangle | null;
  nativeText: string;
  nativeSelectionRect: Rectangle;
  wholeBlockClick: boolean;
}): PageSelectionEvaluation | null {
  if (!input.wholeBlockClick && input.ocrBlocks.length > 0) {
    const { touchedRaw, included } = collectOcrBlockSelection({ selectionRects: input.selectionRects, blocks: input.ocrBlocks });
    if (touchedRaw > 0 && included.length === 0) return null;
    if (touchedRaw >= 2) {
      const rects = included.map((block) => block.rect);
      return {
        text: joinBlockTexts(included).trim(),
        highlightRects: rects,
        popoverRect: unionRects(rects) ?? input.nativeSelectionRect,
        passageRects: rects,
      };
    }
  }
  return {
    text: input.nativeText,
    highlightRects: input.startBlockRect ? [input.startBlockRect] : [],
    popoverRect: input.startBlockRect ?? input.nativeSelectionRect,
    passageRects: input.startBlockRect ? [input.startBlockRect] : input.selectionRects,
  };
}
