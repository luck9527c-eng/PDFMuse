import type {
  AgentStreamEvent,
  ConversationMessage,
  RunDiagnostics,
  RunDiagnosticsRequest,
  RunDiagnosticsToolCall,
  RunDiagnosticsUsage,
} from "../shared/contracts";
import { createAgentEventBuffer } from "./agent-event-buffer";

export type StreamingReply = { runId: string; sessionId: string; body: string };

export type ConversationControllerState = {
  messages: ConversationMessage[];
  loading: boolean;
  streaming?: StreamingReply;
  toolStatus?: string;
  notice: string;
  /** 运行诊断：实时事件合入 + 打开抽屉时拉取的环形缓冲。 */
  diagnostics: Record<string, RunDiagnostics>;
};

const INITIAL_STATE: ConversationControllerState = {
  messages: [],
  loading: false,
  notice: "",
  diagnostics: {},
};

const TOOL_TITLES: Record<string, string> = {
  search_book: "检索本书",
  read_outline: "读取目录",
  read_section: "读取章节",
  read_pages: "读取页面",
  view_page: "查看页面原图",
  search_web: "联网搜索",
  // T51 改名前的旧名：跨版本在途运行的状态条仍可渲染中文标题。
  book_search: "检索本书",
  read_page_image: "查看页面原图",
  web_search: "联网搜索",
};

function emptyDiagnostics(runId: string): RunDiagnostics {
  return {
    runId,
    sessionId: "",
    question: "",
    startedAt: "",
    status: "running",
    requests: [],
    toolCalls: [],
    timeline: [],
  };
}

/** 增量合入诊断事件；与主进程采集器语义一致（请求追加、完成回填、工具去重追加）。 */
function mergeDiagnosticsEvent(state: ConversationControllerState, event: Extract<AgentStreamEvent, { stream: "diagnostics" }>): Record<string, RunDiagnostics> {
  const current = { ...(state.diagnostics[event.runId] ?? emptyDiagnostics(event.runId)) };
  const next = { ...state.diagnostics };
  if (event.kind === "request") {
    if (!current.requests.some((item) => item.callIndex === event.request.callIndex)) {
      current.requests = [...current.requests, event.request];
      current.sessionId = event.sessionId;
    }
  } else if (event.kind === "request-complete") {
    current.requests = current.requests.map((item) => (
      item.callIndex === event.callIndex
        ? { ...item, durationMs: event.durationMs, ...(event.usage ? { usage: event.usage } : {}) }
        : item
    ));
  } else if (event.kind === "tool") {
    if (!current.toolCalls.some((item) => item.callId === event.toolCall.callId)) {
      current.toolCalls = [...current.toolCalls, event.toolCall];
    }
  }
  next[event.runId] = current;
  return next;
}

/** 终态事件携带的运行出口（T50 Exit Reason）合入诊断记录：结束原因与已用/总圈数。 */
function mergeExitInfo(state: ConversationControllerState, runId: string, exit: NonNullable<Extract<AgentStreamEvent, { stream: "lifecycle" }>["exit"]>): Record<string, RunDiagnostics> {
  const current = { ...(state.diagnostics[runId] ?? emptyDiagnostics(runId)) };
  return {
    ...state.diagnostics,
    [runId]: {
      ...current,
      exitReason: exit.exitReason,
      roundsUsed: exit.roundsUsed,
      roundsTotal: exit.roundsTotal,
    },
  };
}

export type ConversationAction =
  | { type: "agent-event"; event: AgentStreamEvent }
  | { type: "run-started"; runId: string; sessionId: string; question: string; passage?: { page: number; text: string; rects: unknown } }
  | { type: "run-rejected"; message: string }
  | { type: "run-start-failed" }
  | { type: "conversation-loading" }
  | { type: "conversation-loaded"; messages: ConversationMessage[] }
  | { type: "conversation-error"; message: string }
  | { type: "clear-succeeded" }
  | { type: "diagnostics-loaded"; runs: RunDiagnostics[] }
  | { type: "notice"; message: string }
  | { type: "reset" };

export type ConversationDispatchResult = { terminalRunId?: string };

/**
 * Book Conversation 的纯状态机：流式事件路由（含 runId 返回前的缓冲回放）、
 * 乐观上屏与终态清理。React 只做订阅，业务规则全部在此测试。
 */
