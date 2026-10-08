import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type {
  AgentStreamEvent,
  AgentImageAttachment,
  ConversationEvidence,
  ConversationMessage,
  ReadingFocus,
  RunExitInfo,
  StartAgentRunInput,
  StartAgentRunResult,
} from "../../shared/contracts.js";
import { CONVERSATION_EVIDENCE_MAX, DEFAULT_MODEL_CONTEXT_WINDOW, MAX_AGENT_IMAGE_ATTACHMENTS, MAX_AGENT_IMAGE_BYTES, MAX_AGENT_IMAGE_TOTAL_BYTES } from "../../shared/contracts.js";
import {
  createRunGuards,
  FINAL_EXHAUSTED_MESSAGE,
  type RunGuards,
  type RunGuardsOptions,
} from "./run-guards.js";
import {
  assistantText,
  assistantReplayMessage,
  buildQuestionContent,
  buildReplayMessages,
  buildSystemPrompt,
  computeElisionDeduction,
  estimatingImageLoader,
  historyToLlmMessages,
  resolveRetainedRunIds,
  synthesizeToolPairMessagesForSummary,
  toSessionEntries,
  type ElisionProjection,
  type ReplayImageLoader,
} from "./context-assembly.js";
import { createModelStreamFn, normalizeModelError, parseContextWindowError, toLlmModel, type ContextWindowError, type ResolvedModelConnection } from "./model-runtime.js";
import { checkCitations } from "./citation-check.js";
import { MAX_SEARCH_WEB_CALLS, type PageImageBudget } from "./tool-registry.js";
import { createToolCallPipeline } from "./tool-middleware.js";
import {
  Agent,
  compact,
  DEFAULT_COMPACTION_SETTINGS,
  estimateStringChars,
  estimateTokens,
  estimateTokensFromChars,
  findCutPoint,
  shouldCompact,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type AgentToolResult,
  type CompactionPreparation,
  type CompactionResult,
  type CompactionSettings,
  type Message,
  type SessionTreeEntry,
  type StreamFn,
} from "./openclaw-core.js";
import { createSessionStore, type PersistedToolCall, type SessionStore } from "./session-store.js";
import {
  createDiagnosticsStore,
  createRunCollector,
  toDiagnosticsUsage,
  wrapStreamFnWithDiagnostics,
} from "./diagnostics.js";
import type { RunDiagnostics } from "../../shared/contracts.js";

export type AgentHostOptions = {
  dataHome: string;
  /** 注入组装根创建的会话存储（清理钩子与检索读接口在创建时接线）；缺省时自建。 */
  store?: SessionStore;
  loadModelConnection(): Promise<ResolvedModelConnection | undefined>;
  /** Reader Profile 只读注入；没有 Profile 时返回空字符串。 */
  loadReaderProfile?(): Promise<string>;
  /** 当前书名由 Main 侧 Library 提供，不信任 Renderer 自报书名。 */
  loadBookTitle?(bookId: string): string | undefined | Promise<string | undefined>;
  /** 当前页所在章节由 Main 侧 Book Outline 解析，注入 Reading Focus 帮模型定位相对引用。 */
  resolveReadingSection?(bookId: string, page: number): string | undefined | Promise<string | undefined>;
  /** 已索引页文本读接口（T64 引用落地校验）：undefined = 该页未建立索引；缺省不校验。 */
  readIndexedPageText?(bookId: string, page: number): string | undefined;
  /** 当前页所在顶层章节页码范围由 Main 侧解析，只用于检索加权，不进模型可见文字。 */
  resolveChapterRange?(bookId: string, page: number): { from: number; to: number } | undefined | Promise<{ from: number; to: number } | undefined>;
  /** Book 所有权验证：伪造的 bookId 不允许建立会话。 */
  isKnownBook?(bookId: string): boolean | Promise<boolean>;
  /** 为一次运行构造可见工具；工具通过 reportEvidence 上报检索证据。 */
  buildTools?(context: {
    bookId: string;
    focus?: ReadingFocus;
    reportEvidence(evidence: ConversationEvidence[]): void;
    /** 本问（一次运行）共享的原图页预算：页数与次数钳制在工具层执行。 */
    pageBudget: PageImageBudget;
  }): AgentTool[];
  emit(event: AgentStreamEvent): void;
  /** 运行守卫注入（T50 测试）：Run Budget 总额、时限兜底与软收尾时限的生产默认值见 run-guards 常量。 */
  guardOptions?: RunGuardsOptions;
  /** OpenClaw compaction trigger and retention can be lowered in tests or constrained deployments. */
  compactionContextWindow?: number;
  compactionSettings?: Partial<CompactionSettings>;
  /** 摘要请求硬超时（T43）；缺省 180s。到点中断压缩并按失败处理（fail-open 保持原历史）。 */
  compactionTimeoutMs?: number;
  /** 摘要重试退避基数（T43 测试注入）；生产默认 500ms，按尝试指数递增、5s 封顶。 */
  compactionRetryBaseDelayMs?: number;
  /** 测试注入假模型流；生产默认使用 @openclaw/ai Provider Adapter。 */
  createStreamFn?: (connection: ResolvedModelConnection) => StreamFn;
};

const QUESTION_MAX_LENGTH = 8_000;
const PASSAGE_MAX_LENGTH = 20_000;
/** 压缩冷却递增档（ADR 0010）：压缩后仍接近阈值时按会话进入冷却，防止每问白打一次摘要调用。 */
const COMPACTION_COOLDOWN_STEPS_MS = [60_000, 300_000, 900_000];
/** 摘要请求硬超时（T43）：挂死的摘要调用不得占住会话 lane；到点中断并按失败处理（fail-open）。 */
const COMPACTION_TIMEOUT_MS = 180_000;
/** 摘要重试（T43）：共 3 次尝试，指数退避 500ms 起、5s 封顶；aborted（取消/超时）与 invalid_session 不重试。 */
const COMPACTION_RETRY_ATTEMPTS = 3;
const COMPACTION_RETRY_BASE_DELAY_MS = 500;
const COMPACTION_RETRY_MAX_DELAY_MS = 5_000;
/** 领域摘要指令（T43）：经 compact() 的 customInstructions 进入摘要请求（vendored 侧追加为 "Additional focus:"）。 */
const COMPACTION_DOMAIN_INSTRUCTIONS = [
  "这是 PDF 书籍阅读问答会话的摘要，供后续继续辅导 Reader。",
  "必须保留：读者每个问题的要点；回答已确认的书内结论；出现的页码、原文引用与术语（逐字精确，不得改写）；检索得到的关键发现。",
  "省略寒暄与重复；不得引入会话中不存在的信息。",
].join("\n");
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReadingFocus(value: unknown): value is ReadingFocus {
  if (!isRecord(value)) return false;
  const currentPage = value.currentPage;
  if (typeof currentPage !== "number" || !Number.isSafeInteger(currentPage) || currentPage <= 0) return false;
  if (value.selectedPassage !== undefined) {
    const passage = value.selectedPassage;
    if (!isRecord(passage)) return false;
    const page = passage.page;
    if (typeof page !== "number" || !Number.isSafeInteger(page) || page <= 0) return false;
    const text = passage.text;
    if (typeof text !== "string" || text.length === 0 || text.length > PASSAGE_MAX_LENGTH) return false;
  }
  return true;
}

