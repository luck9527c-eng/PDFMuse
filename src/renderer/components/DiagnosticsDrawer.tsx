import { Bug, X } from "lucide-react";
import { useEffect } from "react";

import type { RunDiagnostics, RunDiagnosticsRequest } from "../../shared/contracts";

const ROLE_LABELS: Record<RunDiagnosticsRequest["role"], string> = {
  main: "主轮",
  "tool-turn": "工具续轮",
  compaction: "摘要轮",
};

const STATUS_LABELS: Record<RunDiagnostics["status"], string> = {
  running: "进行中",
  complete: "已完成",
  error: "出错",
  cancelled: "已停止",
};

function Collapsible({ title, meta, text }: { title: string; meta?: string; text: string }) {
  const lines = text.split("\n").length;
  return (
    <details className="diag-block">
      <summary>
        <span>{title}</span>
        <small>{meta ?? `${lines} 行`}</small>
      </summary>
      <pre className="diag-pre">{text}</pre>
    </details>
  );
}

function RequestSection({ request }: { request: RunDiagnosticsRequest }) {
  return (
    <article className="diag-request">
      <header>
        <span className="diag-badge">{ROLE_LABELS[request.role]}</span>
        <strong>第 {request.callIndex + 1} 次调用 · {request.model}</strong>
        <small>
          {request.durationMs !== undefined ? `${request.durationMs}ms` : "进行中"}
          {request.usage ? ` · tokens ${request.usage.input} 进 / ${request.usage.output} 出 / 共 ${request.usage.totalTokens}` : ""}
        </small>
      </header>
      {request.toolNames.length > 0 && (
        <p className="diag-line">可见工具：{request.toolNames.join("、")}</p>
      )}
      <Collapsible title="System Prompt" meta={`${request.systemPrompt.length} 字符`} text={request.systemPrompt} />
      <Collapsible
        title={`模型消息（${request.messages.length} 条）`}
        text={request.messages.map((message) => JSON.stringify(message, null, 2)).join("\n———\n")}
      />
    </article>
  );
}

/** 运行详情抽屉：请求快照、工具调用、用量耗时与时间线，供 Reader 优化提问与检索。 */
export function DiagnosticsDrawer({
  run,
  onClose,
}: {
  run: RunDiagnostics | undefined;
  onClose(): void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const totalTokens = run?.requests.reduce((total, request) => total + (request.usage?.totalTokens ?? 0), 0);

  return (
    <aside className="diag-drawer" aria-label="运行详情">
      <header className="diag-header">
        <span className="diag-title"><Bug size={14} />运行详情</span>
        <button aria-label="关闭运行详情" onClick={onClose}><X size={15} /></button>
      </header>
      {!run ? (
        <p className="diag-empty">暂无该运行的诊断数据。</p>
      ) : (
        <div className="diag-body">
          <section className="diag-section" aria-label="概要">
            <div className="diag-line"><strong>{run.question || "（运行中）"}</strong></div>
            <div className="diag-line">
              <span className={`diag-badge ${run.status}`}>{STATUS_LABELS[run.status]}</span>
              <small>
                {run.requests.length} 次模型调用 · {run.toolCalls.length} 次工具调用
                {run.totalDurationMs !== undefined ? ` · 总耗时 ${run.totalDurationMs}ms` : ""}
                {totalTokens ? ` · tokens 共 ${totalTokens}` : ""}
              </small>
            </div>
          </section>

          <section className="diag-section" aria-label="模型调用">
            <h4>发给模型的内容</h4>
            {run.requests.length === 0
              ? <p className="diag-empty">尚无请求快照（模型调用尚未发起）。</p>
              : run.requests.map((request) => <RequestSection key={request.callIndex} request={request} />)}
          </section>

          <section className="diag-section" aria-label="工具调用">
            <h4>AI 的工具调用</h4>
            {run.toolCalls.length === 0
              ? <p className="diag-empty">本次运行没有调用工具。</p>
              : run.toolCalls.map((toolCall) => (
                <article className="diag-tool" key={toolCall.callId}>
                  <header>
                    <strong>{toolCall.name}</strong>
                    <small>{toolCall.durationMs}ms{toolCall.evidence?.length ? ` · ${toolCall.evidence.length} 条证据` : ""}</small>
                  </header>
                  <Collapsible title="参数" text={JSON.stringify(toolCall.parameters, null, 2)} />
                  {toolCall.resultText && <Collapsible title="返回结果" text={toolCall.resultText} />}
                </article>
              ))}
          </section>

          <section className="diag-section" aria-label="时间线">
            <h4>时间线</h4>
            <ol className="diag-timeline">
              {run.timeline.map((entry, index) => (
                <li key={index}>
                  <time>{entry.at.slice(11, 23)}</time>
                  <span>{entry.kind}</span>
                  <em>{entry.detail}</em>
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}
    </aside>
  );
}
