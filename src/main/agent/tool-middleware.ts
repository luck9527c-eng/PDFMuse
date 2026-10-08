import type { AgentTool, AgentToolResult } from "./openclaw-core.js";
import { argsKeyOf, type ToolPayload } from "./loop-detector.js";
import type { RunGuards } from "./run-guards.js";
import type { PersistedToolCall } from "./session-store.js";
import type { ToolExecutionOutcome } from "./tool-registry.js";
import type { RunDiagnosticsToolCall } from "../../shared/contracts.js";
import { truncateToolResult } from "./diagnostics.js";

/**
 * 工具调用中间件链（T62，行为冻结重构）：agent-host 工具包装层的横切关注点分层——
 * 飞行记账（bookend）→ 守卫闸门（gate）→ 联网子额度（quota）→ 落库与交付形态（outcome，
 * 内含 single-flight 与指纹/stub/注解合成）。每层一个职责、独立可测；组合顺序即执行顺序。
 * 各层语义自 T50 工具包装层原样搬移，agent-host 既有测试是不改断言的行为规格。
 */

/** 一次工具调用的贯穿帧：各层共享的只读调用元数据。 */
export type ToolFrame = {
  tool: AgentTool;
  toolCallId: string;
  params: unknown;
  signal?: AbortSignal;
  onUpdate?: Parameters<AgentTool["execute"]>[3];
  startedAt: number;
};

export type ToolLayer = (
  frame: ToolFrame,
  next: (frame: ToolFrame) => Promise<AgentToolResult<unknown>>,
) => Promise<AgentToolResult<unknown>>;

/** 落库与诊断出口：宿主把存储行、诊断事件与快照持久化接到各自的所有权模块。 */
export type ToolCallSink = {
  /** 全保真工具行落库前的追加点（status: executed / rejected / error 由各层决定）。 */
  appendRow(row: Omit<PersistedToolCall, "runId">): void;
  /** 调用起点：诊断时间线 tool-start（飞行记账层触发）。 */
  observeToolStart(frame: ToolFrame): void;
  /** 诊断工具事件：采集器入账 + 时间线 + 实时推送。 */
  observeToolCall(toolCall: RunDiagnosticsToolCall, timeline: { phase: "tool-end"; detail: string }): void;
  /** 诊断快照持久化（执行成功路径每次入账后快照）。 */
  snapshotDiagnostics(): void;
};

/** 软拒绝构造（T50）：被拒行（rejected + is_error）+ 诊断 blocked 标记 + 单文本块结果。 */
function createRejecter(sink: ToolCallSink) {
  return (frame: ToolFrame, text: string): AgentToolResult<unknown> => {
    sink.appendRow({
      callId: frame.toolCallId,
      toolName: frame.tool.name,
      title: frame.tool.label ?? frame.tool.name,
      argumentsJson: JSON.stringify(frame.params),
      resultText: text,
      status: "rejected",
      isError: true,
    });
    const toolCall: RunDiagnosticsToolCall = {
      callId: frame.toolCallId,
      name: frame.tool.name,
      parameters: frame.params,
      resultText: truncateToolResult(text),
      durationMs: Date.now() - frame.startedAt,
      blocked: true,
    };
    sink.observeToolCall(toolCall, { phase: "tool-end", detail: `${frame.tool.name} · 已达上限，拒绝执行` });
    return { content: [{ type: "text", text }], details: undefined };
  };
}

/** 层 1 · 飞行记账：时间线起点 + 守卫的在飞计数（finally 兜底归还）。 */
export function flightBookendLayer(deps: {
  onFlightStart(frame: ToolFrame): void;
  onFlightEnd(frame: ToolFrame): void;
}): ToolLayer {
  return async (frame, next) => {
    deps.onFlightStart(frame);
    try {
      return await next(frame);
    } finally {
      deps.onFlightEnd(frame);
    }
  };
}

