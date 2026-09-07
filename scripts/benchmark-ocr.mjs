import { spawn } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const corpusPath = path.join(projectRoot, "docs", "193826_计算机组成原理（第3版）.pdf");
const corpusSpecPath = path.join(projectRoot, "docs", "research", "ocr-golden-corpus.md");
const outputPath = path.join(projectRoot, "tmp", "ocr-benchmark", "results.json");
const pythonPath = path.join(projectRoot, "resources", "ocr-runtime", "python.exe");
const workerPath = path.join(projectRoot, "resources", "ocr-worker", "rapidocr_worker.py");
const scale = Number(argument("--scale") ?? 1);

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (!Number.isFinite(scale) || scale < 0.5 || scale > 3) throw new Error("OCR 基准渲染倍率必须介于 0.5 和 3 之间。");

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

async function corpusPages() {
  const explicit = argument("--pages");
  if (explicit) return explicit.split(",").map(Number).filter((page) => Number.isSafeInteger(page) && page > 0);
  const markdown = await readFile(corpusSpecPath, "utf8");
  return [...markdown.matchAll(/^\|\s*(\d+)\s*\|/gm)].map((match) => Number(match[1]));
}

function createWorker() {
  const child = spawn(pythonPath, [workerPath], {
    cwd: projectRoot,
    windowsHide: true,
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" },
  });
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let response;
    try { response = JSON.parse(line); } catch { return; }
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    if (response.ok) request.resolve(response.result);
    else request.reject(new Error(response.message || "OCR Worker 返回失败。"));
  });
  child.once("close", (code) => {
    for (const request of pending.values()) request.reject(new Error(`OCR Worker 意外退出：${code}`));
    pending.clear();
  });
  let sequence = 0;
  return {
    async recognize(input) {
      const id = `benchmark-${++sequence}`;
      const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      const line = `${JSON.stringify({ id, ...input })}\n`;
      if (!child.stdin.write(line)) await new Promise((resolve) => child.stdin.once("drain", resolve));
      return result;
    },
    close() { child.kill(); },
  };
}

const pages = await corpusPages();
if (pages.length === 0) throw new Error("OCR 固定语料清单中没有页码。");
if (new Set(pages).size !== pages.length) throw new Error("OCR 固定语料清单包含重复页码。");
if (!argument("--pages") && pages.length !== 50) throw new Error(`OCR 固定语料必须包含 50 页，当前为 ${pages.length} 页。`);
const bytes = new Uint8Array(await readFile(corpusPath));
const loadingTask = getDocument({ data: bytes });
const document = await loadingTask.promise;
if (pages.some((page) => page > document.numPages)) throw new Error(`OCR 固定语料包含超出 PDF 总页数 ${document.numPages} 的页码。`);
const worker = createWorker();
const results = [];
const benchmarkStarted = performance.now();

try {
  for (const pageNumber of pages) {
    const renderStarted = performance.now();
    const page = await document.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext("2d");
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    const imageData = canvas.toBuffer("image/png").toString("base64");
    const renderMs = performance.now() - renderStarted;
    const ocrStarted = performance.now();
    const recognized = await worker.recognize({ imageData, width: canvas.width, height: canvas.height });
    const ocrMs = performance.now() - ocrStarted;
    const validGeometry = recognized.lines.every((line) => (
      typeof line.text === "string"
      && Number.isFinite(line.confidence) && line.confidence >= 0 && line.confidence <= 1
      && Array.isArray(line.polygon) && line.polygon.length >= 4
      && line.polygon.every((point) => point.x >= 0 && point.x <= canvas.width && point.y >= 0 && point.y <= canvas.height)
    ));
    const result = {
      page: pageNumber,
      width: canvas.width,
      height: canvas.height,
      renderMs: Math.round(renderMs),
      ocrMs: Math.round(ocrMs),
      lines: recognized.lines.length,
      hasText: recognized.lines.length > 0,
      validGeometry,
      meanConfidence: recognized.lines.length
        ? Number((recognized.lines.reduce((sum, line) => sum + line.confidence, 0) / recognized.lines.length).toFixed(4))
        : 0,
      textPreview: recognized.lines.slice(0, 8).map((line) => line.text),
    };
    results.push(result);
    console.log(`第 ${pageNumber} 页：OCR ${result.ocrMs} ms，${result.lines} 行，坐标${validGeometry ? "有效" : "无效"}`);
  }
} finally {
  worker.close();
  await loadingTask.destroy();
}

const ocrTimes = results.map((result) => result.ocrMs);
const report = {
  generatedAt: new Date().toISOString(),
  engine: "RapidOCR 3.9.2 + ONNX Runtime 1.29.0",
  model: "PP-OCRv6-small",
  scale,
  pages: results.length,
  totalMs: Math.round(performance.now() - benchmarkStarted),
  ocr: {
    meanMs: Math.round(ocrTimes.reduce((sum, value) => sum + value, 0) / ocrTimes.length),
    medianMs: Math.round(percentile(ocrTimes, 0.5)),
    p95Ms: Math.round(percentile(ocrTimes, 0.95)),
    maxMs: Math.round(Math.max(...ocrTimes)),
  },
  allGeometryValid: results.every((result) => result.validGeometry),
  allPagesHaveText: results.every((result) => result.hasText),
  results,
};
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`完成 ${report.pages} 页：平均 ${report.ocr.meanMs} ms，P95 ${report.ocr.p95Ms} ms，最长 ${report.ocr.maxMs} ms。`);
if (!report.allGeometryValid || !report.allPagesHaveText) throw new Error("OCR 固定语料未通过文字或坐标校验，详见基准结果。");
