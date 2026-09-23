/**
 * MinerU 产出 MD → 自包含 HTML 质检视图：
 * 1. 全部公式用 KaTeX 逐条排版（浏览器打开即所见），不依赖任何查看器的数学渲染设置；
 * 2. 逐条统计解析失败的公式（真正坏的 LaTeX），输出失败清单与错误样本。
 * 用法：node scripts/md-to-html.mjs <输入.md> [输出.html]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const katex = require("katex");

const INPUT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, "docs", "ocr-ab", "extracted-desktop-mineru.md");
const OUTPUT = process.argv[3] ? path.resolve(process.argv[3]) : INPUT.replace(/\.md$/, ".html");
mkdirSync(path.dirname(OUTPUT), { recursive: true });

const markdown = readFileSync(INPUT, "utf8");

// —— 数学段切分：先收集 $$ 块，再收集行内 $...$，其余文本 HTML 转义 ——
const stats = { display: 0, inline: 0, failed: 0 };
const failures = [];

function renderMath(tex, displayMode) {
  try {
    return katex.renderToString(tex, { displayMode, throwOnError: true, strict: false });
  } catch (error) {
    stats.failed += 1;
    failures.push({ tex: tex.slice(0, 160), error: String(error.message ?? error).slice(0, 200) });
    const fallback = katex.renderToString(tex, { displayMode, throwOnError: false, strict: false });
    return `<span class="math-fail" title="${error.message?.toString().replace(/"/g, "&quot;")}">${fallback}</span>`;
  }
}

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderLine(rawLine) {
  // 先按行内公式切分，再只对非公式文本做 HTML 转义——公式里的 < > 不能被转义。
  const pattern = /\$([^\n$]+)\$/g;
  let result = "";
  let last = 0;
  let match;
  while ((match = pattern.exec(rawLine)) !== null) {
    result += escapeHtml(rawLine.slice(last, match.index));
    stats.inline += 1;
    result += renderMath(match[1], false);
    last = match.index + match[0].length;
  }
  result += escapeHtml(rawLine.slice(last));
  return result;
}

function renderHeading(line) {
  const level = Math.min(line.match(/^#+/)?.[0].length ?? 1, 5);
  const text = escapeHtml(line.replace(/^#+\s*/, ""));
  return `<h${level}>${renderLine(text)}</h${level}>`;
}

const htmlParts = [];
const lines = markdown.split("\n");
let inBlock = false;
let blockLines = [];

function flushBlock() {
  if (!blockLines.length) return;
  const tex = blockLines.join("\n");
  stats.display += 1;
  htmlParts.push(`<div class="display-math">${renderMath(tex, true)}</div>`);
  blockLines = [];
}

for (const line of lines) {
  if (line.trim() === "$$") {
    if (inBlock) { flushBlock(); inBlock = false; }
    else { flushInlinePending(); inBlock = true; }
    continue;
  }
  if (inBlock) { blockLines.push(line); continue; }
  htmlParts.push(line.startsWith("#") ? renderHeading(line) : `<p>${renderLine(line)}</p>`);
}
if (inBlock) flushBlock();

function flushInlinePending() { /* 行内公式按行处理，无需缓冲；占位以支撑结构对称 */ }

const katexCss = readFileSync(path.join(ROOT, "node_modules", "katex", "dist", "katex.min.css"), "utf8");

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${path.basename(INPUT)} · KaTeX 质检视图</title>
<style>${katexCss}</style>
<style>
  body { max-width: 860px; margin: 24px auto; padding: 0 16px; font-family: "Microsoft YaHei", system-ui, sans-serif; color: #222; }
  h1 { font-size: 20px; } h2 { font-size: 16px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  .display-math { overflow-x: auto; }
  .math-fail { outline: 2px solid #d9534f; background: #fdecea; }
  .stats { background: #f6f5f0; border: 1px solid #ddd; border-radius: 6px; padding: 10px 14px; font-size: 13px; }
  .math-fail .katex { color: #a94442; }
</style>
</head>
<body>
<div class="stats">块级公式 ${stats.display} 条 · 行内公式 ${stats.inline} 条 · <b>KaTeX 解析失败 ${stats.failed} 条</b>（红框标出，悬停可见错误）</div>
${htmlParts.join("\n")}
</body>
</html>`;

writeFileSync(OUTPUT, html, "utf8");
const failuresPath = OUTPUT.replace(/\.html$/, "-failures.json");
writeFileSync(failuresPath, JSON.stringify(stats.failed ? failures : [], null, 2), "utf8");
console.log(`块级 ${stats.display} · 行内 ${stats.inline} · 解析失败 ${stats.failed}`);
console.log(`HTML: ${OUTPUT}`);
if (stats.failed) console.log(`失败清单: ${failuresPath}`);