/** 层 2 · 守卫闸门：软收尾期间工具全关，一律短拒「已达上限」（不执行、不扣额度）。 */
export function guardGateLayer(deps: {
  guards: Pick<RunGuards, "checkToolCall">;
  reject(frame: ToolFrame, text: string): AgentToolResult<unknown>;
}): ToolLayer {
  return async (frame, next) => {
    const gate = deps.guards.checkToolCall();
    if (gate.reject) return deps.reject(frame, gate.reject);
    return next(frame);
  };
}

/** 层 3 · 联网子额度：执行即扣（模块缓存命中也扣——预算层不窥探工具内部，额度兼任反打转压力）。 */
export function webQuotaLayer(deps: {
  matches(toolName: string): boolean;
  limit: number;
  used(): number;
  onAttempt(): void;
  reject(frame: ToolFrame, text: string): AgentToolResult<unknown>;
}): ToolLayer {
  return async (frame, next) => {
    if (deps.matches(frame.tool.name)) {
      deps.onAttempt();
      if (deps.used() > deps.limit) {
        return deps.reject(frame, `联网额度已用完（${deps.limit} 次），不要再调用 search_web，用已有材料和书内工具继续。`);
      }
    }
    return next(frame);
  };
}

/** 层 4 · 落库与交付形态：single-flight 收敛执行；结果到手后撞指纹窗口决定交付形态——
 *  「byte-identical」是校验过的事实；注解层（额度回显等逐次变化文本）不进指纹哈希。 */
export function outcomeRecordingLayer(deps: {
  sink: ToolCallSink;
  guards: Pick<RunGuards, "recordExecution">;
  reject(frame: ToolFrame, text: string): AgentToolResult<unknown>;
  singleFlight: Map<string, Promise<AgentToolResult<unknown>>>;
}): ToolLayer {
  const { sink, guards, reject, singleFlight } = deps;
  return async (frame, next) => {
    // 并行批同（工具, 参数）single-flight：收敛一次执行，兄弟按到达次序占链位（e=1 全文、e=2 stub）。
    const flightKey = `${frame.tool.name}:${argsKeyOf(frame.params)}`;
    const existingFlight = singleFlight.get(flightKey);
    const execution = existingFlight ?? next(frame);
    if (!existingFlight) singleFlight.set(flightKey, execution);
    const cleanupFlight = () => {
      if (singleFlight.get(flightKey) === execution) singleFlight.delete(flightKey);
    };
    let result: AgentToolResult<unknown>;
    try {
      result = await execution;
    } catch (error) {
      // 执行出错：落 error 行后原样上抛，由 agent 循环合成错误工具结果（单飞兄弟各自落行）。
      cleanupFlight();
      sink.appendRow({
        callId: frame.toolCallId,
        toolName: frame.tool.name,
        title: frame.tool.label ?? frame.tool.name,
        argumentsJson: JSON.stringify(frame.params),
        resultText: error instanceof Error ? error.message : String(error),
        status: "error",
        isError: true,
      });
      throw error;
    }
    cleanupFlight();

    const outcome = (result.details ?? {}) as Partial<ToolExecutionOutcome>;
    const firstTextBlock = result.content.find((block): block is Extract<typeof block, { type: "text" }> => block.type === "text");
    const firstText = firstTextBlock?.text ?? "";
    const imageBlocks = result.content.filter((block): block is Extract<typeof block, { type: "image" }> => block.type === "image");
    const mediaPath = toolMediaPathJson(result.details);
    const recordExecuted = (text: string, isError: boolean) => {
      sink.appendRow({
        callId: frame.toolCallId,
        toolName: frame.tool.name,
        title: frame.tool.label ?? frame.tool.name,
        argumentsJson: JSON.stringify(frame.params),
        // 模型所见即所存：落库 = 最终合成文本（全文/stub + 注解）。
        resultText: text,
        status: "executed",
        isError,
        ...(mediaPath ? { mediaPath } : {}),
      });
      const toolCall: RunDiagnosticsToolCall = {
        callId: frame.toolCallId,
        name: frame.tool.name,
        parameters: frame.params,
        resultText: truncateToolResult(text),
        evidence: outcome.evidence,
        durationMs: Date.now() - frame.startedAt,
      };
      sink.observeToolCall(toolCall, { phase: "tool-end", detail: `${frame.tool.name} · ${toolCall.durationMs}ms` });
      sink.snapshotDiagnostics();
    };
    // 420 秒软超时：软错误结果原样送达（error/超时不进指纹窗口、永不替换）。
    if (outcome.timeout) {
      recordExecuted(firstText, true);
      return result;
    }
    // 执行即重跑：结果到手后撞指纹窗口决定交付形态。
    const payload: ToolPayload = { text: firstText, images: imageBlocks.map((block) => block.data) };
    const verdict = guards.recordExecution({ callId: frame.toolCallId, toolName: frame.tool.name, params: frame.params, payload });
    if (verdict.finalizeText) {
      // 循环检测锤：只锤再次落入检出链；收尾文案作被拒调用的结果送达。
      return reject(frame, verdict.finalizeText);
    }
    const annotations = outcome.annotations ?? [];
    const deliveredText = verdict.delivery === "stub"
      ? `${verdict.stubText ?? ""}${verdict.warningText ? `\n\n${verdict.warningText}` : ""}`
      : `${firstText}${verdict.warningText ? `\n\n${verdict.warningText}` : ""}`;
    // 注解（额度回显）头部合成：注解层不进指纹哈希，但模型所见与落库逐字一致。
    const composed = annotations.length > 0 ? `${annotations.join("\n")}\n${deliveredText}` : deliveredText;
    if (verdict.delivery === "stub") {
      // Result Stub 换掉全部内容块（含图片）；evidence 与媒体引用按真实执行保留在 details。
      recordExecuted(composed, false);
      return { content: [{ type: "text", text: composed }], details: result.details };
    }
    recordExecuted(composed, false);
    if (composed !== firstText && firstTextBlock) {
      const content = result.content.map((block) => (block === firstTextBlock ? { ...block, text: composed } : block));
      return { ...result, content };
    }
    return result;
  };
}

