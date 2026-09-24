/**
 * 运行预算与循环防护（T50）：一次运行的守卫状态机——Run Budget（全系统唯一扣减点）、
 * 指纹窗口生命周期、软收尾序列（含收尾时限保护）、总时长/静默双计时器。
 * 纯分类与节拍判定住在 loop-detector（纯函数）；本模块持有可变状态并与 agent-host 的
 * streamFn/工具包装层对接。全部数值硬编码常量，不进设置面板（规格 Out of Scope）。
 */

import type { AgentRunExitReason, RunExitInfo } from "../../shared/contracts.js";
import { detectRepeat, makeFingerprintEntry, pushFingerprintEntry, type FingerprintEntry, type RepeatVerdict, type ToolPayload } from "./loop-detector.js";
import type { Context, Message } from "./openclaw-core.js";

/** Run Budget：一问之内模型调用圈数的唯一硬闸（50 圈/问）。 */
export const RUN_BUDGET_TOTAL = 50;
/** ≥45/50 起每圈预警（计数保鲜 45/50、46/50…；到顶圈由到顶文案接管，不再叠预警）。 */
const RUN_BUDGET_WARN_FROM = 45;
/** 每问总时长兜底。 */
const WALL_CLOCK_LIMIT_MS = 20 * 60_000;
/** 静默兜底：无任何事件（流式增量/工具起止/压缩活动）超过该时限视为停滞。 */
const IDLE_LIMIT_MS = 5 * 60_000;
/** 软收尾时限保护：序列开始后总时长宽限。 */
const SOFT_FINAL_GRACE_MS = 3 * 60_000;
/** 软收尾期内单次模型调用的静默上限（收尾自身挂死时中断该次调用）。 */
const SOFT_FINAL_CALL_IDLE_MS = 2 * 60_000;

/** 文案 1 · 90% 预警。 */
export function budgetWarningText(used: number, total: number): string {
  return `系统提示：你已使用 ${used}/${total} 轮。请把重要发现整理好带进最终回答，并继续任务——不要因为这个提示就停下来。`;
}

/** 文案 2 · Run Budget 到顶。 */
export const MAX_ITERATIONS_TEXT =
  "你已经达到最大轮数了。请给出一个最终回复，总结你到目前为止的发现和成果，并说明哪些部分未完成，不要再调用任何工具。";
/** 文案 3 · 收尾第 2 次（共用）。 */
export const SECOND_FINALIZE_TEXT =
  "这是第 2 次要求收尾。你已经不能再调用任何工具了。请现在立刻给出最终回答：总结到目前为止的发现和成果，并说明哪些部分未完成。";
/** 文案 8 · 时限兜底 · 总时长触发。 */
export const WALL_CLOCK_TOTAL_TEXT =
  "系统提示：本次运行已达时间上限 20 分钟。不要再调用任何工具，基于已获取的信息给出最终回答，并说明哪些部分未完成。";
/** 文案 9 · 时限兜底 · 静默触发。 */
export const WALL_CLOCK_IDLE_TEXT =
  "系统提示：已连续 5 分钟无任何事件，视为停滞。不要再调用任何工具，基于已获取的信息给出最终回答，并说明哪些部分未完成。";
/** 软收尾期间工具一律短拒「已达上限」。 */
export const SOFT_FINAL_TOOL_REJECTION = "已达上限：工具调用未执行。请基于已有信息直接给出最终回答。";
/** 软收尾两次最终调用都未换来纯文本回答时的用户可见错误。 */
export const FINAL_EXHAUSTED_MESSAGE = "模型未能按要求给出最终回答，已停止本次运行。";
/** 另起收尾回合时（中断路径）没有专用文案可用的中性收尾指令。 */
const NEUTRAL_FINALIZE_TEXT =
  "请不要再调用任何工具，基于已获取的信息给出最终回答，并说明哪些部分未完成。";

export type GuardTrigger = "max_iterations" | "loop_detected" | "wall_clock_total" | "wall_clock_idle";

export type RunGuardsOptions = {
  /** 测试注入：预算总额（生产 50）。 */
  budgetTotal?: number;
  /** 测试注入：总时长兜底（生产 20 分钟）。 */
  wallClockLimitMs?: number;
  /** 测试注入：静默兜底（生产 5 分钟）。 */
  idleLimitMs?: number;
  /** 测试注入：软收尾宽限（生产 3 分钟）。 */
  softFinalGraceMs?: number;
  /** 测试注入：软收尾单调用静默（生产 2 分钟）。 */
  softFinalCallIdleMs?: number;
  /** 守卫中断在飞模型调用（agent.abort）；宿主注入。 */
  onInterrupt?: () => void;
  /** 守卫事件进诊断时间线；宿主注入。 */
  onGuardEvent?: (detail: string) => void;
};

