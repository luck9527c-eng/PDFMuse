import type {
  ConversationEvidence,
  RunDiagnostics,
  RunDiagnosticsRequest,
  RunDiagnosticsTimelineEntry,
  RunDiagnosticsToolCall,
  RunDiagnosticsUsage,
} from "../../shared/contracts.js";
import type { Message, StreamFn } from "./openclaw-core.js";

/** 每本书保留的最近运行数与单快照截断上限；仅内存，不落盘。 */
const RUNS_PER_BOOK = 20;
const SNAPSHOT_MAX_CHARS = 200_000;

type DiagnosticsStore = {
  list(bookId: string): RunDiagnostics[];
  record(bookId: string, run: RunDiagnostics): void;
  find(bookId: string, runId: string): RunDiagnostics | undefined;
};

/** 运行诊断的内存环形缓冲：按书分组，每书最近 RUNS_PER_BOOK 次。 */
export function createDiagnosticsStore(): DiagnosticsStore {
  const byBook = new Map<string, RunDiagnostics[]>();
  return {
    list(bookId) {
      return byBook.get(bookId) ?? [];
    },
    record(bookId, run) {
      const runs = byBook.get(bookId) ?? [];
      const existing = runs.findIndex((item) => item.runId === run.runId);
      if (existing >= 0) runs.splice(existing, 1, run);
      else runs.push(run);
      while (runs.length > RUNS_PER_BOOK) runs.shift();
      byBook.set(bookId, runs);
    },
    find(bookId, runId) {
      return (byBook.get(bookId) ?? []).find((item) => item.runId === runId);
    },
  };
}

/** 图片块替换为占位说明，避免截图 base64 撑爆快照。 */
function redactContent(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    if (typeof block === "object" && block !== null && (block as { type?: string }).type === "image") {
      const image = block as { mimeType?: string; data?: string };
      const kilobytes = image.data ? Math.round(image.data.length * 3 / 4 / 1024) : 0;
      return `[图片已省略：${image.mimeType ?? "unknown"}，约 ${kilobytes} KB]`;
    }
    return block;
  });
}

function truncateText(value: string) {
  return value.length > SNAPSHOT_MAX_CHARS ? `${value.slice(0, SNAPSHOT_MAX_CHARS)}…（已截断）` : value;
}

export function serializeDiagnosticsMessages(messages: readonly Message[]): unknown[] {
  return messages.map((message) => ({
    role: message.role,
    content: redactContent(
      typeof message.content === "string" ? message.content : (message.content as unknown[]),
    ),
  }));
}

/** 一次运行内共享的采集器：请求快照按调用序号递增，时间线与工具调用按事件追加。 */
export function createRunCollector(input: {
  runId: string;
  sessionId: string;
  question: string;
}): {
  run: RunDiagnostics;
  nextRequest(role: RunDiagnosticsRequest["role"], model: string, systemPrompt: string, messages: readonly Message[], toolNames: string[]): RunDiagnosticsRequest;
  completeRequest(callIndex: number, durationMs: number, usage?: RunDiagnosticsUsage): void;
  recordTool(toolCall: RunDiagnosticsToolCall): void;
  pushTimeline(kind: RunDiagnosticsTimelineEntry["kind"], detail: string): void;
  finish(status: RunDiagnostics["status"]): void;
} {
  const run: RunDiagnostics = {
    runId: input.runId,
    sessionId: input.sessionId,
    question: input.question,
    startedAt: new Date().toISOString(),
    status: "running",
    requests: [],
    toolCalls: [],
    timeline: [],
  };
  const startedAtMs = Date.now();

  return {
    run,
    nextRequest(role, model, systemPrompt, messages, toolNames) {
      const request: RunDiagnosticsRequest = {
        callIndex: run.requests.length,
        role,
        model,
        systemPrompt: truncateText(systemPrompt),
        messages: serializeDiagnosticsMessages(messages),
        toolNames,
        startedAt: new Date().toISOString(),
      };
      run.requests.push(request);
      run.timeline.push({ at: request.startedAt, kind: "request", detail: `${role} · ${model}` });
      return request;
    },
    completeRequest(callIndex, durationMs, usage) {
      const request = run.requests.find((item) => item.callIndex === callIndex);
      if (request) {
        request.durationMs = durationMs;
        if (usage) request.usage = usage;
      }
      run.timeline.push({ at: new Date().toISOString(), kind: "request-complete", detail: `第 ${callIndex + 1} 次调用完成` });
    },
    recordTool(toolCall) {
      run.toolCalls.push(toolCall);
    },
    pushTimeline(kind, detail) {
      run.timeline.push({ at: new Date().toISOString(), kind, detail });
    },
    finish(status) {
      run.status = status;
      run.totalDurationMs = Date.now() - startedAtMs;
      run.timeline.push({ at: new Date().toISOString(), kind: "run-end", detail: `${status} · 共 ${run.totalDurationMs}ms（含本地处理）` });
    },
  };
}

export type DiagnosticsRequestEvent = {
  stream: "diagnostics";
  kind: "request";
  runId: string;
  sessionId: string;
  request: RunDiagnosticsRequest;
};

/**
 * 包装模型流：每次调用即记录请求快照并实时推送。
 * makeInner 惰性求值，未真正发起模型调用的包装实例不消耗底层工厂。
 */
export function wrapStreamFnWithDiagnostics(
  makeInner: () => StreamFn,
  nextRole: () => RunDiagnosticsRequest["role"],
  collector: ReturnType<typeof createRunCollector>,
  emit: (event: DiagnosticsRequestEvent) => void,
  onInvoke?: () => void,
): StreamFn {
  return async (model, context, options) => {
    onInvoke?.();
    const request = collector.nextRequest(nextRole(), model.id || model.name || "", context.systemPrompt ?? "", context.messages, context.tools?.map((tool) => tool.name) ?? []);
    emit({ stream: "diagnostics", kind: "request", runId: collector.run.runId, sessionId: collector.run.sessionId, request });
    return makeInner()(model, context, options);
  };
}

/** 从 openclaw Usage 提取诊断用量；缺失字段按 0 处理。 */
export function toDiagnosticsUsage(usage: { input?: number; output?: number; totalTokens?: number } | undefined): RunDiagnosticsUsage | undefined {
  if (!usage) return undefined;
  return {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    totalTokens: usage.totalTokens ?? 0,
  };
}

export function truncateToolResult(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  return text.length > SNAPSHOT_MAX_CHARS ? `${text.slice(0, SNAPSHOT_MAX_CHARS)}…（已截断）` : text;
}

export type { ConversationEvidence };
