import { Bug, RefreshCw } from "lucide-react";
import { memo } from "react";

import type { ConversationMessage } from "../../shared/contracts";
import { MarkdownView } from "./MarkdownView";

function ConversationReferenceTags({ pages, onOpen }: { pages: number[]; onOpen(page: number): void }) {
  if (pages.length === 0) return null;
  return (
    <div className="evidence-tags">
      <span className="evidence-tags-label">参考：</span>
      {pages.map((page) => (
        <button key={page} className="evidence-tag" onClick={() => onOpen(page)}>第 {page} 页</button>
      ))}
    </div>
  );
}

/**
 * 会话消息项。memo 化后，流式增量触发的整树重渲染会跳过所有已完成消息，
 * 只有正在生成的气泡与新增消息真正重新渲染。
 */
export const ConversationMessageItem = memo(function ConversationMessageItem({
  message,
  referencePages,
  onRetry,
  onOpenPage,
  onOpenDiagnostics,
}: {
  message: ConversationMessage;
  referencePages: number[];
  onRetry(message: ConversationMessage): void;
  onOpenPage(page: number): void;
  onOpenDiagnostics(message: ConversationMessage): void;
}) {
  return (
    <article className={`message ${message.role}`}>
      <div className="message-role">
        <span>{message.role === "reader" ? "你" : "PDFMuse"}</span>
        <button
          className="diag-entry"
          aria-label="查看运行详情"
          title="查看运行详情（发给模型的内容与 AI 的行为）"
          onClick={() => onOpenDiagnostics(message)}
        ><Bug size={12} /></button>
      </div>
      {message.role === "reader" ? (
        <>
          <p>{message.body}</p>
          {message.passage && <div className="passage-quote">引用原文 · 第 {message.passage.page} 页</div>}
        </>
      ) : (
        <>
          {message.body ? <MarkdownView markdown={message.body} /> : null}
          {message.status === "error" && (
            <div className="message-failure" role="alert">
              <span>{message.errorMessage ?? "回答生成失败。"}</span>
              <button className="secondary-command retry-command" onClick={() => onRetry(message)}><RefreshCw size={12} />重试</button>
            </div>
          )}
          {message.status === "cancelled" && message.body && <div className="message-interrupted">回答已停止，以上为已生成内容。</div>}
          <ConversationReferenceTags pages={referencePages} onOpen={onOpenPage} />
        </>
      )}
    </article>
  );
});