function isBookId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isStartInput(value: Record<string, unknown>): value is StartAgentRunInput {
  return isBookId(value.bookId) && typeof value.question === "string";
}

function base64ByteLength(value: string) {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.floor(value.length * 3 / 4) - padding;
}

/** 图片只在当前请求内存在，严格限制格式和大小，避免借 IPC 注入任意内容。 */
function parseAttachments(value: unknown): AgentImageAttachment[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_AGENT_IMAGE_ATTACHMENTS) return null;
  const ids = new Set<string>();
  let totalBytes = 0;
  const attachments: AgentImageAttachment[] = [];
  for (const item of value) {
    if (!isRecord(item)
      || typeof item.id !== "string" || item.id.length === 0 || item.id.length > 128
      || ids.has(item.id)
      || (item.mimeType !== "image/png" && item.mimeType !== "image/jpeg"
        && item.mimeType !== "image/webp" && item.mimeType !== "image/gif")
      || typeof item.data !== "string" || !BASE64_PATTERN.test(item.data)
      || item.data.length === 0) {
      return null;
    }
    const bytes = base64ByteLength(item.data);
    if (bytes <= 0 || bytes > MAX_AGENT_IMAGE_BYTES || totalBytes + bytes > MAX_AGENT_IMAGE_TOTAL_BYTES) return null;
    ids.add(item.id);
    totalBytes += bytes;
    attachments.push({ id: item.id, mimeType: item.mimeType, data: item.data });
  }
  return attachments;
}

type ActiveRun = {
  sessionId: string;
  agent: Agent;
  cancelledByUser: boolean;
};

type AssistantFailure = { status: "error" | "cancelled"; message?: string };

/** 错误/取消的回答不进入模型上下文，与 context-assembly 的可用性过滤保持同一规则。 */

