import DOMPurify from "dompurify";
import { marked } from "marked";

import { parseFenceSpans } from "../../vendor/openclaw-agent-core/packages/markdown-core/src/index.js";

marked.setOptions({ gfm: true, breaks: false });

if (typeof window !== "undefined") {
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    // 链接只允许新窗口打开，并切断 referrer。
    if (node instanceof Element && node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noreferrer noopener");
    }
  });
}

/** Markdown -> 安全 HTML；禁止脚本、事件处理器和危险协议。 */
export function renderMarkdownHtml(markdown: string): string {
  const raw = marked.parse(markdown, { async: false });
  if (typeof window === "undefined") return raw;
  return DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "form", "input", "textarea", "button", "iframe", "object", "embed"],
    FORBID_ATTR: ["style"],
  });
}

/** 识别 $$...$$ 与 $...$ 公式段；先摘出公式再走 Markdown，避免 LaTeX 语法被 Markdown 改写。 */
export type MarkdownSegment = { kind: "text"; value: string } | { kind: "formula"; value: string; display: boolean };

const FORMULA_PATTERN = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;

export function splitFormulas(markdown: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  let lastIndex = 0;
  for (const match of markdown.matchAll(FORMULA_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      segments.push({ kind: "text", value: markdown.slice(lastIndex, index) });
    }
    if (match[1] !== undefined) {
      segments.push({ kind: "formula", value: match[1].trim(), display: true });
    } else if (match[2] !== undefined) {
      segments.push({ kind: "formula", value: match[2].trim(), display: false });
    }
    lastIndex = index + match[0].length;
  }
  if (lastIndex < markdown.length) {
    segments.push({ kind: "text", value: markdown.slice(lastIndex) });
  }
  return segments;
}

/**
 * 公式占位符渲染：先把公式替换为纯文本占位符再走 Markdown 解析，
 * 保证含行内公式的加粗/斜体/列表不被撕碎（段落结构完整），
 * 消毒后再把占位符替换为 KaTeX 槽位（由视图层异步注水）。
 * 围栏代码块与行内代码中的 $ 不视为公式。
 */
const PLACEHOLDER_PREFIX = "PMFRM";
const INLINE_CODE_PATTERN = /`[^`\n]+`/g;

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function renderMarkdownWithFormulaSlots(markdown: string): string {
  const masked: Array<[number, number]> = [];
  const fenceSpans = parseFenceSpans(markdown);
  for (const span of fenceSpans) masked.push([span.start, span.end]);
  for (const match of markdown.matchAll(INLINE_CODE_PATTERN)) {
    masked.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
  }
  const inMaskedRegion = (index: number) => masked.some(([start, end]) => index >= start && index < end);

  const slots: Array<{ formula: string; display: boolean; placeholder: string }> = [];
  let text = "";
  let lastIndex = 0;
  for (const match of markdown.matchAll(FORMULA_PATTERN)) {
    const index = match.index ?? 0;
    if (inMaskedRegion(index)) continue;
    const placeholder = `${PLACEHOLDER_PREFIX}${slots.length}`;
    slots.push({
      formula: (match[1] ?? match[2] ?? "").trim(),
      display: match[1] !== undefined,
      placeholder,
    });
    text += markdown.slice(lastIndex, index) + placeholder;
    lastIndex = index + match[0].length;
  }
  text += markdown.slice(lastIndex);

  let html = renderMarkdownHtml(text);
  for (const slot of slots) {
    const slotHtml = `<span class="formula-slot ${slot.display ? "formula-display" : "formula-inline"}" data-formula="${escapeHtml(slot.formula)}" data-display="${slot.display ? 1 : 0}">$${escapeHtml(slot.formula)}$</span>`;
    html = html.split(slot.placeholder).join(slotHtml);
  }
  return html;
}

let katexLoader: Promise<typeof import("katex") | undefined> | undefined;
let katexCssLoaded = false;

/** 惰性加载 KaTeX；只有出现公式时才拉取渲染器和字体样式。 */
export async function loadKatex() {
  if (typeof document === "undefined") return undefined;
  if (!katexLoader) {
    katexLoader = import("katex").then((katex) => {
      if (!katexCssLoaded) {
        katexCssLoaded = true;
        void import("katex/dist/katex.min.css");
      }
      return katex;
    });
  }
  return katexLoader;
}

export function renderFormula(katex: typeof import("katex"), formula: string, display: boolean): string {
  return katex.renderToString(formula, {
    displayMode: display,
    throwOnError: false,
    strict: false,
    trust: false,
  });
}
