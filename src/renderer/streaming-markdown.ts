import { findFenceSpanAt, parseFenceSpans } from "../../vendor/openclaw-agent-core/packages/markdown-core/src/index.js";

/**
 * 流式渲染的稳定切分：已完成的块前缀（settled）与正在生长的尾部块（active）分开，
 * 前缀只在内容变化时解析一次，每个流式增量只重新渲染尾部。
 * 安全边界 = 空行，且不在代码围栏内、不在未闭合的 $$ 公式块内。
 */
export function splitSettledMarkdown(text: string): { settled: string; active: string } {
  const spans = parseFenceSpans(text);
  for (let index = text.lastIndexOf("\n\n"); index >= 0; index = text.lastIndexOf("\n\n", index - 1)) {
    const boundary = index + 2;
    if (findFenceSpanAt(spans, index + 1)) continue;
    if (!hasClosedDisplayFormulas(text.slice(0, boundary))) continue;
    return { settled: text.slice(0, boundary), active: text.slice(boundary) };
  }
  return { settled: "", active: text };
}

function hasClosedDisplayFormulas(prefix: string) {
  return (prefix.split("$$").length - 1) % 2 === 0;
}