type AppliedAnnotation = { callId: string; appended: string };

export type ModelCallDecision =
  | { proceed: true; context: Context; annotation?: AppliedAnnotation }
  | { proceed: false; reason: "final-exhausted" };

/**
 * 一次运行一个实例；所有计数与计时随实例（即随问）归零。
 * 扣减不变量：budgetUsed 只在 beginModelCall 一处递增（循环顶唯一落点，先查后扣）。
 */
export function createRunGuards(options: RunGuardsOptions = {}) {
  const budgetTotal = options.budgetTotal ?? RUN_BUDGET_TOTAL;
  const warnFrom = Math.min(RUN_BUDGET_WARN_FROM, budgetTotal - 1);
  const wallClockLimitMs = options.wallClockLimitMs ?? WALL_CLOCK_LIMIT_MS;
  const idleLimitMs = options.idleLimitMs ?? IDLE_LIMIT_MS;
  const softFinalGraceMs = options.softFinalGraceMs ?? SOFT_FINAL_GRACE_MS;
  const softFinalCallIdleMs = options.softFinalCallIdleMs ?? SOFT_FINAL_CALL_IDLE_MS;

  let budgetUsed = 0;
  let window: FingerprintEntry[] = [];
  let softFinal: { trigger: GuardTrigger } | undefined;
  let finalCallsUsed = 0;
  let finalExhausted = false;
  let answered = false;
  let disposed = false;
  let guardTrigger: GuardTrigger | undefined;
  let guardInterrupts = 0;
  /** 待搭下一条（批内最后一条）工具结果送达的注解：90% 预警 / 到顶 / 时限兜底 / 收尾第 2 次。 */
  let pendingAnnotations: string[] = [];
  let lastActivityAt = Date.now();
  let toolFlights = 0;
  let modelFlights = 0;
  let wallClockTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;

  const guardEvent = (detail: string) => options.onGuardEvent?.(detail);

  // 总时长兜底：随实例（每问）起表；静默计时由各事件重置。
  wallClockTimer = setTimeout(() => {
    if (disposed) return;
    trigger("wall_clock_total");
  }, wallClockLimitMs);
  scheduleIdle();

  function clearTimer(timer: ReturnType<typeof setTimeout> | undefined) {
    if (timer) clearTimeout(timer);
  }

  /** 软收尾最终调用全部花完仍无回答（含被静默兜底中断的尝试）。 */
  function finalCallsExhaustedState(): boolean {
    return Boolean(softFinal) && !answered && finalCallsUsed >= 2;
  }

  function scheduleIdle() {
    clearTimer(idleTimer);
    if (disposed) return;
    const limit = softFinal ? softFinalCallIdleMs : idleLimitMs;
    idleTimer = setTimeout(onIdleFire, Math.max(0, lastActivityAt + limit - Date.now()));
  }

  /** 「事件」重置静默计时：流式增量、工具起止、压缩活动、模型调用起点。 */
  function noteActivity() {
    lastActivityAt = Date.now();
    scheduleIdle();
  }

  function onIdleFire() {
    if (disposed) return;
    // 工具在飞豁免静默计时：卡死归 420 秒单次超时管；工具结束时事件会重新起表。
    if (toolFlights > 0) {
      lastActivityAt = Date.now();
      scheduleIdle();
      return;
    }
    if (softFinal) {
      // 收尾期单次调用静默 2 分钟：中断该次调用（工具在飞不适用——已被上方豁免拦下），
      // 由宿主的收尾驱动决定重试或收帐。
      guardEvent("收尾期静默兜底：中断在飞收尾调用");
      options.onInterrupt?.();
      return;
    }
    trigger("wall_clock_idle");
  }

  function enterSoftFinal(trigger: GuardTrigger, annotation?: string) {
    if (softFinal || finalExhausted || answered || disposed) return;
    softFinal = { trigger };
    if (annotation) pendingAnnotations.push(annotation);
    guardEvent(`进入软收尾：${trigger}（最终模型调用不扣预算，最多 2 次）`);
    // 静默兜底切到收尾口径（2 分钟/次）：重排已挂起的 5 分钟表。
    scheduleIdle();
    // 收尾时限保护：宽限内无纯文本回答 → all_retries_exhausted_no_response。
    graceTimer = setTimeout(() => {
      if (answered || disposed || finalExhausted) return;
      finalExhausted = true;
      guardEvent("收尾宽限到期：all_retries_exhausted_no_response");
      options.onInterrupt?.();
    }, softFinalGraceMs);
  }

  /** 触发源 → 到点文案与出口原因的单一映射（文案 8/9 + 出口枚举）。 */
  const TRIGGER_META: Record<GuardTrigger, { copy?: string; exitReason: AgentRunExitReason }> = {
    max_iterations: { exitReason: "max_iterations_reached" },
    loop_detected: { exitReason: "loop_detected" },
    wall_clock_total: { copy: WALL_CLOCK_TOTAL_TEXT, exitReason: "wall_clock_timeout" },
    wall_clock_idle: { copy: WALL_CLOCK_IDLE_TEXT, exitReason: "wall_clock_timeout" },
  };

  function trigger(kind: GuardTrigger) {
    if (softFinal || finalExhausted || answered || disposed) return;
    guardTrigger = kind;
    // 收尾期间不递归触发；到点文案随下一次工具结果送达（或中断后由收尾驱动补递）。
    enterSoftFinal(kind, TRIGGER_META[kind].copy);
    // 模型请求在飞不豁免静默/总时长：中断挂死的调用，交给宿主收尾驱动。
    // 工具在飞时不中断（卡死归 420 秒单次超时管）：旗标在下一圈顶自然接管。
    if (modelFlights > 0 && toolFlights === 0) {
      options.onInterrupt?.();
    }
  }

  /** 把待送达注解追加到上下文末尾最近的工具结果（host 侧克隆副本；库行由宿主同步追加）。 */
  function applyPendingAnnotation(context: Context): { context: Context; annotation?: AppliedAnnotation } {
    if (pendingAnnotations.length === 0) return { context };
    const appended = pendingAnnotations.join("\n\n");
    pendingAnnotations = [];
    const messages = [...context.messages];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index] as Message & { role: string; toolCallId?: string };
      if (message.role !== "toolResult") continue;
      messages[index] = appendTextToMessage(message, appended);
      return { context: { ...context, messages }, annotation: { callId: message.toolCallId ?? "", appended } };
    }
    // 本圈无工具调用则不追加（预警/到顶只搭工具结果）。
    return { context };
  }

  /**
   * 循环顶唯一落点（先查还剩 > 0，再扣 1）：每圈干活之前调用。
   * 到顶/触发进入软收尾；软收尾的最终模型调用不扣预算；两次用尽仍无回答 → 拒绝继续。
   */
  function beginModelCall(context: Context): ModelCallDecision {
    noteActivity();
    if (!softFinal && budgetUsed >= budgetTotal) {
      guardTrigger = "max_iterations";
      enterSoftFinal("max_iterations", MAX_ITERATIONS_TEXT);
    }
    if (!softFinal) {
      budgetUsed += 1;
      if (budgetUsed >= warnFrom && budgetUsed < budgetTotal) {
        pendingAnnotations.push(budgetWarningText(budgetUsed, budgetTotal));
      }
    } else {
      if (finalCallsUsed >= 2) {
        finalExhausted = true;
        guardEvent("软收尾两次最终调用用尽：拒绝继续调用模型");
        return { proceed: false, reason: "final-exhausted" };
      }
      finalCallsUsed += 1;
      if (finalCallsUsed === 2) pendingAnnotations.push(SECOND_FINALIZE_TEXT);
    }
    const applied = applyPendingAnnotation(context);
    return { proceed: true, context: applied.context, ...(applied.annotation ? { annotation: applied.annotation } : {}) };
  }

  return {
    /** 每圈模型调用顶：预算查扣、软收尾转移、注解合成。 */
    beginModelCall,
    /** 工具调用入口：软收尾期间一律短拒。 */
    checkToolCall(): { reject?: string } {
      if (softFinal) return { reject: SOFT_FINAL_TOOL_REJECTION };
      return {};
    },
    /** 已执行且非 error/超时的结果：判定交付形态并入窗（执行即重跑，撞窗后才决定形态）。 */
    recordExecution(input: { callId: string; toolName: string; params: unknown; payload: ToolPayload }): RepeatVerdict {
      const verdict = detectRepeat({
        window,
        toolName: input.toolName,
        callId: input.callId,
        params: input.params,
        payload: input.payload,
      });
      if (verdict.finalizeText) {
        // 循环检测锤：只锤再次落入检出链；收尾文案由宿主作被拒调用的结果送达，
        // 被拒结果不进指纹窗口。
        guardTrigger = "loop_detected";
        enterSoftFinal("loop_detected");
        return verdict;
      }
      window = pushFingerprintEntry(window, makeFingerprintEntry(input));
      return verdict;
    },
    /** 撞窗自愈（强制压缩）落地即清空指纹窗口（扩展 ADR 0010）：清窗后同参按 e=1 全文重取。 */
    clearWindow() {
      window = [];
    },
    /** 事件通知：流式增量 / 工具起止 / 压缩活动。 */
    noteActivity,
    noteToolFlightStart() {
      toolFlights += 1;
      noteActivity();
    },
    noteToolFlightEnd() {
      toolFlights = Math.max(0, toolFlights - 1);
      noteActivity();
    },
    noteModelFlightStart() {
      modelFlights += 1;
    },
    noteModelFlightEnd() {
      modelFlights = Math.max(0, modelFlights - 1);
    },
    /** 宿主在实际发起 abort 时记账：守卫引发的中断不按失败处理（收尾驱动接管）。 */
    noteGuardInterrupt() {
      guardInterrupts += 1;
    },
    /** 模型流以 aborted 收尾时：守卫引发的中断不按失败处理（收尾驱动接管）。 */
    consumeGuardInterrupt(): boolean {
      if (guardInterrupts > 0) {
        guardInterrupts -= 1;
        return true;
      }
      return false;
    },
    /** 该轮已产出最终纯文本回答：此后不再触发任何守卫。 */
    markAnswered() {
      answered = true;
    },
    isAnswered() {
      return answered;
    },
    isFinalExhausted() {
      return finalExhausted;
    },
    /** 软收尾最终调用全部花完仍无回答（含被静默兜底中断的尝试）。 */
    finalCallsExhausted() {
      return finalCallsExhaustedState();
    },
    softFinalTrigger(): GuardTrigger | undefined {
      return softFinal?.trigger;
    },
    /** 守卫中断后是否需要宿主另起收尾回合（原 agent 循环已随中断结束）。 */
    shouldAttemptFinalCall(): boolean {
      return Boolean(softFinal) && !finalExhausted && !answered && finalCallsUsed < 2;
    },
    /** 另起收尾回合时送达的收尾文案：未送达的触发文案优先，其次按次序强化/中性。 */
    finalizeCopyForExtraTurn(): string {
      if (pendingAnnotations.length > 0) {
        const copy = pendingAnnotations.join("\n\n");
        pendingAnnotations = [];
        return copy;
      }
      return finalCallsUsed >= 1 ? SECOND_FINALIZE_TEXT : NEUTRAL_FINALIZE_TEXT;
    },
    roundsUsed() {
      return budgetUsed;
    },
    /** 计算出口并停表；宿主在 run 收尾时调用一次。 */
    finish(failure: { status: "error" | "cancelled" } | undefined): RunExitInfo {
      disposed = true;
      clearTimer(wallClockTimer);
      clearTimer(idleTimer);
      clearTimer(graceTimer);
      const exhausted = finalExhausted || finalCallsExhaustedState();
      const activeTrigger = guardTrigger ?? softFinal?.trigger;
      let exitReason: AgentRunExitReason;
      if (exhausted) exitReason = "all_retries_exhausted_no_response";
      else if (failure?.status === "cancelled") exitReason = "interrupted_by_user";
      else if (failure?.status === "error") exitReason = "error";
      else if (activeTrigger) exitReason = TRIGGER_META[activeTrigger].exitReason;
      else if (softFinal) exitReason = "wall_clock_timeout";
      else if (!answered) exitReason = "unknown";
      else exitReason = "completed";
      return { exitReason, roundsUsed: budgetUsed, roundsTotal: budgetTotal };
    },
  };
}

export type RunGuards = ReturnType<typeof createRunGuards>;

/** 克隆单条消息并把文本追加到末尾（宿主侧副本，vendored 循环状态不受触碰）。 */
function appendTextToMessage(message: Message, appended: string): Message {
  if (typeof message.content === "string") {
    return { ...message, content: `${message.content}\n\n${appended}` } as Message;
  }
  const content = [...message.content];
  const lastIndex = content.length - 1;
  const last = content[lastIndex];
  if (last && last.type === "text") {
    content[lastIndex] = { ...last, text: `${last.text}\n\n${appended}` };
  } else {
    content.push({ type: "text", text: appended });
  }
  return { ...message, content } as Message;
}