/** 工具结果 details 里的媒体引用 → media_path JSON（`[{"page":N,"path":...}]`；无媒体时 undefined）。 */
function toolMediaPathJson(details: unknown): string | undefined {
  const media = (details as { media?: Array<{ page: number; path: string }> } | undefined)?.media;
  return media && media.length > 0 ? JSON.stringify(media) : undefined;
}

/** 组装完整管线（顺序即执行顺序：bookend → gate → quota → outcome）。 */
export function createToolCallPipeline(deps: {
  sink: ToolCallSink;
  guards: RunGuards;
  webQuota: { matches(toolName: string): boolean; limit: number; used(): number; onAttempt(): void };
  singleFlight: Map<string, Promise<AgentToolResult<unknown>>>;
}): {
  execute(tool: AgentTool, toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: Parameters<AgentTool["execute"]>[3]): Promise<AgentToolResult<unknown>>;
} {
  const reject = createRejecter(deps.sink);
  const layers: ToolLayer[] = [
    flightBookendLayer({
      onFlightStart: (frame) => {
        deps.sink.observeToolStart(frame);
        deps.guards.noteToolFlightStart();
      },
      onFlightEnd: () => deps.guards.noteToolFlightEnd(),
    }),
    guardGateLayer({ guards: deps.guards, reject }),
    webQuotaLayer({ ...deps.webQuota, reject }),
    outcomeRecordingLayer({ sink: deps.sink, guards: deps.guards, reject, singleFlight: deps.singleFlight }),
  ];
  const dispatch = (index: number, frame: ToolFrame): Promise<AgentToolResult<unknown>> => {
    if (index >= layers.length) return frame.tool.execute(frame.toolCallId, frame.params, frame.signal, frame.onUpdate);
    return layers[index]!(frame, (next) => dispatch(index + 1, next));
  };
  return {
    execute(tool, toolCallId, params, signal, onUpdate) {
      return dispatch(0, { tool, toolCallId, params, signal, onUpdate, startedAt: Date.now() });
    },
  };
}