export function createConversationController() {
  let state: ConversationControllerState = INITIAL_STATE;
  const listeners = new Set<() => void>();
  const buffer = createAgentEventBuffer();

  const commit = (patch: Partial<ConversationControllerState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };

  /** 单个已路由事件的状态迁移；终态返回 runId 供上层刷新持久化数据。 */
  const applyAgentEvent = (event: AgentStreamEvent): string | undefined => {
    if (event.stream === "diagnostics") {
      commit({ diagnostics: mergeDiagnosticsEvent(state, event) });
      return undefined;
    }
    // 终态出口信息（T50）：无论流式态是否匹配都合入诊断记录（抽屉展示结束原因与圈数）。
    if (event.stream === "lifecycle" && event.exit
      && (event.phase === "end" || event.phase === "error" || event.phase === "cancelled")) {
      commit({ diagnostics: mergeExitInfo(state, event.runId, event.exit) });
    }
    if (state.streaming?.runId !== event.runId) return undefined;
    if (event.stream === "assistant") {
      commit({ streaming: { ...state.streaming, body: state.streaming.body + event.delta } });
      return undefined;
    }
    if (event.stream === "tool") {
      const title = TOOL_TITLES[event.name] ?? event.name;
      commit({ toolStatus: event.phase === "end" ? `${title}完成` : `${title}中...` });
      return undefined;
    }
    if (event.stream === "lifecycle" && (event.phase === "end" || event.phase === "cancelled" || event.phase === "error")) {
      const runId = event.runId;
      commit({ streaming: undefined, toolStatus: undefined });
      return runId;
    }
    return undefined;
  };

  return {
    getState(): ConversationControllerState {
      return state;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** 是否有运行中的回答；发送/清空等入口据此互斥。 */
    isBusy(): boolean {
      return Boolean(state.streaming);
    },

    beginStart() {
      buffer.beginStart();
    },

    cancelStart() {
      buffer.cancelStart();
    },

    dispatch(action: ConversationAction): ConversationDispatchResult {
      switch (action.type) {
        case "agent-event": {
          const routed = buffer.route(action.event, state.streaming?.runId);
          let terminalRunId: string | undefined;
          for (const event of routed) {
            const terminal = applyAgentEvent(event);
            if (terminal) terminalRunId = terminal;
          }
          return terminalRunId ? { terminalRunId } : {};
        }
        case "run-started": {
          commit({
            messages: [
              ...state.messages,
              {
                id: `pending-${action.runId}`,
                sessionId: action.sessionId,
                runId: action.runId,
                role: "reader",
                body: action.question,
                status: "complete",
                ...(action.passage
                  ? { passage: { page: action.passage.page, text: action.passage.text, rects: action.passage.rects as never } }
                  : {}),
                createdAt: new Date().toISOString(),
              },
            ],
            streaming: { runId: action.runId, sessionId: action.sessionId, body: "" },
            notice: "",
          });
          for (const event of buffer.activate(action.runId)) applyAgentEvent(event);
          return {};
        }
        case "run-rejected":
          buffer.cancelStart();
          commit({ notice: action.message });
          return {};
        case "run-start-failed":
          buffer.cancelStart();
          commit({ notice: "无法发起回答，请重试。" });
          return {};
        case "conversation-loading":
          commit({ loading: true });
          return {};
        case "conversation-loaded":
          commit({ messages: action.messages, loading: false });
          return {};
        case "conversation-error":
          commit({ notice: action.message, loading: false });
          return {};
        case "clear-succeeded":
          commit({ messages: [], notice: "本书会话已清空。" });
          return {};
        case "diagnostics-loaded": {
          const merged = { ...state.diagnostics };
          for (const run of action.runs) {
            const live = merged[run.runId];
            // 实时事件已覆盖运行中的记录时不回退为拉取快照。
            merged[run.runId] = live && live.requests.length >= run.requests.length ? live : run;
          }
          commit({ diagnostics: merged });
          return {};
        }
        case "notice":
          commit({ notice: action.message });
          return {};
        case "reset":
          state = INITIAL_STATE;
          for (const listener of listeners) listener();
          return {};
      }
    },
  };
}

export type ConversationController = ReturnType<typeof createConversationController>;
