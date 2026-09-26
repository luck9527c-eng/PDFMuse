import type { MineruBlock, RecognizedPageText } from "../../shared/contracts";

const BLOCK_TYPE_LABELS: Record<string, string> = {
  text: "文本",
  header: "页眉",
  footer: "页脚",
  page_number: "页码",
  equation: "公式（LaTeX）",
  table: "表格",
  image: "插图",
};

function blockTypeLabel(block: MineruBlock) {
  return BLOCK_TYPE_LABELS[block.type] ?? block.type;
}

const FIT_BASE_FONT_PX = 100;
const FIT_MIN_FONT_PX = 6;
const FIT_MAX_FONT_PX = 64;

export type SpanBoxMeasurement = {
  offsetWidth: number;
  offsetHeight: number;
  scrollWidth: number;
  style: { fontSize: string; whiteSpace: string };
};

/**
 * 把块内文字的字号拟合到块级 bbox：以 100px 基准量出单行总宽 W1，
 * 字号 f 下占高 ≈ W1·f²/(100·W)（line-height 1），令其等于盒高 H 解出
 * f=√(100·W·H/W1)。透明选字层只需贴合块 bbox；无布局（测试/隐藏页）时跳过。
 */
export function fitSpanFontSize(span: SpanBoxMeasurement): number | undefined {
  const boxWidth = span.offsetWidth;
  const boxHeight = span.offsetHeight;
  if (boxWidth <= 0 || boxHeight <= 0) return undefined;
  const previousFontSize = span.style.fontSize;
  const previousWhiteSpace = span.style.whiteSpace;
  span.style.whiteSpace = "nowrap";
  span.style.fontSize = `${FIT_BASE_FONT_PX}px`;
  const singleLineWidth = span.scrollWidth;
  if (singleLineWidth <= 0) {
    span.style.fontSize = previousFontSize;
    span.style.whiteSpace = previousWhiteSpace;
    return undefined;
  }
  const fitted = Math.sqrt((FIT_BASE_FONT_PX * boxWidth * boxHeight) / singleLineWidth);
  const fontSize = Math.max(FIT_MIN_FONT_PX, Math.min(FIT_MAX_FONT_PX, fitted));
  span.style.fontSize = `${fontSize}px`;
  span.style.whiteSpace = "normal";
  return fontSize;
}

export function mountRecognizedTextLayer(viewer: HTMLElement, recognizedPage?: RecognizedPageText) {
  viewer.querySelectorAll("[data-pdfmuse-ocr]").forEach((node) => node.remove());
  if (!recognizedPage) return false;
  const page = viewer.querySelector<HTMLElement>(`.page[data-page-number="${recognizedPage.page}"]`);
  if (!page) return false;

  const layer = document.createElement("div");
  layer.dataset.pdfmuseOcr = "true";
  layer.className = "ocr-text-layer";
  layer.setAttribute("aria-label", `第 ${recognizedPage.page} 页识别文字`);
  for (const block of recognizedPage.blocks) {
    const [x0, y0, x1, y1] = block.bbox;
    if (![x0, y0, x1, y1].every((value) => Number.isFinite(value))) continue;
    // 插图块：image_analysis=False 时 content 为空，但版面 bbox 准确——
    // 以占位文本参与选中（Reader 划给 AI 后可经 view_page 查看原图）。
    const isPlaceholderImage = block.type === "image" && !block.text.trim();
    if (!block.text.trim() && !isPlaceholderImage) continue;
    const span = document.createElement("span");
    span.textContent = isPlaceholderImage ? "［插图］" : block.text;
    span.title = blockTypeLabel(block);
    span.dataset.ocrType = block.type;
    // 块 bbox 盖章：选中载荷携带归一化坐标，块级原图对照（T53）经此裁剪。
    span.dataset.ocrBbox = JSON.stringify(block.bbox);
    // 块级 bbox 为 0-1 归一化坐标，直接换算为页面百分比定位；选中即整块，公式块拿到 LaTeX 原文。
    span.style.left = `${Math.max(0, Math.min(100, x0 * 100))}%`;
    span.style.top = `${Math.max(0, Math.min(100, y0 * 100))}%`;
    span.style.width = `${Math.max(0.5, Math.min(100, (x1 - x0) * 100))}%`;
    span.style.height = `${Math.max(0.5, Math.min(100, (y1 - y0) * 100))}%`;
    layer.appendChild(span);
  }
  // 点击选整块（Reader 2026-09-23 拍板）：MinerU 4.0.2 公开输出无行级几何（Reader 亲核源码确认），
  // 拖选在块级语义下天然残缺；点击时程序化合成整块选区，沿 selectionchange 链路复用既有
  // popover / Selected Passage / Evidence 流程。层随重挂重建，监听不累积。
  layer.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const span = target.closest<HTMLElement>("span");
    if (!span || !layer.contains(span)) return;
    const selection = window.getSelection();
    // 用户在块内拖出的部分选区（含双击选词）予以尊重；点击另一块或空白选区时替换为整块。
    if (selection && !selection.isCollapsed && selection.rangeCount > 0 && selection.getRangeAt(0).intersectsNode(span)) return;
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(span);
    selection.removeAllRanges();
    selection.addRange(range);
  });
  page.appendChild(layer);
  // 布局就绪后逐块拟合字号；测试与隐藏页无布局，fitSpanFontSize 内部自行跳过。
  for (const span of layer.querySelectorAll<HTMLElement>("span")) fitSpanFontSize(span);
  return true;
}
