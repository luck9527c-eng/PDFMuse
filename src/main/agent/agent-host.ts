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
import { assistantText, buildSystemPrompt, historyMessagesToLlmMessages, historyToLlmMessages } from "./context-assembly.js";
import { createModelStreamFn, normalizeModelError, toLlmModel, type ResolvedModelConnection } from "./model-runtime.js";
import {
  Agent,
  DEFAULT_COMPACTION_SETTINGS,
  estimateTokens,
  generateSummary,
  shouldCompact,
  type AgentEvent,
  type AgentTool,
  type BeforeToolCallContext,
  type CompactionSettings,
  type StreamFn,
} from "./openclaw-core.js";
import { createSessionStore, type SessionStore } from "./session-store.js";
import type { MemoryModule } from "./memory.js";

export type AgentHostOptions = {
  dataHome: string;
  loadModelConnection(): Promise<ResolvedModelConnection | undefined>;
  /** Reader Profile 只读注入；没有 Profile 时返回空字符串。 */
  loadReaderProfile?(): Promise<string>;
  /** 当前书名由 Main 侧 Library 提供，不信任 Renderer 自报书名。 */
  loadBookTitle?(bookId: string): string | undefined | Promise<string | undefined>;
  /** Book 所有权验证：伪造的 bookId 不允许建立会话。 */
  isKnownBook?(bookId: string): boolean | Promise<boolean>;
  /** 为一次运行构造可见工具；工具通过 reportEvidence 上报检索证据。 */
  buildTools?(context: {
    bookId: string;
    focus?: ReadingFocus;
    reportEvidence(evidence: ConversationEvidence[]): void;
    memory?: MemoryModule;
  }): AgentTool[];
  memory?: MemoryModule;
  /** 将已完成的会话消息交给检索模块；失败不得阻断回答。 */
  indexConversationMessage?(bookId: string, message: {
    id: string;
    role: "reader" | "assistant";
    body: string;
    status: string;
  }): Promise<void> | void;
  /** 清空 Book Conversation 时同步移除会话语义向量。 */
  clearConversationIndex?(bookId: string): Promise<void> | void;
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
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReadingFocus(value: unknown): value is ReadingFocus {
  if (!isRecord(value)) return false;
  const currentPage = value.currentPage;
  if (typeof currentPage !== "number" || !Number.isSafeInteger(currentPage) || currentPage <= 0) return false;
  if (value.currentChapter !== undefined && (
    typeof value.currentChapter !== "string" || !value.currentChapter.trim() || value.currentChapter.length > 500
  )) return false;
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
  const store: SessionStore = createSessionStore(options.dataHome);
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
  const pendingApprovals = new Map<string, { runId: string; bookId: string; resolve: (approved: boolean) => void }>();

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
    if (!shouldCompact(contextTokens, compactionContextWindow, compactionSettings)) {
      return { history: workingHistory, ...(previous?.summary ? { summary: previous.summary } : {}) };
    }

    let retainedTokens = 0;
    let cut = historyMessages.length;
    while (cut > 0) {
      const next = estimateTokens(historyMessages[cut - 1]!);
      if (retainedTokens + next > compactionSettings.keepRecentTokens) break;
      retainedTokens += next;
      cut -= 1;
    }
    if (cut <= 0) {
      return { history: workingHistory, ...(previous?.summary ? { summary: previous.summary } : {}) };
    }
    const summaryResult = await generateSummary(
      historyMessages.slice(0, cut),
      toLlmModel(connection),
      compactionSettings.reserveTokens,
      connection.apiKey,
      undefined,
      undefined,
      undefined,
      previous?.summary,
      undefined,
      makeStreamFn(connection),
    );
    if (!summaryResult.ok || !summaryResult.value.trim()) {
      // 摘要是优化，不是回答的前置条件；失败时保持原始消息可用。
      return { history: workingHistory, ...(previous?.summary ? { summary: previous.summary } : {}) };
    }
    const throughMessage = usableHistory[cut - 1];
    if (!throughMessage) return { history: workingHistory, summary: summaryResult.value };
    store.saveSummary(sessionId, summaryResult.value, throughMessage.id);
    const nextHistory = history.slice(history.findIndex((message) => message.id === throughMessage.id) + 1);
    return { history: nextHistory, summary: summaryResult.value };
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

    // Reader 问题先落盘：失败或中断时问题和阅读焦点不丢失。
    const fullHistory = store.listMessages(sessionId);
    const compacted = await compactHistory(sessionId, fullHistory, connection);
    const history = compacted.history;
    // 索引需要看到完整的原始会话；压缩只影响发给模型的上下文窗口。
    for (const message of fullHistory) {
      if (message.body && message.status === "complete") {
        await options.indexConversationMessage?.(bookId, {
          id: message.id,
          role: message.role,
          body: message.body,
          status: message.status,
        });
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

    const relatedMemories = options.memory?.search(bookId, question, 6) ?? [];
    const llmMessages = historyToLlmMessages(history, question, focus, historyLimit, attachments, compacted.summary, relatedMemories);
    const questionMessage = llmMessages[llmMessages.length - 1];
    if (!questionMessage) return;

    const collectedEvidence: ConversationEvidence[] = [];
    const reportEvidence = (evidence: ConversationEvidence[]) => {
      for (const item of evidence) {
        const duplicate = collectedEvidence.some(
          (existing) => existing.page === item.page && existing.snippet === item.snippet,
        );
        if (!duplicate) collectedEvidence.push(item);
      }
    };
    const tools = options.buildTools?.({ bookId: input.bookId, focus, reportEvidence, memory: options.memory }) ?? [];

    const agent = new Agent({
      initialState: {
        systemPrompt: buildSystemPrompt(profile, bookTitle && focus ? {
          title: bookTitle,
          currentPage: focus.currentPage,
          ...(focus.currentChapter ? { currentChapter: focus.currentChapter } : {}),
        } : undefined),
        model: toLlmModel(connection, attachments.length > 0),
        messages: llmMessages.slice(0, -1),
        tools,
      },
      streamFn: makeStreamFn(connection),
      beforeToolCall: async (context: BeforeToolCallContext, signal?: AbortSignal) => {
        if (context.toolCall.name !== "memory_propose") return undefined;
        const approvalId = randomUUID();
        const approved = await new Promise<boolean>((resolve) => {
          pendingApprovals.set(approvalId, { runId, bookId, resolve });
          options.emit({ stream: "lifecycle", phase: "waiting-approval", runId, sessionId, approvalId, toolName: "memory_propose" });
          const onAbort = () => {
            pendingApprovals.delete(approvalId);
            resolve(false);
          };
          signal?.addEventListener("abort", onAbort, { once: true });
        });
        return approved ? undefined : { block: true, reason: "Reader 未确认这条记忆候选。" };
      },
    });

    const run: ActiveRun = { sessionId, agent, cancelledByUser: false, timedOut: false };
    activeRuns.set(runId, run);

    let assistantMessageId: string | undefined;
    let assistantBody = "";
    let assistantFailure: AssistantFailure | undefined;

    const timeout = setTimeout(() => {
      if (!activeRuns.has(runId)) return;
      run.timedOut = true;
      agent.abort("timeout");
    }, runTimeoutMs);

    agent.subscribe((event: AgentEvent) => {
      switch (event.type) {
        case "message_start":
          if (event.message.role === "assistant" && !assistantMessageId) {
            assistantMessageId = store.appendMessage({
              sessionId,
              runId,
              role: "assistant",
              body: "",
              status: "streaming",
            }).id;
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
            if (content) assistantBody = content;
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
      for (const [approvalId, pending] of pendingApprovals) {
        if (pending.runId === runId) {
          pendingApprovals.delete(approvalId);
          pending.resolve(false);
        }
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
        evidence: collectedEvidence,
      });
      if (finalized) {
        if (assistantFailure?.status !== "cancelled" && assistantBody) {
          await options.indexConversationMessage?.(bookId, {
            id: assistantMessageId,
            role: "assistant",
            body: assistantBody,
            status: assistantFailure?.status ?? "complete",
          });
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
      for (const [approvalId, pending] of pendingApprovals) {
        if (pending.bookId === bookId) {
          pendingApprovals.delete(approvalId);
          pending.resolve(false);
        }
      }
      const sessionId = runs[0]?.[1].sessionId ?? store.findSession(bookId)?.id;
      const lane = sessionId ? sessionLanes.get(sessionId) : undefined;
      if (lane) await lane;
    },
    approveTool(input: { approvalId: string; approved: boolean }) {
      const pending = pendingApprovals.get(input.approvalId);
      if (!pending) return { ok: false as const, message: "审批已失效，请重新发起操作。" };
      pendingApprovals.delete(input.approvalId);
      pending.resolve(input.approved === true);
      return { ok: true as const };
    },

    getConversation(bookId: unknown): ConversationMessage[] {
      if (!isBookId(bookId)) return [];
      const session = store.findSession(bookId);
      return session ? store.listMessages(session.id) : [];
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
        await options.clearConversationIndex?.(bookId);
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
