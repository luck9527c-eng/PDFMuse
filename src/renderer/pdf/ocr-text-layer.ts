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
  for (const line of recognizedPage.lines) {
    const xs = line.polygon.map((point) => point.x);
    const ys = line.polygon.map((point) => point.y);
    if (xs.length < 3 || ys.length < 3 || !line.text.trim()) continue;
    const span = document.createElement("span");
    span.textContent = line.text;
    span.title = `识别置信度 ${Math.round(line.confidence * 100)}%`;
    span.style.left = `${Math.max(0, Math.min(100, Math.min(...xs) / recognizedPage.width * 100))}%`;
    span.style.top = `${Math.max(0, Math.min(100, Math.min(...ys) / recognizedPage.height * 100))}%`;
    span.style.width = `${Math.max(0.5, Math.min(100, (Math.max(...xs) - Math.min(...xs)) / recognizedPage.width * 100))}%`;
    span.style.height = `${Math.max(0.5, Math.min(100, (Math.max(...ys) - Math.min(...ys)) / recognizedPage.height * 100))}%`;
    layer.appendChild(span);
  }
  page.appendChild(layer);
  return true;
}
