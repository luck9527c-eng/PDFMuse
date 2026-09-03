import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  loadKatex,
  renderFormula,
  renderMarkdownHtml,
  splitFormulas,
  type MarkdownSegment,
} from "../markdown";

function FormulaSpan({ formula, display }: { formula: string; display: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadKatex().then((katex) => {
      if (cancelled || !katex || !ref.current) return;
      try {
        ref.current.innerHTML = renderFormula(katex, formula, display);
      } catch {
        if (!cancelled) setFailed(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [display, formula]);

  if (failed) {
    return <code className="formula-fallback">{formula}</code>;
  }
  return <span className={display ? "formula-display" : "formula-inline"} ref={ref} aria-label="公式" />;
}

function TextHtml({ markdown }: { markdown: string }) {
  const html = useMemo(() => renderMarkdownHtml(markdown), [markdown]);
  return <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** AI 回答的安全渲染：Markdown/GFM + 代码块 + 惰性加载的 KaTeX 公式，不执行 HTML 或脚本。 */
export function MarkdownView({ markdown }: { markdown: string; children?: ReactNode }) {
  const segments = useMemo(() => splitFormulas(markdown), [markdown]);
  if (segments.every((segment: MarkdownSegment) => segment.kind === "text" && !segment.value)) {
    return null;
  }
  return (
    <div className="markdown-view">
      {segments.map((segment, index) =>
        segment.kind === "text"
          ? (segment.value.trim() ? <TextHtml key={index} markdown={segment.value} /> : null)
          : <FormulaSpan key={index} formula={segment.value} display={segment.display} />,
      )}
    </div>
  );
}