export function createAgentHost(options: AgentHostOptions) {
  const store: SessionStore = options.store ?? createSessionStore(options.dataHome);
  // 压缩阈值基准：显式注入优先（测试），否则每轮按模型连接的 contextWindow 现算（T36）。
  const injectedContextWindow = options.compactionContextWindow;
  const compactionSettings: CompactionSettings = {
    ...DEFAULT_COMPACTION_SETTINGS,
    ...options.compactionSettings,
  };
  // T43：摘要请求的硬超时与重试退避基数；压缩阶段（含撞窗自愈）可被取消即时中断。
  const compactionTimeoutMs = options.compactionTimeoutMs ?? COMPACTION_TIMEOUT_MS;
  const compactionRetryBaseDelayMs = options.compactionRetryBaseDelayMs ?? COMPACTION_RETRY_BASE_DELAY_MS;
  const compactionControllers = new Map<string, AbortController>();
  const makeStreamFn = options.createStreamFn ?? createModelStreamFn;
  // 每个 Book Conversation 一条串行 lane；lane 尾部为空时移除，避免长期驻留。
  const sessionLanes = new Map<string, Promise<void>>();
  const activeRuns = new Map<string, ActiveRun>();
  const runBooks = new Map<string, { bookId: string; sessionId: string }>();
  const cancelledBeforeStart = new Set<string>();
  // 运行诊断的内存环形缓冲：常开捕获，按书保留最近若干次运行。
  const diagnosticsStore = createDiagnosticsStore();
  // 撞窗自愈修正的生效窗口（ADR 0010）：provider 报告的真实上限，进程级全局生效，不写回用户配置。
  let effectiveWindowOverride: number | undefined;
  // 压缩冷却：per session 内存态，重启归零；压缩后仍接近阈值时进入，防止每问白打一次摘要调用。
  const compactionCooldowns = new Map<string, { level: number; until: number }>();

  // T45：回放媒体加载——缺失降级占位文本（媒体目录被移动是便携分发下的现实场景）。
  const replayImageLoader: ReplayImageLoader = async (relativePath) => {
    try {
      return (await readFile(path.join(options.dataHome, "media", relativePath))).toString("base64");
    } catch {
      return null;
    }
  };

  store.abandonInterruptedMessages("程序中断，回答未完成。");

  function enqueue(sessionId: string, task: () => Promise<void>): Promise<void> {
    const previous = sessionLanes.get(sessionId) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.then(() => undefined, () => undefined);
    sessionLanes.set(sessionId, tail);
    void tail.then(() => {
      if (sessionLanes.get(sessionId) === tail) sessionLanes.delete(sessionId);
    });
    return run;
  }

  /**
   * 摘要调用 + 指数退避重试（T43）：成功返回 CompactionResult，永久失败返回 undefined。
   * 空摘要按 summarization_failed 口径对待；aborted（用户取消/硬超时）与 invalid_session
   * （确定性失败）不重试；fail-open 语义由调用方处理（返回 undefined → 保持原历史照常回答）。
   */
  async function invokeCompactionWithRetry(
    preparation: CompactionPreparation,
    connection: ResolvedModelConnection,
    streamFn: StreamFn,
    signal: AbortSignal | undefined,
  ): Promise<CompactionResult | undefined> {
    for (let attempt = 1; ; attempt += 1) {
      const result = await compact(
        preparation,
        toLlmModel(connection),
        connection.apiKey,
        undefined,
        COMPACTION_DOMAIN_INSTRUCTIONS,
        signal,
        undefined,
        streamFn,
      );
      if (result.ok && result.value.summary.trim()) return result.value;
      const failureCode = result.ok ? "summarization_failed" : result.error.code;
      if (attempt >= COMPACTION_RETRY_ATTEMPTS || signal?.aborted === true || failureCode !== "summarization_failed") {
        return undefined;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(COMPACTION_RETRY_MAX_DELAY_MS, compactionRetryBaseDelayMs * 2 ** (attempt - 1))));
    }
  }

  /** elision 投影（T47）：保留尾与超大行阈值统一解析——压缩估算、回放装配、摘要输入共用同一实例。 */
  function resolveElision(
    history: ConversationMessage[],
    toolCalls: ReadonlyArray<PersistedToolCall>,
    keepRecentEffective: number,
    contextWindow: number,
  ): ElisionProjection {
    return {
      retainedRunIds: resolveRetainedRunIds({ history, toolCalls, tokenBudget: keepRecentEffective }),
      oversizedRowTokenThreshold: Math.max(2_000, Math.floor(contextWindow * 0.25)),
    };
  }

  /** 阈值基准（T36/T46）：连接窗口 + reserve + keepRecent 一并解析，压缩与保留尾共用同一口径。 */
  function resolveEffectiveSettings(connection: ResolvedModelConnection) {
    const contextWindow = injectedContextWindow
      ?? effectiveWindowOverride
      ?? connection.contextWindow
      ?? DEFAULT_MODEL_CONTEXT_WINDOW;
    const effectiveSettings: CompactionSettings = {
      ...compactionSettings,
      reserveTokens: options.compactionSettings?.reserveTokens
        ?? (injectedContextWindow ? compactionSettings.reserveTokens : Math.round(contextWindow * 0.3)),
    };
    const keepRecentEffective = Math.max(
      1,
      Math.min(effectiveSettings.keepRecentTokens, contextWindow - effectiveSettings.reserveTokens - 1_000),
    );
    return { contextWindow, effectiveSettings, keepRecentEffective };
  }

  async function compactHistory(
    sessionId: string,
    history: ConversationMessage[],
    toolCalls: ReadonlyArray<PersistedToolCall>,
    connection: ResolvedModelConnection,
    streamFn?: StreamFn,
    overrides: { force?: boolean; systemPrompt?: string; questionContent?: string; signal?: AbortSignal } = {},
  ): Promise<{ history: ConversationMessage[]; summary?: string }> {
    const previous = store.getSummary(sessionId);
    const previousIndex = previous ? history.findIndex((message) => message.id === previous.throughMessageId) : -1;
    const workingHistory = previousIndex >= 0 ? history.slice(previousIndex + 1) : history;
    const summaryMessage = previous?.summary
      ? [{ role: "user" as const, content: `【Conversation Summary】\n${previous.summary}`, timestamp: 0 }]
      : [];
    const { contextWindow, effectiveSettings, keepRecentEffective } = resolveEffectiveSettings(connection);
    // T47 elision 投影：保留尾外的旧行以占位进上下文（第一段），判定值按投影后口径计算。
    const elision = resolveElision(history, toolCalls, keepRecentEffective, contextWindow);
    // 判断值（ADR 0010）：真实 usage 锚点 + 落锚点后增量（锚点已含 system prompt，不重复计）；
    // 无锚点降级为字符估算，口径计入 system prompt 与当轮问题内容，与锚点口径对齐。
    const systemEstimate = estimateTokensFromChars(estimateStringChars(overrides.systemPrompt ?? ""));
    const questionEstimate = estimateTokensFromChars(estimateStringChars(overrides.questionContent ?? ""));
    const anchor = store.getSessionAnchor(sessionId);
    const anchorIndex = anchor ? history.findIndex((message) => message.id === anchor.throughMessageId) : -1;
    const anchored = Boolean(anchor) && anchor!.model === connection.model && anchorIndex >= 0;
    let contextTokens: number;
    if (anchored && anchor) {
      // 锚点增量（T45/T47）：走 elision 后的回放装配，工具行按 `(created_at, seq)` 计入；
      // 锚点切片从下一 run 起始。锚点覆盖区间内被投影占位的行按「原文 − 占位」扣回（spec 3.5）——
      // 没有扣减项，投影省下的空间反映不到锚点口径，两段式落空。
      const anchorRunIds = new Set(history.slice(0, anchorIndex + 1).map((message) => message.runId));
      const elisionDeduction = computeElisionDeduction({ toolCalls, anchorRunIds, elision });
      const anchorDeltaMessages = await buildReplayMessages({
        history: history.slice(anchorIndex + 1),
        toolCalls,
        loadImage: estimatingImageLoader,
        elision,
      });
      contextTokens = anchor.inputTokens
        - elisionDeduction
        + anchorDeltaMessages.reduce((total, message) => total + estimateTokens(message), 0)
        + questionEstimate;
    } else {
      const workingReplay = await buildReplayMessages({
        history: workingHistory,
        toolCalls,
        loadImage: estimatingImageLoader,
        elision,
      });
      contextTokens = [...summaryMessage, ...workingReplay]
        .reduce((total, message) => total + estimateTokens(message), 0)
        + systemEstimate
        + questionEstimate;
    }
    const unchanged = (): { history: ConversationMessage[]; summary?: string } => (
      { history: workingHistory, ...(previous?.summary ? { summary: previous.summary } : {}) }
    );
    // 冷却（ADR 0010）：冷却期内不压缩、照常回答；强制路径（撞窗自愈）绕过。
    const cooldown = compactionCooldowns.get(sessionId);
    if (!overrides.force && cooldown && Date.now() < cooldown.until) {
      return unchanged();
    }
    if (!overrides.force && !shouldCompact(contextTokens, contextWindow, effectiveSettings)) {
      return unchanged();
    }

    // 重建 OpenClaw 会话树：持久化摘要落成 compaction 边界。
    // T46：切点自建——findCutPoint 之后吸附到 run 边界（读者问题消息），一轮问答整进或整出摘要；
    // firstKeptEntryId 恒为保留 run 的 reader 消息 id，保证 throughMessageId/锚点/水位线按消息 id 回查有效。
    const messageEntries = toSessionEntries(history);
    const boundaryIndex = previous
      ? messageEntries.findIndex((entry) => entry.id === previous.throughMessageId)
      : -1;
    let pathEntries: SessionTreeEntry[] = messageEntries;
    let boundaryStart = 0;
    if (previous && boundaryIndex >= 0 && boundaryIndex + 1 < messageEntries.length) {
      pathEntries = [
        ...messageEntries.slice(0, boundaryIndex + 1),
        {
          type: "compaction",
          id: `compaction-${previous.throughMessageId}`,
          parentId: messageEntries[boundaryIndex]!.id,
          timestamp: messageEntries[boundaryIndex]!.timestamp,
          summary: previous.summary,
          firstKeptEntryId: messageEntries[boundaryIndex + 1]!.id,
          tokensBefore: contextTokens,
        },
        ...messageEntries.slice(boundaryIndex + 1),
      ];
      boundaryStart = boundaryIndex + 2;
    }
    // 小窗口防护的 keepRecent 钳制已并入 resolveEffectiveSettings（T46）。
    const isRunStart = (entry: SessionTreeEntry | undefined) =>
      entry?.type === "message" && entry.message.role === "user";
    let firstKeptIndex: number;
    try {
      const cut = findCutPoint(pathEntries, boundaryStart, pathEntries.length, keepRecentEffective);
      // 先向后吸附（多保留完整 run），尾部落不到 run 起始时回退向前。
      firstKeptIndex = -1;
      for (let index = Math.max(cut.firstKeptEntryIndex, boundaryStart); index < pathEntries.length; index += 1) {
        if (isRunStart(pathEntries[index])) { firstKeptIndex = index; break; }
      }
      if (firstKeptIndex < 0) {
        for (let index = Math.min(cut.firstKeptEntryIndex, pathEntries.length - 1); index >= boundaryStart; index -= 1) {
          if (isRunStart(pathEntries[index])) { firstKeptIndex = index; break; }
        }
      }
    } catch {
      // vendored 切点选择异常时保持原历史（fail-open 与摘要失败同一口径）。
      return unchanged();
    }
    if (firstKeptIndex < 0 || firstKeptIndex <= boundaryStart) {
      // 保留尾覆盖全部可摘要区间：没有可摘要内容，压缩退化为原样。
      return unchanged();
    }
    // T46：摘要输入纳入被摘要 run 的工具行（run 的问题消息之后交织工具对）——
    // 修复「压缩摘要失真」的根源问题；图片块由序列化器替换为省略标记，无需读文件。
    const runIdByMessageId = new Map(history.map((message) => [message.id, message.runId]));
    const summarizedRowsByRun = new Map<string, PersistedToolCall[]>();
    for (const entry of pathEntries.slice(boundaryStart, firstKeptIndex)) {
      if (entry.type !== "message") continue;
      const runId = runIdByMessageId.get(entry.id);
      if (!runId) continue;
      const rows = toolCalls.filter((row) => row.runId === runId);
      if (rows.length > 0) summarizedRowsByRun.set(runId, rows);
    }
    const summarizedMessages: AgentMessage[] = [];
    for (const entry of pathEntries.slice(boundaryStart, firstKeptIndex)) {
      if (entry.type !== "message") continue;
      summarizedMessages.push(entry.message);
      if (entry.message.role === "user") {
        const rows = summarizedRowsByRun.get(runIdByMessageId.get(entry.id) ?? "");
        if (rows) summarizedMessages.push(...(await synthesizeToolPairMessagesForSummary(rows, elision)));
      }
    }
    const preparation: CompactionPreparation = {
      firstKeptEntryId: pathEntries[firstKeptIndex]!.id,
      messagesToSummarize: summarizedMessages,
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: contextTokens,
      ...(previous?.summary ? { previousSummary: previous.summary } : {}),
      fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
      settings: effectiveSettings,
    };
    const compacted = await invokeCompactionWithRetry(
      preparation,
      connection,
      streamFn ?? makeStreamFn(connection),
      overrides.signal,
    );
    if (!compacted) {
      // 摘要是优化，不是回答的前置条件；失败时保持原始消息可用。
      return unchanged();
    }
    const throughEntry = pathEntries[firstKeptIndex - 1];
    if (!throughEntry || throughEntry.type !== "message") {
      return unchanged();
    }
    store.saveSummary(sessionId, compacted.summary, throughEntry.id);
    const nextHistory = history.slice(history.findIndex((message) => message.id === throughEntry.id) + 1);
    // 压缩后仍接近阈值 → 会话进入冷却递增档；降到阈值以下 → 归零。
    // 判断值用纯估算（锚点描述的是压缩前的请求形状，头部重写后已过期），口径含 system prompt 与当轮问题，
    // 按 elision 后的投影计算（T47）。
    const afterMessages = await buildReplayMessages({
      history: nextHistory,
      toolCalls,
      loadImage: estimatingImageLoader,
      elision: resolveElision(nextHistory, toolCalls, keepRecentEffective, contextWindow),
    });
    const afterTokens = estimateTokens({ role: "user", content: `【Conversation Summary】\n${compacted.summary}`, timestamp: 0 })
      + afterMessages.reduce((total, message) => total + estimateTokens(message), 0)
      + systemEstimate
      + questionEstimate;
    if (afterTokens >= contextWindow - effectiveSettings.reserveTokens) {
      const level = (cooldown?.level ?? 0) + 1;
      const delayIndex = Math.min(level - 1, COMPACTION_COOLDOWN_STEPS_MS.length - 1);
      compactionCooldowns.set(sessionId, { level, until: Date.now() + COMPACTION_COOLDOWN_STEPS_MS[delayIndex]! });
    } else {
      compactionCooldowns.delete(sessionId);
    }
    return { history: nextHistory, summary: compacted.summary };
  }

  async function executeRun(input: {
    runId: string;
    sessionId: string;
    bookId: string;
    question: string;
    focus?: ReadingFocus;
    attachments?: AgentImageAttachment[];
    connection: ResolvedModelConnection;
    profile: string;
    bookTitle?: string;
  }) {
    const { runId, sessionId, bookId, question, focus, attachments = [], connection, profile, bookTitle } = input;
    if (cancelledBeforeStart.delete(runId)) {
      // 排队期间被取消：仍保留 Reader 问题，并发出终态让 Renderer 解除占用。
      store.appendMessage({ sessionId, runId, role: "reader", body: question, status: "complete", focus });
      options.emit({ stream: "lifecycle", phase: "cancelled", runId, sessionId });
      return;
    }

    // 运行诊断：常开捕获；主进程内存环形缓冲 + diagnostics 事件实时推送。
    const collector = createRunCollector({ runId, sessionId, question });
    collector.pushTimeline("run-start", "运行开始");
    diagnosticsStore.record(bookId, collector.run);

    // 运行守卫（T50）：Run Budget、指纹窗口、软收尾序列、总时长/静默双计时器——随问归零。
    // onInterrupt 中断在飞模型调用（静默挂死/时限兜底）；守卫事件进诊断时间线。
    const guards: RunGuards = createRunGuards({
      ...options.guardOptions,
      onInterrupt: () => {
        const run = activeRuns.get(runId);
        if (!run) return;
        guards.noteGuardInterrupt();
        run.agent.abort("guard-interrupt");
      },
      onGuardEvent: (detail) => {
        collector.pushTimeline("guard", detail);
        diagnosticsStore.record(bookId, collector.run);
      },
    });

    // Reader 问题先落盘：失败或中断时问题和阅读焦点不丢失。
    const fullHistory = store.listMessages(sessionId);
    // T44：本 run 的工具调用全保真轨迹；声明提前——压缩估算与回放装配都要消费。
    const toolCalls: PersistedToolCall[] = [];
    // T45：历史 run 的工具行（库内读取，按 `(created_at, seq)` 序）——回放装配与压缩估算的消费源。
    const historyToolCalls = store.listToolCalls(sessionId);
    // T47：elision 投影——保留尾外的旧行以占位进上下文（第一段），判定值按投影后口径。
    const { contextWindow, keepRecentEffective } = resolveEffectiveSettings(connection);
    const elision = resolveElision(fullHistory, historyToolCalls, keepRecentEffective, contextWindow);
    let activeCallStartedAt = 0;
    const startCallClock = () => { activeCallStartedAt = Date.now(); };
    // Reading Focus 增强前移到压缩之前：压缩判断值需要当轮问题内容与 system prompt 的估算。
    const sectionTitle = focus ? await options.resolveReadingSection?.(bookId, focus.currentPage) : undefined;
    const chapterRange = focus ? await options.resolveChapterRange?.(bookId, focus.currentPage) : undefined;
    const focusWithContext: ReadingFocus | undefined = focus ? {
      currentPage: focus.currentPage,
      ...(focus.selectedPassage ? { selectedPassage: focus.selectedPassage } : {}),
      ...(sectionTitle ? { sectionTitle } : {}),
      ...(chapterRange ? { chapterRange } : {}),
    } : undefined;
    const questionContent = buildQuestionContent(question, focusWithContext);
    const systemPrompt = buildSystemPrompt(profile, bookTitle ? { title: bookTitle } : undefined);
    // T43：压缩请求带硬超时与取消信号，挂死或用户取消即时中断，不占住会话 lane。
    // 控制器仅伴随压缩窗口（初始压缩与撞窗自愈）；回答阶段无压缩在飞，cancel 走 agent.abort。
    const runCompaction = async (overrides: { force?: boolean }) => {
      const compactionController = new AbortController();
      compactionControllers.set(runId, compactionController);
      try {
        const signal = AbortSignal.any([compactionController.signal, AbortSignal.timeout(compactionTimeoutMs)]);
        // 撞窗自愈（双轴审查修复）：重载会话——当前 run 的读者问题在首次压缩后才落库，
        // 旧 fullHistory 看不见它，合并进来的本轮工具行按 run 归属过滤会被无声丢弃。
        const history = overrides.force ? store.listMessages(sessionId) : fullHistory;
        const rowsForCompaction = overrides.force ? [...historyToolCalls, ...toolCalls] : historyToolCalls;
        return await compactHistory(
          sessionId,
          history,
          rowsForCompaction,
          connection,
          wrapStreamFnWithDiagnostics(() => makeStreamFn(connection), () => "compaction", collector, options.emit, () => {
            startCallClock();
            guards.noteActivity();
          }),
          { ...overrides, systemPrompt, questionContent, signal },
        );
      } finally {
        compactionControllers.delete(runId);
      }
    };
    const compacted = await runCompaction({});
    // T43：重试会产生多条 compaction 请求条目，全部按各自起点补全耗时。
    let recordedCompaction = false;
    for (const request of collector.run.requests) {
      if (request.role !== "compaction" || request.durationMs !== undefined) continue;
      recordedCompaction = true;
      const durationMs = Date.now() - Date.parse(request.startedAt);
      collector.completeRequest(request.callIndex, durationMs);
      options.emit({ stream: "diagnostics", kind: "request-complete", runId, sessionId, callIndex: request.callIndex, durationMs });
    }
    if (recordedCompaction) {
      diagnosticsStore.record(bookId, collector.run);
    }
    const history = compacted.history;
    if (cancelledBeforeStart.delete(runId)) {
      options.emit({ stream: "lifecycle", phase: "cancelled", runId, sessionId });
      return;
    }
    const readerMessage = store.appendMessage({ sessionId, runId, role: "reader", body: question, status: "complete", focus });

    const llmMessages = await historyToLlmMessages(history, historyToolCalls, {
      question,
      focus: focusWithContext,
      attachments,
      summary: compacted.summary,
      loadImage: replayImageLoader,
      elision,
    });
    const questionMessage = llmMessages[llmMessages.length - 1];
    if (!questionMessage) return;

    // 证据聚合：每页只保留相关度最高的一条，总量按分数截断，参考页不随搜索次数膨胀。
    // 回放装配后追问常常零工具调用（上轮原文已在上下文里），但正文仍会写「原文（第 N 页）」——
    // 本轮没有任何工具上报证据时，收尾回退到上一条 complete 回答的证据页，参考页标签不落空；
    // 只要本轮上报过证据就完全以本轮为准，上一轮的旧页码不挤占本轮参考页。
    const evidenceByPage = new Map<number, ConversationEvidence>();
    let toolEvidenceReported = false;
    const inheritedEvidence = [...fullHistory].reverse()
      .find((message) => message.role === "assistant" && message.status === "complete")
      ?.evidence ?? [];
    const reportEvidence = (evidence: ConversationEvidence[]) => {
      toolEvidenceReported = true;
      for (const item of evidence) {
        const existing = evidenceByPage.get(item.page);
        if (!existing || (item.score ?? 0) > (existing.score ?? 0)) evidenceByPage.set(item.page, item);
      }
    };
    const collectEvidence = () => (toolEvidenceReported ? [...evidenceByPage.values()] : inheritedEvidence)
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
      .slice(0, CONVERSATION_EVIDENCE_MAX)
      .sort((left, right) => left.page - right.page);
    const tools = options.buildTools?.({
      bookId: input.bookId,
      focus: focusWithContext,
      reportEvidence,
      // 每问新建：页数额度与复用键随运行生命周期，下一问自动重置（次数上限已删除）。
      pageBudget: { pagesDelivered: 0, deliveredMedia: new Map() },
    }) ?? [];

    // 工具调用管线（T50 语义、T62 分层重构）：飞行记账 → 守卫闸门（软收尾短拒）→
    // 联网子额度 → 落库与交付形态（single-flight、指纹窗口的 Result Stub/警告/循环锤、
    // 注解合成）。层实现与独立单测在 tool-middleware；宿主只提供落库/诊断出口与配额计数。
    let webSearchCalls = 0;
    // 并行批同（工具, 参数）single-flight：收敛一次执行，兄弟按到达次序占链位（e=1 全文、e=2 stub）。
    const singleFlight = new Map<string, Promise<AgentToolResult<unknown>>>();
    // 全保真行已在 executeRun 前段声明（toolCalls），经 recordToolCall 追加。
    const recordToolCall = (row: Omit<PersistedToolCall, "runId">) => {
      toolCalls.push({ runId, ...row });
    };
    // 注解后补：预警/到顶/收尾文案在下一圈模型调用顶追加到对应库行（模型所见即所存）。
    const appendRowText = (callId: string, appended: string) => {
      const row = toolCalls.find((item) => item.callId === callId);
      if (row) row.resultText = row.resultText ? `${row.resultText}\n\n${appended}` : appended;
    };
    const toolPipeline = createToolCallPipeline({
      sink: {
        appendRow: recordToolCall,
        observeToolStart: (frame) => collector.pushTimeline("tool-start", frame.tool.name),
        observeToolCall: (toolCall, timeline) => {
          collector.recordTool(toolCall);
          collector.pushTimeline(timeline.phase, timeline.detail);
          options.emit({ stream: "diagnostics", kind: "tool", runId, sessionId, toolCall });
        },
        snapshotDiagnostics: () => diagnosticsStore.record(bookId, collector.run),
      },
      guards,
      webQuota: {
        matches: (name) => name === "search_web",
        limit: MAX_SEARCH_WEB_CALLS,
        used: () => webSearchCalls,
        onAttempt: () => {
          webSearchCalls += 1;
        },
      },
      singleFlight,
    });
    const diagnosticsTools = tools.map((tool): AgentTool => ({
      ...tool,
      async execute(toolCallId, params, signal, onUpdate) {
        return toolPipeline.execute(tool, toolCallId, params, signal, onUpdate);
      },
    }));

    // agent 循环的轮次角色：首次调用为 main，工具续轮为 tool-turn。
    let firstAgentCall = true;
    const agentStreamFn = wrapStreamFnWithDiagnostics(
      () => makeStreamFn(connection),
      () => {
        const role = firstAgentCall ? "main" as const : "tool-turn" as const;
        firstAgentCall = false;
        return role;
      },
      collector,
      options.emit,
      startCallClock,
    );
    // 循环顶唯一扣减点（T50 Run Budget）：每圈干活之前先查后扣；到顶/触发进软收尾
    // （最终调用不扣预算）；预警/到顶/收尾文案搭上一批最后一条工具结果送达（库行同步追加）。
    const guardedStreamFn: StreamFn = async (model, context, streamOptions) => {
      const decision = guards.beginModelCall(context);
      if (!decision.proceed) {
        // 软收尾两次最终调用用尽：拒绝继续调用模型（宿主按 finalExhausted 覆写收尾文案）。
        throw new Error("soft-final calls exhausted");
      }
      if (decision.annotation) appendRowText(decision.annotation.callId, decision.annotation.appended);
      return agentStreamFn(model, decision.context, streamOptions);
    };

    let assistantMessageId: string | undefined;
    let assistantBody = "";
    // 当前 assistant 消息在累积体中的起点：工具轮会产生多段 assistant 消息，
    // message_end 用整条文本替换时只覆盖本消息的区段，前段回答不得丢失。
    let assistantBodyStart = 0;
    let assistantFailure: AssistantFailure | undefined;
    // 压缩锚点（ADR 0010）：本运行回答路径最后一次模型调用的 provider input；complete 收尾才落库。
    let lastAnswerInput = 0;
    // 撞窗自愈：本轮是否发生了可识别的超窗错误及其携带的真实窗口数。
    let overWindow: ContextWindowError | undefined;
    // 模型侧错误的用户可见文案：软收尾用尽时统一交代「未能给出最终回答」。
    const modelFailureMessage = (raw: string | undefined, fallback: string) => (
      guards.isFinalExhausted() ? FINAL_EXHAUSTED_MESSAGE : raw ?? fallback
    );

    async function runTurn(turnMessages: Message[]) {
      const agent = new Agent({
        initialState: {
          systemPrompt,
          // 常开图像输入：截图附件与 view_page 的工具结果图都可能在运行中出现，
          // 纯文本轮次不携带图块，声明能力本身无副作用。
          model: toLlmModel(connection, true),
          messages: turnMessages.slice(0, -1),
          tools: diagnosticsTools,
        },
        streamFn: guardedStreamFn,
        // 会话 id 透传给 provider 适配器（会话亲和头 / prompt_cache_key），支持缓存前缀复用。
        sessionId,
      });

      const run: ActiveRun = { sessionId, agent, cancelledByUser: false };
      activeRuns.set(runId, run);

      agent.subscribe((event: AgentEvent) => {
        switch (event.type) {
          case "message_start":
            if (event.message.role === "assistant") {
              if (!assistantMessageId) {
                assistantMessageId = store.appendMessage({
                  sessionId,
                  runId,
                  role: "assistant",
                  body: "",
                  status: "streaming",
                }).id;
              }
              assistantBodyStart = assistantBody.length;
            }
            break;
          case "message_update": {
            const streamEvent = event.assistantMessageEvent;
            if (streamEvent.type === "text_delta" && streamEvent.delta) {
              assistantBody += streamEvent.delta;
              // 流式增量是静默计时器的「事件」。
              guards.noteActivity();
              options.emit({ stream: "assistant", runId, sessionId, delta: streamEvent.delta });
            }
            break;
          }
          case "message_end":
            if (event.message.role === "assistant") {
              // 回答路径最后一次调用的 input 就是锚点（append-only 下最后一次必然最大）。
              if (typeof event.message.usage?.input === "number" && event.message.usage.input > 0) {
                lastAnswerInput = event.message.usage.input;
              }
              const content = assistantText(event.message);
              if (content) assistantBody = assistantBody.slice(0, assistantBodyStart) + content;
              // 该轮模型调用完成：回填耗时与 token 用量。
              if (activeCallStartedAt) {
                const lastRequest = collector.run.requests.at(-1);
                if (lastRequest) {
                  const durationMs = Date.now() - activeCallStartedAt;
                  const usage = toDiagnosticsUsage(event.message.usage);
                  collector.completeRequest(lastRequest.callIndex, durationMs, usage);
                  options.emit({
                    stream: "diagnostics",
                    kind: "request-complete",
                    runId,
                    sessionId,
                    callIndex: lastRequest.callIndex,
                    durationMs,
                    ...(usage ? { usage } : {}),
                  });
                  diagnosticsStore.record(bookId, collector.run);
                }
              }
              if (event.message.stopReason === "error") {
                overWindow = parseContextWindowError(event.message.errorMessage);
                const normalized = normalizeModelError(event.message);
                assistantFailure = { status: "error", message: modelFailureMessage(normalized?.message, event.message.errorMessage ?? "") };
              } else if (event.message.stopReason === "aborted") {
                if (guards.consumeGuardInterrupt()) {
                  // 守卫中断（静默挂死/时限兜底）：不按失败处理，软收尾驱动接管。
                } else if (run.cancelledByUser) {
                  assistantFailure = { status: "cancelled" };
                } else {
                  assistantFailure = { status: "error", message: "回答已中断。" };
                }
              }
            }
            break;
          case "tool_execution_start":
            options.emit({ stream: "tool", phase: "start", runId, callId: event.toolCallId, name: event.toolName });
            break;
          case "tool_execution_update":
            // 工具进度是静默计时器的「事件」。
            guards.noteActivity();
            options.emit({ stream: "tool", phase: "update", runId, callId: event.toolCallId, name: event.toolName });
            break;
          case "tool_execution_end":
            options.emit({ stream: "tool", phase: "end", runId, callId: event.toolCallId, name: event.toolName });
            break;
          default:
            break;
        }
      });

      guards.noteModelFlightStart();
      try {
        await agent.prompt(turnMessages[turnMessages.length - 1]!);
      } catch (error) {
        const thrownMessage = error instanceof Error ? error.message : String(error);
        overWindow = parseContextWindowError(thrownMessage);
        const normalized = normalizeModelError({ stopReason: "error", errorMessage: thrownMessage });
        assistantFailure = { status: "error", message: modelFailureMessage(normalized?.message, "回答生成失败，请重试。") };
      } finally {
        guards.noteModelFlightEnd();
        activeRuns.delete(runId);
      }
    }

    options.emit({ stream: "lifecycle", phase: "start", runId, sessionId });
    await runTurn(llmMessages);
    // 纯文本回答落地即封盘：此后任何守卫不再触发（出口按已答收）。
    const markAnswered = () => {
      if (!assistantFailure && assistantBody.trim()) guards.markAnswered();
    };
    markAnswered();

    // 撞窗自愈（ADR 0010）：采纳 provider 报告的真实窗口（进程级全局生效，不写回用户配置），
    // 强制压缩（绕过阈值与冷却）后当轮重答一次；再失败按普通错误收尾。
    // 自愈落地即清空指纹窗口（T50 扩展 ADR 0010）：重拼后原文不在，重取按 e=1 全文。
    // 两轮之间不在 activeRuns 中，取消意图落在 cancelledBeforeStart，重答前后各消费一次。
    if (assistantFailure?.status === "error" && overWindow) {
      if (overWindow.reportedWindow) effectiveWindowOverride = overWindow.reportedWindow;
      firstAgentCall = true;
      assistantFailure = undefined;
      overWindow = undefined;
      assistantBodyStart = assistantBody.length;
      const healed = await runCompaction({ force: true });
      guards.clearWindow();
      if (!cancelledBeforeStart.delete(runId)) {
        // 自愈重答的回放可能含当前 run 的读者消息（重载后的历史），工具行用合并列表。
        const healedMessages = await historyToLlmMessages(healed.history, [...historyToolCalls, ...toolCalls], {
          question,
          focus: focusWithContext,
          attachments,
          summary: healed.summary,
          loadImage: replayImageLoader,
          elision,
        });
        if (healedMessages[healedMessages.length - 1]) {
          await runTurn(healedMessages);
          markAnswered();
        }
      } else {
        assistantFailure = { status: "cancelled" };
      }
    }

    // 软收尾驱动（T50）：主循环因守卫中断而提前结束时（挂死调用被中断），另起收尾回合
    // 给模型作答机会——收尾文案以「系统提示」用户消息送达；到顶/锤子在循环内自然流转的
    // 软收尾不会进这里。每回合至少消耗一次最终调用，宽限与 2 分钟单调用静默由守卫兜底。
    while (!assistantFailure && guards.shouldAttemptFinalCall()) {
      const finalizePairs = toolCalls.length > 0
        ? await synthesizeToolPairMessagesForSummary(toolCalls)
        : [];
      const partialAssistant = assistantBody.trim() ? [assistantReplayMessage(assistantBody.trim())] : [];
      const finalizeMessages: Message[] = [
        ...llmMessages.slice(0, -1),
        llmMessages[llmMessages.length - 1]!,
        ...finalizePairs,
        ...partialAssistant,
        { role: "user", content: guards.finalizeCopyForExtraTurn(), timestamp: Date.now() },
      ];
      await runTurn(finalizeMessages);
      markAnswered();
    }

    // 软收尾最终调用全部花完仍无回答（含被静默兜底中断的尝试）：按错误收尾并交代原因。
    if (!assistantFailure && guards.finalCallsExhausted()) {
      assistantFailure = { status: "error", message: FINAL_EXHAUSTED_MESSAGE };
    }

    // 运行出口（T50 Exit Reason）：结束原因与已用/总圈数随运行记录落库并随终态事件透出。
    const exit = guards.finish(assistantFailure?.status === "error" || assistantFailure?.status === "cancelled"
      ? { status: assistantFailure.status }
      : undefined);

    // T44：run 级收尾——工具行与消息收尾同一事务；首请求即失败（无 assistant 消息）也落工具行，
    // 修复旧 finalizeMessage 路径下工具行无声丢失的收尾漏洞。
    const message = assistantMessageId ? {
      messageId: assistantMessageId,
      body: assistantBody,
      status: assistantFailure?.status ?? "complete" as const,
      errorMessage: assistantFailure?.message,
      evidence: collectEvidence(),
    } : undefined;
    const finalized = store.finalizeRun({ sessionId, runId, toolCalls, message, exit });
    if (finalized && message) {
      if (!assistantFailure && lastAnswerInput > 0) {
        store.saveSessionAnchor(sessionId, lastAnswerInput, connection.model, message.messageId);
      }
      options.emit({
        stream: "message",
        runId,
        sessionId,
        status: assistantFailure?.status ?? "complete",
        errorMessage: assistantFailure?.message,
      });
    }

    // T64 引用落地校验（旁路，只进诊断时间线）：complete 且有正文的回答才检查；
    // 确定性比对零模型调用，校验自身异常被吞——永不影响收尾事务与时序。
    if (!assistantFailure && assistantBody.trim() && options.readIndexedPageText) {
      try {
        const verdict = checkCitations({
          answerBody: assistantBody,
          evidencePages: collectEvidence().map((item) => item.page),
          pageText: (page) => options.readIndexedPageText!(bookId, page),
        });
        if (verdict.findings.length > 0) {
          const detail = verdict.findings
            .map((finding) => finding.kind === "page_claim_unindexed"
              ? `第 ${finding.page} 页未落地（无证据且未索引）`
              : `引文未找到：「${finding.excerpt}」`)
            .join("；");
          collector.pushTimeline(
            "citation",
            `引用落地校验（${verdict.pageClaims} 处页码声明、${verdict.quotes} 段引文）：${detail}`.slice(0, 400),
          );
        }
      } catch {
        // 旁路诊断：校验异常不影响运行收尾。
      }
    }

    collector.finish(
      assistantFailure?.status === "error" ? "error" : assistantFailure?.status === "cancelled" ? "cancelled" : "complete",
      exit,
    );
    diagnosticsStore.record(bookId, collector.run);

    if (assistantFailure?.status === "error") {
      options.emit({ stream: "lifecycle", phase: "error", runId, sessionId, exit });
    } else if (assistantFailure?.status === "cancelled") {
      options.emit({ stream: "lifecycle", phase: "cancelled", runId, sessionId, exit });
    } else {
      options.emit({ stream: "lifecycle", phase: "end", runId, sessionId, exit });
    }
  }

  return {
    async start(input: unknown): Promise<StartAgentRunResult> {
      if (!isRecord(input) || !isStartInput(input)) {
        return {
          ok: false,
          code: "VALIDATION_ERROR",
          message: "问题内容无效，请重新输入后再发送。",
        };
      }
      const question = input.question.trim();
      if (!question || question.length > QUESTION_MAX_LENGTH) {
        return {
          ok: false,
          code: "VALIDATION_ERROR",
          message: `问题不能为空，且不超过 ${QUESTION_MAX_LENGTH} 个字符。`,
        };
      }
      const attachments = parseAttachments(input.attachments);
      if (attachments === null) {
        return {
          ok: false,
          code: "VALIDATION_ERROR",
          message: `截图附件最多 ${MAX_AGENT_IMAGE_ATTACHMENTS} 张，支持 PNG、JPEG、WEBP、GIF，单张不超过 8 MB。`,
        };
      }
      const connection = await options.loadModelConnection();
      if (!connection || !connection.baseUrl || !connection.model) {
        return {
          ok: false,
          code: "MODEL_NOT_CONFIGURED",
          message: "尚未配置对话模型，请先在设置中保存并测试模型连接。",
        };
      }
      if (options.isKnownBook && !(await options.isKnownBook(input.bookId))) {
        return {
          ok: false,
          code: "VALIDATION_ERROR",
          message: "书库中没有这本 PDF 书籍，无法开始对话。",
        };
      }
      const sessionId = store.ensureSession(input.bookId).id;
      const runId = randomUUID();
      const focus = isReadingFocus(input.focus) ? input.focus : undefined;
      const profile = await (options.loadReaderProfile?.() ?? "");
      const bookTitle = await options.loadBookTitle?.(input.bookId);
      runBooks.set(runId, { bookId: input.bookId, sessionId });
      void enqueue(sessionId, () => executeRun({
        runId,
        sessionId,
        bookId: input.bookId,
        question,
        focus,
        attachments,
        connection,
        profile,
        bookTitle,
      }).finally(() => runBooks.delete(runId)));
      return { ok: true, runId, sessionId };
    },

    cancel(runId: unknown) {
      if (typeof runId !== "string") return;
      const run = activeRuns.get(runId);
      if (run) {
        run.cancelledByUser = true;
        run.agent.abort("user-cancelled");
        return;
      }
      // 尚未排到的运行：记录取消意图，执行前直接跳过。
      cancelledBeforeStart.add(runId);
      // T43：已开跑但仍在压缩阶段的运行，即时中断摘要请求，不空等。
      compactionControllers.get(runId)?.abort();
    },
    async cancelBook(bookId: string) {
      const runs = [...runBooks.entries()].filter(([, run]) => run.bookId === bookId);
      for (const [runId] of runs) {
        const active = activeRuns.get(runId);
        if (active) {
          active.cancelledByUser = true;
          active.agent.abort("book-removed");
        } else {
          cancelledBeforeStart.add(runId);
          compactionControllers.get(runId)?.abort();
        }
      }
      const sessionId = runs[0]?.[1].sessionId ?? store.findSession(bookId)?.id;
      const lane = sessionId ? sessionLanes.get(sessionId) : undefined;
      if (lane) await lane;
    },

    getConversation(bookId: unknown): ConversationMessage[] {
      if (!isBookId(bookId)) return [];
      const session = store.findSession(bookId);
      return session ? store.listMessages(session.id) : [];
    },

    listDiagnostics(bookId: unknown): RunDiagnostics[] {
      if (!isBookId(bookId)) return [];
      return diagnosticsStore.list(bookId);
    },

    async clearConversation(bookId: unknown) {
      if (!isBookId(bookId) || (options.isKnownBook && !(await options.isKnownBook(bookId)))) {
        return { ok: false as const, code: "VALIDATION_ERROR" as const, message: "当前 PDF 书籍不可用。" };
      }
      if ([...runBooks.values()].some((run) => run.bookId === bookId)) {
        return { ok: false as const, code: "CONFLICT" as const, message: "回答进行中，暂时无法清空会话。" };
      }
      try {
        store.clearConversation(bookId);
        return { ok: true as const };
      } catch {
        return { ok: false as const, code: "WRITE_ERROR" as const, message: "无法清空本书会话，请重试。" };
      }
    },

    close() {
      store.close();
    },
  };
}

export type AgentHost = ReturnType<typeof createAgentHost>;
