import { randomUUID } from "node:crypto";

import type {
  AgentStreamEvent,
  ConversationEvidence,
  ConversationMessage,
  ReadingFocus,
  StartAgentRunInput,
  StartAgentRunResult,
} from "../../shared/contracts.js";
import { assistantText, buildSystemPrompt, historyToLlmMessages } from "./context-assembly.js";
import { createModelStreamFn, normalizeModelError, toLlmModel, type ResolvedModelConnection } from "./model-runtime.js";
import { Agent, type AgentEvent, type AgentTool, type StreamFn } from "./openclaw-core.js";
import { createSessionStore, type SessionStore } from "./session-store.js";

export type AgentHostOptions = {
  dataHome: string;
  loadModelConnection(): Promise<ResolvedModelConnection | undefined>;
  /** Reader Profile 只读注入；没有 Profile 时返回空字符串。 */
  loadReaderProfile?(): Promise<string>;
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
  /** 测试注入假模型流；生产默认使用 @openclaw/ai Provider Adapter。 */
  createStreamFn?: (connection: ResolvedModelConnection) => StreamFn;
};

const QUESTION_MAX_LENGTH = 8_000;
const PASSAGE_MAX_LENGTH = 20_000;

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
  const makeStreamFn = options.createStreamFn ?? createModelStreamFn;
  // 每个 Book Conversation 一条串行 lane；lane 尾部为空时移除，避免长期驻留。
  const sessionLanes = new Map<string, Promise<void>>();
  const activeRuns = new Map<string, ActiveRun>();
  const cancelledBeforeStart = new Set<string>();

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

  async function executeRun(input: {
    runId: string;
    sessionId: string;
    bookId: string;
    question: string;
    focus?: ReadingFocus;
    connection: ResolvedModelConnection;
    profile: string;
  }) {
    const { runId, sessionId, bookId, question, focus, connection, profile } = input;
    if (cancelledBeforeStart.delete(runId)) {
      // 排队期间被取消：仍保留 Reader 问题，并发出终态让 Renderer 解除占用。
      store.appendMessage({ sessionId, runId, role: "reader", body: question, status: "complete", focus });
      options.emit({ stream: "lifecycle", phase: "cancelled", runId, sessionId });
      return;
    }

    // Reader 问题先落盘：失败或中断时问题和阅读焦点不丢失。
    const history = store.listMessages(sessionId);
    for (const message of history) {
      if (message.body && message.status === "complete") {
        await options.indexConversationMessage?.(bookId, {
          id: message.id,
          role: message.role,
          body: message.body,
          status: message.status,
        });
      }
    }
    const readerMessage = store.appendMessage({ sessionId, runId, role: "reader", body: question, status: "complete", focus });
    await options.indexConversationMessage?.(bookId, {
      id: readerMessage.id,
      role: readerMessage.role,
      body: readerMessage.body,
      status: readerMessage.status,
    });

    const llmMessages = historyToLlmMessages(history, question, focus, historyLimit);
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
    const tools = options.buildTools?.({ bookId: input.bookId, focus, reportEvidence }) ?? [];

    const agent = new Agent({
      initialState: {
        systemPrompt: buildSystemPrompt(profile),
        model: toLlmModel(connection),
        messages: llmMessages.slice(0, -1),
        tools,
      },
      streamFn: makeStreamFn(connection),
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
      assistantFailure = {
        status: "error",
        message: error instanceof Error ? `回答生成失败：${error.message}` : "回答生成失败。",
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
      void enqueue(sessionId, () => executeRun({
        runId,
        sessionId,
        bookId: input.bookId,
        question,
        focus,
        connection,
        profile,
      }));
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

    getConversation(bookId: unknown): ConversationMessage[] {
      if (!isBookId(bookId)) return [];
      const session = store.findSession(bookId);
      return session ? store.listMessages(session.id) : [];
    },

    close() {
      store.close();
    },
  };
}

export type AgentHost = ReturnType<typeof createAgentHost>;
