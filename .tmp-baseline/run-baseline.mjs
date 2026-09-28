/**
 * OCR 基线跑批（一次性脚本，不进构建）：docs/extracted.pdf 全部扫描页 → RapidOCR → 每页 MD。
 * 与生产管线同源：同 worker（rapidocr_worker.py）、同渲染倍率（OCR_RENDER_SCALE=1）、同引擎参数。
 * 产出：
 *   docs/ocr-ab/extracted-baseline-rapidocr.md    肉眼对比用 MD
 *   docs/ocr-ab/extracted-baseline-rapidocr.json  原始行级数据 + 逐页耗时
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PDF = path.join(ROOT, "docs", "extracted.pdf");
const OUT_DIR = path.join(ROOT, "docs", "ocr-ab");
const PYTHON = path.join(ROOT, "resources", "ocr-runtime", "python.exe");
const WORKER = path.join(ROOT, "resources", "ocr-worker", "rapidocr_worker.py");
const SCALE = 1; // = src/shared/ocr-config.ts OCR_RENDER_SCALE

mkdirSync(OUT_DIR, { recursive: true });

// —— 复用生产 worker：JSON-lines over stdin/stdout，模型只加载一次 ——
const child = spawn(PYTHON, [WORKER], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (d) => process.stderr.write(`[worker] ${d}`));

const pending = new Map();
let nextId = 1;
let buf = "";
child.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const p = pending.get(msg.id);
    if (!p) continue;
    pending.delete(msg.id);
    msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.message));
  }
});

function ocr(imageData, width, height) {
  return new Promise((resolve, reject) => {
    const id = `p${nextId++}`;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, imageData, width, height }) + "\n");
  });
}

// —— 渲染 + 逐页识别 ——
const loadingTask = getDocument({ url: PDF });
const doc = await loadingTask.promise;
const { createCanvas } = await import("@napi-rs/canvas");
const pages = [];
const t0 = Date.now();

for (let i = 1; i <= doc.numPages; i++) {
  const page = await doc.getPage(i);
  const viewport = page.getViewport({ scale: SCALE });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext("2d");
  await page.render({ canvas: canvas, canvasContext: context, viewport }).promise;
  const imageData = canvas.toBuffer("image/png").toString("base64");

  const start = Date.now();
  const result = await ocr(imageData, canvas.width, canvas.height);
  const ms = Date.now() - start;

  pages.push({ page: i, ms, width: result.width, height: result.height, lines: result.lines });
  console.log(`page ${i}/${doc.numPages}: ${result.lines.length} lines, ${ms}ms`);
}
const totalMs = Date.now() - t0;
await loadingTask.destroy();
child.stdin.end();

// —— 行级结果 → 阅读顺序文本（行聚类成行，行内按 x 排序）——
function readingOrder(lines) {
  const boxes = lines.map((l) => {
    const xs = l.polygon.map((p) => p.x);
    const ys = l.polygon.map((p) => p.y);
    return { text: l.text, x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  });
  if (!boxes.length) return "";
  const heights = boxes.map((b) => b.y1 - b.y0).sort((a, b) => a - b);
  const medH = heights[Math.floor(heights.length / 2)] || 10;
  const tol = Math.max(6, medH * 0.6);
  boxes.sort((a, b) => a.y0 - b.y0);
  const rows = [];
  for (const b of boxes) {
    const cy = (b.y0 + b.y1) / 2;
    const row = rows.find((r) => Math.abs((r.y0 + r.y1) / 2 - cy) <= tol);
    if (row) { row.items.push(b); row.y0 = Math.min(row.y0, b.y0); row.y1 = Math.max(row.y1, b.y1); }
    else rows.push({ y0: b.y0, y1: b.y1, items: [b] });
  }
  rows.sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2);
  return rows.map((r) => r.items.sort((a, b) => a.x0 - b.x0).map((b) => b.text).join(" ")).join("\n");
}

for (const p of pages) p.text = readingOrder(p.lines);

const ocrMs = pages.map((p) => p.ms);
const md = [
  `# OCR 基线（现状管线）：extracted.pdf`,
  ``,
  `- 生成时间：${new Date().toISOString()}`,
  `- 引擎：RapidOCR 3.9.2 / PP-OCRv6-small / onnxruntime 1.29.0（与生产 OCR_INPUT_VERSION 同源）`,
  `- 渲染：pdfjs scale=${SCALE}（= 生产 OCR_RENDER_SCALE）`,
  `- 页数：${pages.length}（全部为扫描页，无原生文本层）`,
  `- OCR 耗时：总计 ${(totalMs / 1000).toFixed(1)}s，平均 ${(ocrMs.reduce((a, b) => a + b, 0) / pages.length / 1000).toFixed(2)}s/页，最快 ${(Math.min(...ocrMs) / 1000).toFixed(2)}s，最慢 ${(Math.max(...ocrMs) / 1000).toFixed(2)}s`,
  `- 说明：文本为行级识别结果按阅读顺序拼接，未做段落/结构重建——这正是现状管线给 AI 的原始形态`,
  ``,
  `---`,
  ...pages.flatMap((p) => [``, `## 第 ${p.page} 页（${p.lines.length} 行 · ${(p.ms / 1000).toFixed(1)}s）`, ``, p.text]),
].join("\n");

const mdPath = path.join(OUT_DIR, "extracted-baseline-rapidocr.md");
const jsonPath = path.join(OUT_DIR, "extracted-baseline-rapidocr.json");
writeFileSync(mdPath, md, "utf8");
writeFileSync(jsonPath, JSON.stringify({ source: PDF, scale: SCALE, totalMs, pages }, null, 2), "utf8");
console.log(`\nDONE total=${(totalMs / 1000).toFixed(1)}s\nMD: ${mdPath}\nJSON: ${jsonPath}`);
