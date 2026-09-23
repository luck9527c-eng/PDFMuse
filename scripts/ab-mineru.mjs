/**
 * MinerU basic 整书跑批（T41 验收）：docs/extracted.pdf → 每页 markdown → MD 对比文档。
 * 与生产同源：同 worker（resources/mineru-worker）、同 MINERU_HOME、同协议。
 * 产出：
 *   docs/ocr-ab/extracted-baseline-mineru.md    肉眼对比用 MD（与 RapidOCR 基线并排）
 *   docs/ocr-ab/extracted-baseline-mineru.json  原始块级数据 + 逐页耗时
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PDF = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, "docs", "extracted.pdf");
const OUT_BASE = process.argv[4] || path.basename(PDF, ".pdf");
const OUT_DIR = path.join(ROOT, "docs", "ocr-ab");
const PYTHON = path.join(ROOT, "resources", "mineru-runtime", "python.exe");
const WORKER = path.join(ROOT, "resources", "mineru-worker", "mineru_worker.py");
const MINERU_HOME = path.join(ROOT, "resources", "mineru-runtime", "home");

mkdirSync(OUT_DIR, { recursive: true });

const child = spawn(PYTHON, [WORKER], {
  cwd: ROOT,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1", MINERU_HOME },
});
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

function recognize(pdfPath, page) {
  return new Promise((resolve, reject) => {
    const id = `p${nextId++}`;
    pending.set(id, { resolve, reject });
    // 对比文档需要每页 markdown（含公式 LaTeX 渲染），显式请求。
    child.stdin.write(`${JSON.stringify({ id, pdfPath, page, markdown: true })}\n`);
  });
}

const total = Number(process.argv[3] || 39);
const startPage = Number(process.argv[5] || 1);
const pages = [];
const t0 = Date.now();
for (let page = startPage; page <= total; page += 1) {
  const start = Date.now();
  const result = await recognize(PDF, page);
  const ms = Date.now() - start;
  pages.push({ page, ms, blocks: result.blocks, markdown: result.markdown });
  console.log(`page ${page}/${total}: ${result.blocks.length} blocks, ${ms}ms`);
}
const totalMs = Date.now() - t0;
child.stdin.end();

const ocrMs = pages.map((p) => p.ms);
// markdown 里的公式/插图兜底图是内联 base64，对肉眼对比是纯噪声，压成占位符。
const stripDataUriImages = (markdown) => markdown.replace(/!\[[^\]]*\]\(data:image\/[^)]+\)/g, "![插图/公式兜底图（省略）]()");
const md = [
  `# MinerU basic（GPU/torch）整书识别：${path.basename(PDF)}`,
  ``,
  `- 生成时间：${new Date().toISOString()}`,
  `- 引擎：MinerU 4.0.2 basic 档 · torch/CUDA 后端（PP-DocLayoutV2 版面 + PP-OCRv6 识别 + PP-FormulaNet 公式 + SlanetPlus 表格）`,
  `- 输入：PDF 原文件按页直读（无渲染倍率参与）`,
  `- 页数：${pages.length}`,
  `- 耗时：总计 ${(totalMs / 1000).toFixed(1)}s，平均 ${(ocrMs.reduce((a, b) => a + b, 0) / pages.length / 1000).toFixed(2)}s/页，最快 ${(Math.min(...ocrMs) / 1000).toFixed(2)}s，最慢 ${(Math.max(...ocrMs) / 1000).toFixed(2)}s`,
  `- 说明：每页文本为 MinerU 官方 markdown 渲染输出（公式为 $...$/$$...$$ LaTeX、表格为 HTML/MD）`,
  ``,
  `---`,
  ...pages.flatMap((p) => [``, `## 第 ${p.page} 页（${p.blocks.length} 块 · ${(p.ms / 1000).toFixed(1)}s）`, ``, stripDataUriImages(p.markdown).trim()]),
].join("\n");

const mdPath = path.join(OUT_DIR, `${OUT_BASE}-mineru.md`);
const jsonPath = path.join(OUT_DIR, `${OUT_BASE}-mineru.json`);
writeFileSync(mdPath, md, "utf8");
writeFileSync(jsonPath, JSON.stringify({ source: PDF, totalMs, pages }, null, 2), "utf8");
console.log(`\nDONE total=${(totalMs / 1000).toFixed(1)}s\nMD: ${mdPath}\nJSON: ${jsonPath}`);
