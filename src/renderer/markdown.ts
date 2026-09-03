import DOMPurify from "dompurify";
import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: false });

const HOOKS_INSTALLED = (() => {
  if (typeof window === "undefined") return false;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    // 链接只允许新窗口打开，并切断 referrer。
    if (node instanceof Element && node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noreferrer noopener");
    }
  });
  return true;
})();

export function isMarkdownHooksInstalled() {
  return HOOKS_INSTALLED;
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
