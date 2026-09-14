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
import { MAX_AGENT_IMAGE_ATTACHMENTS, MAX_AGENT_IMAGE_BYTES, MAX_AGENT_IMAGE_TOTAL_BYTES } from "../../shared/contracts.js";
import { assistantText, buildSystemPrompt, historyMessagesToLlmMessages, historyToLlmMessages, toSessionEntries } from "./context-assembly.js";
import { createModelStreamFn, normalizeModelError, toLlmModel, type ResolvedModelConnection } from "./model-runtime.js";
import {
  Agent,
  compact,
  DEFAULT_COMPACTION_SETTINGS,
  estimateTokens,
  prepareCompaction,
  shouldCompact,
  type AgentEvent,
  type AgentTool,
  type CompactionSettings,
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
  /** Book 所有权验证：伪造的 bookId 不允许建立会话。 */
  isKnownBook?(bookId: string): boolean | Promise<boolean>;
  /** 为一次运行构造可见工具；工具通过 reportEvidence 上报检索证据。 */
  buildTools?(context: {
    bookId: string;
    focus?: ReadingFocus;
    reportEvidence(evidence: ConversationEvidence[]): void;
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
  historyLimit?: number;
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

export function createAgentHost(options: AgentHostOptions) {
  const store: SessionStore = options.store ?? createSessionStore(options.dataHome);
  const runTimeoutMs = options.runTimeoutMs ?? 120_000;
  const historyLimit = options.historyLimit ?? 12;
  const compactionContextWindow = options.compactionContextWindow ?? 64_000;
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
  ): Promise<{ history: ConversationMessage[]; summary?: string }> {
    const previous = store.getSummary(sessionId);
    const previousIndex = previous ? history.findIndex((message) => message.id === previous.throughMessageId) : -1;
    const workingHistory = previousIndex >= 0 ? history.slice(previousIndex + 1) : history;
    const usableHistory = workingHistory.filter(
      (message) => message.role === "reader" || message.status === "complete",
    );
    const historyMessages = historyMessagesToLlmMessages(usableHistory);
    const summaryMessage = previous?.summary
      ? [{ role: "user" as const, content: `【Conversation Summary】\n${previous.summary}`, timestamp: 0 }]
      : [];
    const contextTokens = [...summaryMessage, ...historyMessages]
      .reduce((total, message) => total + estimateTokens(message), 0);
    const unchanged = (): { history: ConversationMessage[]; summary?: string } => (
      { history: workingHistory, ...(previous?.summary ? { summary: previous.summary } : {}) }
    );
    if (!shouldCompact(contextTokens, compactionContextWindow, compactionSettings)) {
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
    const prepared = prepareCompaction(pathEntries, compactionSettings);
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
    const compactionStartedAt = Date.now();
    const compacted = await compactHistory(
      sessionId,
      fullHistory,
      connection,
      wrapStreamFnWithDiagnostics(() => makeStreamFn(connection), () => "compaction", collector, options.emit, startCallClock),
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

    // Reading Focus 增强：Main 侧解析当前页所在章节，相对引用（这一节/下一节）无需再检索定位。
    const sectionTitle = focus ? await options.resolveReadingSection?.(bookId, focus.currentPage) : undefined;
    const focusWithContext: ReadingFocus | undefined = focus ? {
      currentPage: focus.currentPage,
      ...(focus.selectedPassage ? { selectedPassage: focus.selectedPassage } : {}),
      ...(sectionTitle ? { sectionTitle } : {}),
    } : undefined;
    const llmMessages = historyToLlmMessages(history, question, focusWithContext, historyLimit, attachments, compacted.summary);
    const questionMessage = llmMessages[llmMessages.length - 1];
    if (!questionMessage) return;

    // 证据聚合：每页只保留相关度最高的一条，总量按分数截断，参考页不随搜索次数膨胀。
    const EVIDENCE_MAX_ENTRIES = 8;
    const evidenceByPage = new Map<number, ConversationEvidence>();
    const reportEvidence = (evidence: ConversationEvidence[]) => {
      for (const item of evidence) {
        const existing = evidenceByPage.get(item.page);
        if (!existing || (item.score ?? 0) > (existing.score ?? 0)) evidenceByPage.set(item.page, item);
      }
    };
    const collectEvidence = () => [...evidenceByPage.values()]
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
      .slice(0, EVIDENCE_MAX_ENTRIES)
      .sort((left, right) => left.page - right.page);
    const tools = options.buildTools?.({ bookId: input.bookId, focus: focusWithContext, reportEvidence }) ?? [];

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

    const agent = new Agent({
      initialState: {
        systemPrompt: buildSystemPrompt(profile, bookTitle ? {
          title: bookTitle,
        } : undefined),
        // 常开图像输入：截图附件与 read_page_image 的工具结果图都可能在运行中出现，
        // 纯文本轮次不携带图块，声明能力本身无副作用。
        model: toLlmModel(connection, true),
        messages: llmMessages.slice(0, -1),
        tools: diagnosticsTools,
      },
      streamFn: agentStreamFn,
    });

    const run: ActiveRun = { sessionId, agent, cancelledByUser: false, timedOut: false };
    activeRuns.set(runId, run);

    let assistantMessageId: string | undefined;
    let assistantBody = "";
    // 当前 assistant 消息在累积体中的起点：工具轮会产生多段 assistant 消息，
    // message_end 用整条文本替换时只覆盖本消息的区段，前段回答不得丢失。
    let assistantBodyStart = 0;
    let assistantFailure: AssistantFailure | undefined;

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

    options.emit({ stream: "lifecycle", phase: "start", runId, sessionId });

    try {
      await agent.prompt(questionMessage);
    } catch (error) {
      const thrownMessage = error instanceof Error ? error.message : String(error);
      const normalized = normalizeModelError({ stopReason: "error", errorMessage: thrownMessage });
      assistantFailure = {
        status: "error",
        message: normalized?.message ?? "回答生成失败，请重试。",
      };
    } finally {
      clearTimeout(timeout);
      activeRuns.delete(runId);
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
