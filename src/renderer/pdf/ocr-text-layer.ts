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
    if (![x0, y0, x1, y1].every((value) => Number.isFinite(value)) || !block.text.trim()) continue;
    const span = document.createElement("span");
    span.textContent = block.text;
    span.title = blockTypeLabel(block);
    span.dataset.ocrType = block.type;
    // 块级 bbox 为 0-1 归一化坐标，直接换算为页面百分比定位；选中即整块，公式块拿到 LaTeX 原文。
    span.style.left = `${Math.max(0, Math.min(100, x0 * 100))}%`;
    span.style.top = `${Math.max(0, Math.min(100, y0 * 100))}%`;
    span.style.width = `${Math.max(0.5, Math.min(100, (x1 - x0) * 100))}%`;
    span.style.height = `${Math.max(0.5, Math.min(100, (y1 - y0) * 100))}%`;
    layer.appendChild(span);
  }
  page.appendChild(layer);
  return true;
}
