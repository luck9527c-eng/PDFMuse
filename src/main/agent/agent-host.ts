import { randomUUID } from "node:crypto";

import type {
  AgentStreamEvent,
  AgentImageAttachment,
  ConversationEvidence,
  ConversationMessage,
  ReadingFocus,
  StartAgentRunInput,
  StartAgentRunResult,
} from "../../shared/contracts.js";
import { CONVERSATION_EVIDENCE_MAX, DEFAULT_MODEL_CONTEXT_WINDOW, MAX_AGENT_IMAGE_ATTACHMENTS, MAX_AGENT_IMAGE_BYTES, MAX_AGENT_IMAGE_TOTAL_BYTES } from "../../shared/contracts.js";
import { assistantText, buildQuestionContent, buildSystemPrompt, historyMessagesToLlmMessages, historyToLlmMessages, toSessionEntries } from "./context-assembly.js";
import { createModelStreamFn, normalizeModelError, parseContextWindowError, toLlmModel, type ContextWindowError, type ResolvedModelConnection } from "./model-runtime.js";
import type { PageImageBudget } from "./tool-registry.js";
import {
  Agent,
  compact,
  DEFAULT_COMPACTION_SETTINGS,
  estimateStringChars,
  estimateTokens,
  estimateTokensFromChars,
  prepareCompaction,
  shouldCompact,
  type AgentEvent,
  type AgentTool,
  type CompactionSettings,
  type Message,
  type SessionTreeEntry,
  type StreamFn,
} from "./openclaw-core.js";
import { createSessionStore, type SessionStore } from "./session-store.js";
import {
  createDiagnosticsStore,
  createRunCollector,
  toDiagnosticsUsage,
  truncateToolResult,
  wrapStreamFnWithDiagnostics,
} from "./diagnostics.js";
import type { RunDiagnostics, RunDiagnosticsToolCall } from "../../shared/contracts.js";

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
  /** 将已完成的会话消息交给检索模块；失败不得阻断回答。 */
  indexConversationMessage?(bookId: string, message: {
    id: string;
    role: "reader" | "assistant";
    body: string;
    status: string;
  }): Promise<void> | void;
  emit(event: AgentStreamEvent): void;
  runTimeoutMs?: number;
  /** OpenClaw compaction trigger and retention can be lowered in tests or constrained deployments. */
  compactionContextWindow?: number;
  compactionSettings?: Partial<CompactionSettings>;
  /** 测试注入假模型流；生产默认使用 @openclaw/ai Provider Adapter。 */
  createStreamFn?: (connection: ResolvedModelConnection) => StreamFn;
};

const QUESTION_MAX_LENGTH = 8_000;
const PASSAGE_MAX_LENGTH = 20_000;
/** 每轮运行的 book_search 调用上限：防止检索散射时无限续轮。 */
const MAX_BOOK_SEARCH_CALLS = 3;
/** 每轮运行的 web_search 调用上限：事实型问题通常一次足够。 */
const MAX_WEB_SEARCH_CALLS = 2;
/** 压缩冷却递增档（ADR 0010）：压缩后仍接近阈值时按会话进入冷却，防止每问白打一次摘要调用。 */
const COMPACTION_COOLDOWN_STEPS_MS = [60_000, 300_000, 900_000];
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
  timedOut: boolean;
};

type AssistantFailure = { status: "error" | "cancelled"; message?: string };

/** 错误/取消的回答不进入模型上下文，与 context-assembly 的可用性过滤保持同一规则。 */
function usableLlmMessages(history: ConversationMessage[]) {
  return historyMessagesToLlmMessages(
    history.filter((message) => message.role === "reader" || message.status === "complete"),
  );
}

