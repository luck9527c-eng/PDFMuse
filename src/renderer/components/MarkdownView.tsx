import { memo, useEffect, useMemo, useRef, useState } from "react";

import {
  loadKatex,
  renderFormula,
  renderMarkdownHtml,
  splitFormulas,
  type MarkdownSegment,
} from "../markdown";
import { splitSettledMarkdown } from "../streaming-markdown";

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

function MarkdownBody({ markdown }: { markdown: string }) {
  const segments = useMemo(() => splitFormulas(markdown), [markdown]);
  if (segments.every((segment: MarkdownSegment) => segment.kind === "text" && !segment.value)) {
    return null;
  }
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === "text"
          ? (segment.value.trim() ? <TextHtml key={index} markdown={segment.value} /> : null)
          : <FormulaSpan key={index} formula={segment.value} display={segment.display} />,
      )}
    </>
  );
}

function TextHtml({ markdown }: { markdown: string }) {
  const html = useMemo(() => renderMarkdownHtml(markdown), [markdown]);
  return <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * 已完成块的稳定渲染：流式期间前缀不随增量变化，memo 让解析与消毒每块只跑一次。
 */
const SettledMarkdown = memo(function SettledMarkdown({ markdown }: { markdown: string }) {
  return <MarkdownBody markdown={markdown} />;
});

/**
 * AI 回答的安全渲染：Markdown/GFM + 代码块 + 惰性加载的 KaTeX 公式，不执行 HTML 或脚本。
 * streaming 时按块切分，每个增量只重新解析尾部活动块。
 */
export function MarkdownView({ markdown, streaming = false }: { markdown: string; streaming?: boolean }) {
  const { settled, active } = useMemo(
    () => (streaming ? splitSettledMarkdown(markdown) : { settled: "", active: markdown }),
    [markdown, streaming],
  );
  if (!settled && !active.trim()) return null;
  return (
    <div className="markdown-view">
      {settled ? <SettledMarkdown markdown={settled} /> : null}
      {active ? <MarkdownBody markdown={active} /> : null}
    </div>
  );
}
