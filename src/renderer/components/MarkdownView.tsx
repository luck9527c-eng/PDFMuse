import { memo, useEffect, useMemo, useRef } from "react";

import { loadKatex, renderFormula, renderMarkdownWithFormulaSlots } from "../markdown";
import { splitSettledMarkdown } from "../streaming-markdown";

/**
 * Markdown 安全体：GFM + 公式槽位。公式以占位符参与 Markdown 解析（加粗/列表
 * 不被行内公式撕碎），消毒后替换为槽位，此处惰性加载 KaTeX 注水。
 * 注水通过 MutationObserver 自愈：渲染层任何原因重建 innerHTML 后，
 * 新出现的未注水槽位会被自动补注（流式增量期间公式也保持渲染）。
 */
function MarkdownBody({ markdown }: { markdown: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdownWithFormulaSlots(markdown), [markdown]);

  useEffect(() => {
    const container = ref.current;
    if (!container || !html.includes("formula-slot")) return;

    let hydrating = false;
    const hydratePending = () => {
      if (hydrating) return;
      const pending = container.querySelectorAll<HTMLSpanElement>("span.formula-slot:not([data-hydrated])");
      if (pending.length === 0) return;
      hydrating = true;
      void loadKatex().then((katex) => {
        hydrating = false;
        if (!katex) return;
        for (const slot of pending) {
          // 先标记再写入，避免注水自身触发的变更形成循环。
          slot.dataset.hydrated = "1";
          try {
            slot.innerHTML = renderFormula(katex, slot.dataset.formula ?? "", slot.dataset.display === "1");
          } catch {
            // 保留槽位内的原始公式文本作为回退。
          }
        }
      });
    };

    hydratePending();
    const observer = new MutationObserver(hydratePending);
    observer.observe(container, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [html]);

  return <div className="markdown-body" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** 已完成块的稳定渲染：流式期间前缀不随增量变化，memo 让解析与消毒每块只跑一次。 */
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
