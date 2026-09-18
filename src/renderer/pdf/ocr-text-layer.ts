import type { RecognizedPageText } from "../../shared/contracts";

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
    // 块级 bbox 为 0-1 归一化坐标，直接换算为页面百分比定位。
    span.style.left = `${Math.max(0, Math.min(100, x0 * 100))}%`;
    span.style.top = `${Math.max(0, Math.min(100, y0 * 100))}%`;
    span.style.width = `${Math.max(0.5, Math.min(100, (x1 - x0) * 100))}%`;
    span.style.height = `${Math.max(0.5, Math.min(100, (y1 - y0) * 100))}%`;
    layer.appendChild(span);
  }
  page.appendChild(layer);
  return true;
}