export function createAgentHost(options: AgentHostOptions) {
  const store: SessionStore = options.store ?? createSessionStore(options.dataHome);
  const runTimeoutMs = options.runTimeoutMs ?? 120_000;
  // 压缩阈值基准：显式注入优先（测试），否则每轮按模型连接的 contextWindow 现算（T36）。
  const injectedContextWindow = options.compactionContextWindow;
  const compactionSettings: CompactionSettings = {
    ...DEFAULT_COMPACTION_SETTINGS,
    ...options.compactionSettings,
  };
  const makeStreamFn = options.createStreamFn ?? createModelStreamFn;
  // 每个 Book Conversation 一条串行 lane；lane 尾部为空时移除，避免长期驻留。
  const sessionLanes = new Map<string, Promise<void>>();
  const activeRuns = new Map<string, ActiveRun>();
  const runBooks = new Map<string, { bookId: string; sessionId: string }>();
  const cancelledBeforeStart = new Set<string>();
  // 会话索引水位线：每次运行只把上次之后新增的完成消息交给索引模块，避免每个问题前全量重索引。
  const indexedThrough = new Map<string, string>();
  // 运行诊断的内存环形缓冲：常开捕获，按书保留最近若干次运行。
  const diagnosticsStore = createDiagnosticsStore();
  // 撞窗自愈修正的生效窗口（ADR 0010）：provider 报告的真实上限，进程级全局生效，不写回用户配置。
  let effectiveWindowOverride: number | undefined;
  // 压缩冷却：per session 内存态，重启归零；压缩后仍接近阈值时进入，防止每问白打一次摘要调用。
  const compactionCooldowns = new Map<string, { level: number; until: number }>();

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

  async function compactHistory(
    sessionId: string,
    history: ConversationMessage[],
    connection: ResolvedModelConnection,
    streamFn?: StreamFn,
    overrides: { force?: boolean; systemPrompt?: string; questionContent?: string } = {},
  ): Promise<{ history: ConversationMessage[]; summary?: string }> {
    const previous = store.getSummary(sessionId);
    const previousIndex = previous ? history.findIndex((message) => message.id === previous.throughMessageId) : -1;
    const workingHistory = previousIndex >= 0 ? history.slice(previousIndex + 1) : history;
    const historyMessages = usableLlmMessages(workingHistory);
    const summaryMessage = previous?.summary
      ? [{ role: "user" as const, content: `【Conversation Summary】\n${previous.summary}`, timestamp: 0 }]
      : [];
    // 阈值基准（T36/T37）：注入优先（测试/受限部署），其次撞窗自愈修正的真实窗口，再次连接配置，最后默认档。
    const contextWindow = injectedContextWindow
      ?? effectiveWindowOverride
      ?? connection.contextWindow
      ?? DEFAULT_MODEL_CONTEXT_WINDOW;
    const effectiveSettings: CompactionSettings = {
      ...compactionSettings,
      reserveTokens: options.compactionSettings?.reserveTokens
        ?? (injectedContextWindow ? compactionSettings.reserveTokens : Math.round(contextWindow * 0.3)),
    };
    // 判断值（ADR 0010）：真实 usage 锚点 + 落锚点后增量（锚点已含 system prompt，不重复计）；
    // 无锚点降级为字符估算，口径计入 system prompt 与当轮问题内容，与锚点口径对齐。
    const systemEstimate = estimateTokensFromChars(estimateStringChars(overrides.systemPrompt ?? ""));
    const questionEstimate = estimateTokensFromChars(estimateStringChars(overrides.questionContent ?? ""));
    const anchor = store.getSessionAnchor(sessionId);
    const anchorIndex = anchor ? history.findIndex((message) => message.id === anchor.throughMessageId) : -1;
    const anchored = Boolean(anchor) && anchor!.model === connection.model && anchorIndex >= 0;
    let contextTokens: number;
    if (anchored && anchor) {
      const anchorDelta = usableLlmMessages(history.slice(anchorIndex + 1));
      contextTokens = anchor.inputTokens
        + anchorDelta.reduce((total, message) => total + estimateTokens(message), 0)
        + questionEstimate;
    } else {
      contextTokens = [...summaryMessage, ...historyMessages]
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

    // 重建 OpenClaw 会话树：持久化摘要落成 compaction 边界，切点选择与摘要生成交给 vendored harness。
    const messageEntries = toSessionEntries(history);
    const boundaryIndex = previous
      ? messageEntries.findIndex((entry) => entry.id === previous.throughMessageId)
      : -1;
    const pathEntries: SessionTreeEntry[] = previous && boundaryIndex >= 0 && boundaryIndex + 1 < messageEntries.length
      ? [
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
        ]
      : messageEntries;
    const prepared = prepareCompaction(pathEntries, effectiveSettings);
    if (!prepared.ok || !prepared.value) {
      return unchanged();
    }
    const preparation = prepared.value;
    const compacted = await compact(
      preparation,
      toLlmModel(connection),
      connection.apiKey,
      undefined,
      undefined,
      undefined,
      undefined,
      streamFn ?? makeStreamFn(connection),
    );
    if (!compacted.ok || !compacted.value.summary.trim()) {
      // 摘要是优化，不是回答的前置条件；失败时保持原始消息可用。
      return unchanged();
    }
    const keptIndex = messageEntries.findIndex((entry) => entry.id === preparation.firstKeptEntryId);
    const throughEntry = keptIndex > 0 ? messageEntries[keptIndex - 1] : undefined;
    if (!throughEntry) {
      return unchanged();
    }
    store.saveSummary(sessionId, compacted.value.summary, throughEntry.id);
    const nextHistory = history.slice(history.findIndex((message) => message.id === throughEntry.id) + 1);
    // 压缩后仍接近阈值 → 会话进入冷却递增档；降到阈值以下 → 归零。
    // 判断值用纯估算（锚点描述的是压缩前的请求形状，头部重写后已过期），口径含 system prompt 与当轮问题。
    const afterMessages = usableLlmMessages(nextHistory);
    const afterTokens = estimateTokens({ role: "user", content: `【Conversation Summary】\n${compacted.value.summary}`, timestamp: 0 })
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
    return { history: nextHistory, summary: compacted.value.summary };
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

    // Reader 问题先落盘：失败或中断时问题和阅读焦点不丢失。
    const fullHistory = store.listMessages(sessionId);
    let activeCallStartedAt = 0;
    const startCallClock = () => { activeCallStartedAt = Date.now(); };
    // Reading Focus 增强与上轮 Evidence 前移到压缩之前：压缩判断值需要当轮问题内容与 system prompt 的估算。
    const sectionTitle = focus ? await options.resolveReadingSection?.(bookId, focus.currentPage) : undefined;
    const chapterRange = focus ? await options.resolveChapterRange?.(bookId, focus.currentPage) : undefined;
    const focusWithContext: ReadingFocus | undefined = focus ? {
      currentPage: focus.currentPage,
      ...(focus.selectedPassage ? { selectedPassage: focus.selectedPassage } : {}),
      ...(sectionTitle ? { sectionTitle } : {}),
      ...(chapterRange ? { chapterRange } : {}),
    } : undefined;
    // 上轮 Evidence 注入：只取最近一条完成回答（常数开销，不随会话累积），追问免重查一手原文。
    const previousEvidence = fullHistory.findLast(
      (message) => message.role === "assistant" && message.status === "complete",
    )?.evidence;
    const questionContent = buildQuestionContent(question, focusWithContext, previousEvidence);
    const systemPrompt = buildSystemPrompt(profile, bookTitle ? { title: bookTitle } : undefined);
    const compactionStartedAt = Date.now();
    const compacted = await compactHistory(
      sessionId,
      fullHistory,
      connection,
      wrapStreamFnWithDiagnostics(() => makeStreamFn(connection), () => "compaction", collector, options.emit, startCallClock),
      { systemPrompt, questionContent },
    );
    const compactionRequest = collector.run.requests.filter((item) => item.role === "compaction").at(-1);
    if (compactionRequest && compactionRequest.durationMs === undefined) {
      const durationMs = Date.now() - compactionStartedAt;
      collector.completeRequest(compactionRequest.callIndex, durationMs);
      options.emit({ stream: "diagnostics", kind: "request-complete", runId, sessionId, callIndex: compactionRequest.callIndex, durationMs });
      diagnosticsStore.record(bookId, collector.run);
    }
    const history = compacted.history;
    // 索引需要看到完整的原始会话；压缩只影响发给模型的上下文窗口。水位线之后的消息才需要索引。
    const watermark = indexedThrough.get(sessionId);
    const watermarkIndex = watermark ? fullHistory.findIndex((message) => message.id === watermark) : -1;
    for (const message of fullHistory.slice(watermarkIndex >= 0 ? watermarkIndex + 1 : 0)) {
      if (message.body && message.status === "complete") {
        await options.indexConversationMessage?.(bookId, {
          id: message.id,
          role: message.role,
          body: message.body,
          status: message.status,
        });
        indexedThrough.set(sessionId, message.id);
      }
    }
    if (cancelledBeforeStart.delete(runId)) {
      options.emit({ stream: "lifecycle", phase: "cancelled", runId, sessionId });
      return;
    }
    const readerMessage = store.appendMessage({ sessionId, runId, role: "reader", body: question, status: "complete", focus });
    await options.indexConversationMessage?.(bookId, {
      id: readerMessage.id,
      role: readerMessage.role,
      body: readerMessage.body,
      status: readerMessage.status,
    });
    indexedThrough.set(sessionId, readerMessage.id);

    const llmMessages = historyToLlmMessages(history, {
      question,
      focus: focusWithContext,
      attachments,
      summary: compacted.summary,
      previousEvidence,
    });
    const questionMessage = llmMessages[llmMessages.length - 1];
    if (!questionMessage) return;

    // 证据聚合：每页只保留相关度最高的一条，总量按分数截断，参考页不随搜索次数膨胀。
    const evidenceByPage = new Map<number, ConversationEvidence>();
    const reportEvidence = (evidence: ConversationEvidence[]) => {
      for (const item of evidence) {
        const existing = evidenceByPage.get(item.page);
        if (!existing || (item.score ?? 0) > (existing.score ?? 0)) evidenceByPage.set(item.page, item);
      }
    };
    const collectEvidence = () => [...evidenceByPage.values()]
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
      .slice(0, CONVERSATION_EVIDENCE_MAX)
      .sort((left, right) => left.page - right.page);
    const tools = options.buildTools?.({
      bookId: input.bookId,
      focus: focusWithContext,
      reportEvidence,
      // 每问新建：预算随运行生命周期，下一问自动重置。
      pageBudget: { pagesDelivered: 0, calls: 0 },
    }) ?? [];

    // 工具包装：捕获参数、结果与耗时进运行诊断；检索类工具设每轮上限防散射打捞。
    let bookSearchCalls = 0;
    let webSearchCalls = 0;
    const diagnosticsTools = tools.map((tool): AgentTool => ({
      ...tool,
      async execute(toolCallId, params, signal, onUpdate) {
        collector.pushTimeline("tool-start", tool.name);
        if (tool.name === "book_search") {
          bookSearchCalls += 1;
          if (bookSearchCalls > MAX_BOOK_SEARCH_CALLS) {
            const blockedText = `book_search 已达到本轮上限（${MAX_BOOK_SEARCH_CALLS} 次）。请基于已检索到的内容回答；若信息不足，请向 Reader 明确说明。`;
            const toolCall: RunDiagnosticsToolCall = {
              callId: toolCallId,
              name: tool.name,
              parameters: params,
              resultText: blockedText,
              durationMs: 0,
            };
            collector.recordTool(toolCall);
            collector.pushTimeline("tool-end", `${tool.name} · 已达上限，拒绝执行`);
            options.emit({ stream: "diagnostics", kind: "tool", runId, sessionId, toolCall });
            return { content: [{ type: "text", text: blockedText }], details: undefined };
          }
        }
        if (tool.name === "web_search") {
          webSearchCalls += 1;
          if (webSearchCalls > MAX_WEB_SEARCH_CALLS) {
            const blockedText = `web_search 已达到本轮上限（${MAX_WEB_SEARCH_CALLS} 次）。请基于已获得的网络资料回答，并标注来源。`;
            const toolCall: RunDiagnosticsToolCall = {
              callId: toolCallId,
              name: tool.name,
              parameters: params,
              resultText: blockedText,
              durationMs: 0,
            };
            collector.recordTool(toolCall);
            collector.pushTimeline("tool-end", `${tool.name} · 已达上限，拒绝执行`);
            options.emit({ stream: "diagnostics", kind: "tool", runId, sessionId, toolCall });
            return { content: [{ type: "text", text: blockedText }], details: undefined };
          }
        }
        const startedAt = Date.now();
        const result = await tool.execute(toolCallId, params, signal, onUpdate);
        const firstText = result.content.find((block): block is Extract<typeof block, { type: "text" }> => block.type === "text");
        const toolCall: RunDiagnosticsToolCall = {
          callId: toolCallId,
          name: tool.name,
          parameters: params,
          resultText: truncateToolResult(firstText?.text),
          evidence: (result.details as { evidence?: ConversationEvidence[] } | undefined)?.evidence,
          durationMs: Date.now() - startedAt,
        };
        collector.recordTool(toolCall);
        collector.pushTimeline("tool-end", `${tool.name} · ${toolCall.durationMs}ms`);
        options.emit({ stream: "diagnostics", kind: "tool", runId, sessionId, toolCall });
        diagnosticsStore.record(bookId, collector.run);
        return result;
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

    async function runTurn(turnMessages: Message[]) {
      const agent = new Agent({
        initialState: {
          systemPrompt,
          // 常开图像输入：截图附件与 read_page_image 的工具结果图都可能在运行中出现，
          // 纯文本轮次不携带图块，声明能力本身无副作用。
          model: toLlmModel(connection, true),
          messages: turnMessages.slice(0, -1),
          tools: diagnosticsTools,
        },
        streamFn: agentStreamFn,
        // 会话 id 透传给 provider 适配器（会话亲和头 / prompt_cache_key），支持缓存前缀复用。
        sessionId,
      });

      const run: ActiveRun = { sessionId, agent, cancelledByUser: false, timedOut: false };
      activeRuns.set(runId, run);

      const timeout = setTimeout(() => {
        if (!activeRuns.has(runId)) return;
        run.timedOut = true;
        agent.abort("timeout");
      }, runTimeoutMs);

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
                assistantFailure = { status: "error", message: normalized?.message ?? event.message.errorMessage };
              } else if (event.message.stopReason === "aborted") {
                assistantFailure = run.timedOut
                  ? { status: "error", message: "模型响应超时，请稍后重试。" }
                  : run.cancelledByUser
                    ? { status: "cancelled" }
                    : { status: "error", message: "回答已中断。" };
              }
            }
            break;
          case "tool_execution_start":
            options.emit({ stream: "tool", phase: "start", runId, callId: event.toolCallId, name: event.toolName });
            break;
          case "tool_execution_update":
            options.emit({ stream: "tool", phase: "update", runId, callId: event.toolCallId, name: event.toolName });
            break;
          case "tool_execution_end":
            options.emit({ stream: "tool", phase: "end", runId, callId: event.toolCallId, name: event.toolName });
            break;
          default:
            break;
        }
      });

      try {
        await agent.prompt(turnMessages[turnMessages.length - 1]!);
      } catch (error) {
        const thrownMessage = error instanceof Error ? error.message : String(error);
        overWindow = parseContextWindowError(thrownMessage);
        const normalized = normalizeModelError({ stopReason: "error", errorMessage: thrownMessage });
        assistantFailure = {
          status: "error",
          message: normalized?.message ?? "回答生成失败，请重试。",
        };
      } finally {
        clearTimeout(timeout);
        activeRuns.delete(runId);
      }
    }

    options.emit({ stream: "lifecycle", phase: "start", runId, sessionId });
    await runTurn(llmMessages);

    // 撞窗自愈（ADR 0010）：采纳 provider 报告的真实窗口（进程级全局生效，不写回用户配置），
    // 强制压缩（绕过阈值与冷却）后当轮重答一次；再失败按普通错误收尾。
    // 两轮之间不在 activeRuns 中，取消意图落在 cancelledBeforeStart，重答前后各消费一次。
    if (assistantFailure?.status === "error" && overWindow) {
      if (overWindow.reportedWindow) effectiveWindowOverride = overWindow.reportedWindow;
      firstAgentCall = true;
      assistantFailure = undefined;
      overWindow = undefined;
      assistantBodyStart = assistantBody.length;
      const healed = await compactHistory(
        sessionId,
        fullHistory,
        connection,
        wrapStreamFnWithDiagnostics(() => makeStreamFn(connection), () => "compaction", collector, options.emit, startCallClock),
        { force: true, systemPrompt, questionContent },
      );
      if (!cancelledBeforeStart.delete(runId)) {
        const healedMessages = historyToLlmMessages(healed.history, {
          question,
          focus: focusWithContext,
          attachments,
          summary: healed.summary,
          previousEvidence,
        });
        if (healedMessages[healedMessages.length - 1]) {
          await runTurn(healedMessages);
        }
      } else {
        assistantFailure = { status: "cancelled" };
      }
    }

    if (assistantMessageId) {
      const finalized = store.finalizeMessage({
        sessionId,
        messageId: assistantMessageId,
        runId,
        body: assistantBody,
        status: assistantFailure?.status ?? "complete",
        errorMessage: assistantFailure?.message,
        evidence: collectEvidence(),
      });
      if (finalized) {
        if (!assistantFailure && lastAnswerInput > 0) {
          store.saveSessionAnchor(sessionId, lastAnswerInput, connection.model, assistantMessageId);
        }
        if (assistantFailure?.status !== "cancelled" && assistantBody) {
          await options.indexConversationMessage?.(bookId, {
            id: assistantMessageId,
            role: "assistant",
            body: assistantBody,
            status: assistantFailure?.status ?? "complete",
          });
          indexedThrough.set(sessionId, assistantMessageId);
        }
        options.emit({
          stream: "message",
          runId,
          sessionId,
          status: assistantFailure?.status ?? "complete",
          errorMessage: assistantFailure?.message,
        });
      }
    }

    collector.finish(assistantFailure?.status === "error" ? "error" : assistantFailure?.status === "cancelled" ? "cancelled" : "complete");
    diagnosticsStore.record(bookId, collector.run);

    if (assistantFailure?.status === "error") {
      options.emit({ stream: "lifecycle", phase: "error", runId, sessionId });
    } else if (assistantFailure?.status === "cancelled") {
      options.emit({ stream: "lifecycle", phase: "cancelled", runId, sessionId });
    } else {
      options.emit({ stream: "lifecycle", phase: "end", runId, sessionId });
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
        indexedThrough.delete(store.findSession(bookId)?.id ?? "");
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
