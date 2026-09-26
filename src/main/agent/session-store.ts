import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  AgentMessageStatus,
  ConversationEvidence,
  ConversationMessage,
  ReadingFocus,
  RunExitInfo,
} from "../../shared/contracts.js";

type SessionRow = {
  id: string;
  book_id: string;
  created_at: string;
  updated_at: string;
  summary: string | null;
  summary_through_id: string | null;
};

/** 持久层消息状态比契约多一个 streaming：回答开始即落盘，结束后收尾。 */
type StoredMessageStatus = AgentMessageStatus | "streaming";

type MessageRow = {
  id: string;
  session_id: string;
  run_id: string;
  role: "reader" | "assistant";
  body: string;
  status: StoredMessageStatus;
  error_message: string | null;
  focus_json: string | null;
  evidence_json: string | null;
  created_at: string;
};

function parseEvidence(json: string | null): ConversationEvidence[] | undefined {
  if (!json) return undefined;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return undefined;
    return parsed.filter((item): item is ConversationEvidence => (
      typeof item === "object" && item !== null
      && (item as { source?: unknown }).source === "pdf"
      && Number.isSafeInteger((item as { page?: unknown }).page)
      && typeof (item as { snippet?: unknown }).snippet === "string"
    ));
  } catch {
    return undefined;
  }
}

function toConversationMessage(row: MessageRow): ConversationMessage {
  const message: ConversationMessage = {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id,
    role: row.role,
    body: row.body,
    status: row.status === "streaming" ? "cancelled" : row.status,
    errorMessage: row.status === "streaming" ? "程序中断，回答未完成。" : row.error_message ?? undefined,
    createdAt: row.created_at,
  };
  if (row.focus_json) {
    try {
      const focus = JSON.parse(row.focus_json) as ReadingFocus;
      if (focus.selectedPassage) {
        message.passage = {
          page: focus.selectedPassage.page,
          text: focus.selectedPassage.text,
          rects: focus.selectedPassage.rects,
        };
      }
    } catch {
      // 旧的或不完整的 focus 记录不进入会话展示。
    }
  }
  const evidence = parseEvidence(row.evidence_json);
  if (evidence && evidence.length > 0) message.evidence = evidence;
  return message;
}

export type SessionStoreOptions = {
  /**
   * 清空会话时清理会话语义向量（semantic_embeddings 表属检索模块）。
   * 在 clearConversation 的单一事务内以当前连接调用，保持消息、摘要与向量同进退；
   * 未注入时清空会话不触碰任何向量。
   */
  deleteConversationEmbeddings?: (bookId: string, database: DatabaseSync) => void;
};

/**
 * 工具调用落库行（T44）：一次 run 的完整调用轨迹，finalizeRun 时批量写入。
 * status 三类——executed（工具层实际执行）、rejected（工具层拒绝：预算/上限钳制）、error（执行出错）；
 * schema 校验被拒的调用不落库（发生在 vendored agent-loop 内部，宿主无捕获点）。
 */
export type PersistedToolCall = {
  /** 所属 run；写侧由 finalizeRun 的 input.runId 统一落列，读接口回填。 */
  runId: string;
  /** provider toolCallId，回放合成 toolCall/toolResult 配对的依据。 */
  callId: string;
  toolName: string;
  /** 工具注册表中文标题（冗余落库，展示与占位文案免反查）。 */
  title: string;
  argumentsJson: string;
  /** 结果文本全量（工具层截断是唯一截断，此处不二次截断）。 */
  resultText: string;
  status: "executed" | "rejected" | "error";
  isError: boolean;
  /** 图片行的媒体引用 JSON（`[{"page":N,"path":"<bookId>/<file>"}]`，相对 media 根目录）；非图片行为空。 */
  mediaPath?: string;
};

export function createSessionStore(dataHome: string, options: SessionStoreOptions = {}) {
  const database = new DatabaseSync(path.join(dataHome, "pdfmuse.db"));
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      summary TEXT,
      summary_through_id TEXT,
      last_input_tokens INTEGER,
      anchor_model TEXT,
      anchor_through_id TEXT
    );
    CREATE TABLE IF NOT EXISTS agent_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES agent_sessions(id),
      run_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('reader', 'assistant')),
      body TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('streaming', 'complete', 'error', 'cancelled')),
      error_message TEXT,
      focus_json TEXT,
      evidence_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_tool_calls (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES agent_sessions(id),
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      title TEXT NOT NULL,
      arguments_json TEXT NOT NULL,
      result_text TEXT NOT NULL,
      media_path TEXT,
      status TEXT NOT NULL CHECK (status IN ('executed', 'rejected', 'error')),
      is_error INTEGER NOT NULL CHECK (is_error IN (0, 1)),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_runs (
      run_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES agent_sessions(id),
      exit_reason TEXT NOT NULL,
      rounds_used INTEGER NOT NULL,
      rounds_total INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_messages_session_order
      ON agent_messages(session_id, created_at, id);
    CREATE INDEX IF NOT EXISTS agent_tool_calls_run_order
      ON agent_tool_calls(session_id, created_at, seq);
  `);
  const sessionColumns = new Set(
    (database.prepare("PRAGMA table_info(agent_sessions)").all() as { name: string }[])
      .map((column) => column.name),
  );
  if (!sessionColumns.has("summary")) database.exec("ALTER TABLE agent_sessions ADD COLUMN summary TEXT");
  if (!sessionColumns.has("summary_through_id")) database.exec("ALTER TABLE agent_sessions ADD COLUMN summary_through_id TEXT");
  // 旧库迁移：T37 压缩锚点三列（ADR 0010）。
  if (!sessionColumns.has("last_input_tokens")) database.exec("ALTER TABLE agent_sessions ADD COLUMN last_input_tokens INTEGER");
  if (!sessionColumns.has("anchor_model")) database.exec("ALTER TABLE agent_sessions ADD COLUMN anchor_model TEXT");
  if (!sessionColumns.has("anchor_through_id")) database.exec("ALTER TABLE agent_sessions ADD COLUMN anchor_through_id TEXT");
  // 旧库迁移：T08 之前的 agent_messages 没有 evidence_json。
  const messageColumns = new Set(
    (database.prepare("PRAGMA table_info(agent_messages)").all() as { name: string }[])
      .map((column) => column.name),
  );
  if (!messageColumns.has("evidence_json")) {
    database.exec("ALTER TABLE agent_messages ADD COLUMN evidence_json TEXT");
  }

  const findSessionStatement = database.prepare(`
    SELECT id, book_id, created_at, updated_at, summary, summary_through_id FROM agent_sessions WHERE book_id = ?
  `);
  const insertSessionStatement = database.prepare(`
    INSERT INTO agent_sessions (id, book_id, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(book_id) DO NOTHING
  `);
  const touchSessionStatement = database.prepare(`
    UPDATE agent_sessions SET updated_at = ? WHERE id = ?
  `);
  const updateSummaryStatement = database.prepare(`
    UPDATE agent_sessions SET summary = ?, summary_through_id = ?, updated_at = ? WHERE id = ?
  `);
  const clearMessagesStatement = database.prepare("DELETE FROM agent_messages WHERE session_id = ?");
  const resetSessionStateStatement = database.prepare(`
    UPDATE agent_sessions
    SET summary = NULL, summary_through_id = NULL, last_input_tokens = NULL, anchor_model = NULL, anchor_through_id = NULL, updated_at = ?
    WHERE id = ?
  `);
  const insertMessageStatement = database.prepare(`
    INSERT INTO agent_messages (
      id, session_id, run_id, role, body, status, error_message, focus_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertToolCallStatement = database.prepare(`
    INSERT INTO agent_tool_calls (
      id, session_id, run_id, seq, call_id, tool_name, title, arguments_json, result_text, media_path, status, is_error, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const upsertRunStatement = database.prepare(`
    INSERT INTO agent_runs (run_id, session_id, exit_reason, rounds_used, rounds_total, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      exit_reason = excluded.exit_reason,
      rounds_used = excluded.rounds_used,
      rounds_total = excluded.rounds_total
  `);
  const clearToolCallsStatement = database.prepare("DELETE FROM agent_tool_calls WHERE session_id = ?");
  const clearRunsStatement = database.prepare("DELETE FROM agent_runs WHERE session_id = ?");
  const updateMessageStatement = database.prepare(`
    UPDATE agent_messages
    SET body = ?, status = ?, error_message = ?, evidence_json = COALESCE(?, evidence_json), updated_at = ?
    WHERE id = ? AND session_id = ?
  `);
  const findMessageRunStatement = database.prepare(
    "SELECT run_id, status FROM agent_messages WHERE id = ? AND session_id = ?",
  );
  const listMessagesStatement = database.prepare(`
    SELECT id, session_id, run_id, role, body, status, error_message, focus_json, evidence_json, created_at
    FROM agent_messages
    WHERE session_id = ?
    ORDER BY created_at ASC, id ASC
  `);
  const listToolCallsStatement = database.prepare(`
    SELECT run_id, call_id, tool_name, title, arguments_json, result_text, media_path, status, is_error
    FROM agent_tool_calls
    WHERE session_id = ?
    ORDER BY created_at ASC, seq ASC
  `);
  const abandonStreamingStatement = database.prepare(`
    UPDATE agent_messages
    SET status = 'cancelled', error_message = ?, updated_at = ?
    WHERE status = 'streaming'
  `);

  function now() {
    return new Date().toISOString();
  }

  return {
    ensureSession(bookId: string): SessionRow {
      const timestamp = now();
      insertSessionStatement.run(randomUUID(), bookId, timestamp, timestamp);
      const row = findSessionStatement.get(bookId) as SessionRow;
      return row;
    },

    findSession(bookId: string): SessionRow | undefined {
      return findSessionStatement.get(bookId) as SessionRow | undefined;
    },

    getSummary(sessionId: string): { summary: string; throughMessageId: string } | undefined {
      const row = database.prepare("SELECT summary, summary_through_id FROM agent_sessions WHERE id = ?").get(sessionId) as
        | { summary: string | null; summary_through_id: string | null }
        | undefined;
      if (!row?.summary || !row.summary_through_id) return undefined;
      return { summary: row.summary, throughMessageId: row.summary_through_id };
    },

    saveSummary(sessionId: string, summary: string, throughMessageId: string) {
      updateSummaryStatement.run(summary, throughMessageId, now(), sessionId);
    },

    /**
     * 压缩锚点（ADR 0010）：最近一次 complete 运行的 provider 真实 input。
     * throughMessageId 是落锚点时的会话末条消息，锚点之后的增量据此估算。
     */
    saveSessionAnchor(sessionId: string, inputTokens: number, model: string, throughMessageId: string) {
      database.prepare(`
        UPDATE agent_sessions
        SET last_input_tokens = ?, anchor_model = ?, anchor_through_id = ?, updated_at = ?
        WHERE id = ?
      `).run(inputTokens, model, throughMessageId, now(), sessionId);
    },

    getSessionAnchor(sessionId: string): { inputTokens: number; model: string; throughMessageId: string } | undefined {
      const row = database.prepare(
        "SELECT last_input_tokens, anchor_model, anchor_through_id FROM agent_sessions WHERE id = ?",
      ).get(sessionId) as
        | { last_input_tokens: number | null; anchor_model: string | null; anchor_through_id: string | null }
        | undefined;
      if (!row?.last_input_tokens || !row.anchor_model || !row.anchor_through_id) return undefined;
      return { inputTokens: row.last_input_tokens, model: row.anchor_model, throughMessageId: row.anchor_through_id };
    },

    clearConversation(bookId: string) {
      const session = findSessionStatement.get(bookId) as SessionRow | undefined;
      if (!session) return;
      database.exec("BEGIN IMMEDIATE");
      try {
        clearRunsStatement.run(session.id);
        clearToolCallsStatement.run(session.id);
        clearMessagesStatement.run(session.id);
        resetSessionStateStatement.run(now(), session.id);
        options.deleteConversationEmbeddings?.(bookId, database);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },

    /** 每书数据清理钩子：在调用方提供的连接上删除本书会话与消息（消息先删以满足外键）。 */
    deleteBookData(bookId: string, connection: DatabaseSync) {
      connection.prepare(
        "DELETE FROM agent_runs WHERE session_id IN (SELECT id FROM agent_sessions WHERE book_id = ?)",
      ).run(bookId);
      connection.prepare(
        "DELETE FROM agent_tool_calls WHERE session_id IN (SELECT id FROM agent_sessions WHERE book_id = ?)",
      ).run(bookId);
      connection.prepare(
        "DELETE FROM agent_messages WHERE session_id IN (SELECT id FROM agent_sessions WHERE book_id = ?)",
      ).run(bookId);
      connection.prepare("DELETE FROM agent_sessions WHERE book_id = ?").run(bookId);
    },

    appendMessage(input: {
      sessionId: string;
      runId: string;
      role: "reader" | "assistant";
      body: string;
      status: StoredMessageStatus;
      errorMessage?: string;
      focus?: ReadingFocus;
    }): ConversationMessage {
      const timestamp = now();
      const id = randomUUID();
      insertMessageStatement.run(
        id,
        input.sessionId,
        input.runId,
        input.role,
        input.body,
        input.status,
        input.errorMessage ?? null,
        input.focus ? JSON.stringify(input.focus) : null,
        timestamp,
        timestamp,
      );
      touchSessionStatement.run(timestamp, input.sessionId);
      return {
        id,
        sessionId: input.sessionId,
        runId: input.runId,
        role: input.role,
        body: input.body,
        status: input.status === "streaming" ? "cancelled" : input.status,
        createdAt: timestamp,
        ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
        ...(input.focus?.selectedPassage
          ? {
            passage: {
              page: input.focus.selectedPassage.page,
              text: input.focus.selectedPassage.text,
              rects: input.focus.selectedPassage.rects,
            },
          }
          : {}),
      };
    },

    /**
     * run 级收尾（T44/T50）：单一事务内完成本 run 工具行的批量 INSERT、（若有）assistant 消息的
     * 收尾 UPDATE 与运行出口行（Exit Reason + 圈数）的写入。工具行以入参数组顺序写入 seq（1 起），
     * 读取排序一律 `(created_at, seq)`。崩溃等未达终态的 run 不会调到本接口，工具行一行不留
     * （与「失败 run 排除回放」口径一致）。返回值表示消息是否收尾成功（所有权校验失败或未提供
     * 消息时为 false，工具行与出口行照常写入）。
     */
    finalizeRun(input: {
      sessionId: string;
      runId: string;
      toolCalls: PersistedToolCall[];
      message?: {
        messageId: string;
        body: string;
        status: AgentMessageStatus;
        errorMessage?: string;
        evidence?: ConversationEvidence[];
      };
      /** 运行出口（T50）：结束原因与已用/总圈数；缺省不写 agent_runs 行。 */
      exit?: RunExitInfo;
    }): boolean {
      const timestamp = now();
      database.exec("BEGIN IMMEDIATE");
      try {
        let messageFinalized = false;
        if (input.message) {
          const owned = findMessageRunStatement.get(input.message.messageId, input.sessionId) as
            | { run_id: string; status: string }
            | undefined;
          if (owned && owned.run_id === input.runId && owned.status === "streaming") {
            updateMessageStatement.run(
              input.message.body,
              input.message.status,
              input.message.errorMessage ?? null,
              input.message.evidence && input.message.evidence.length > 0 ? JSON.stringify(input.message.evidence) : null,
              timestamp,
              input.message.messageId,
              input.sessionId,
            );
            touchSessionStatement.run(timestamp, input.sessionId);
            messageFinalized = true;
          }
        }
        for (const [index, call] of input.toolCalls.entries()) {
          insertToolCallStatement.run(
            randomUUID(),
            input.sessionId,
            input.runId,
            index + 1,
            call.callId,
            call.toolName,
            call.title,
            call.argumentsJson,
            call.resultText,
            call.mediaPath ?? null,
            call.status,
            call.isError ? 1 : 0,
            timestamp,
          );
        }
        if (input.exit) {
          upsertRunStatement.run(
            input.runId,
            input.sessionId,
            input.exit.exitReason,
            input.exit.roundsUsed,
            input.exit.roundsTotal,
            timestamp,
          );
        }
        database.exec("COMMIT");
        return messageFinalized;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },

    listMessages(sessionId: string): ConversationMessage[] {
      return (listMessagesStatement.all(sessionId) as MessageRow[]).map(toConversationMessage);
    },

    /** 会话工具行读接口（T45）：回放装配与压缩估算按 `(created_at, seq)` 序消费。 */
    listToolCalls(sessionId: string): PersistedToolCall[] {
      return (listToolCallsStatement.all(sessionId) as Array<{
        run_id: string;
        call_id: string;
        tool_name: string;
        title: string;
        arguments_json: string;
        result_text: string;
        media_path: string | null;
        status: PersistedToolCall["status"];
        is_error: 0 | 1;
      }>).map((row) => ({
        runId: row.run_id,
        callId: row.call_id,
        toolName: row.tool_name,
        title: row.title,
        argumentsJson: row.arguments_json,
        resultText: row.result_text,
        status: row.status,
        isError: row.is_error === 1,
        ...(row.media_path ? { mediaPath: row.media_path } : {}),
      }));
    },

    /** 运行出口读接口（T50）：每次运行的结束原因与已用/总圈数，按落库时间倒序。 */
    listRunOutcomes(sessionId: string): Array<RunExitInfo & { runId: string }> {
      return (database.prepare(`
        SELECT run_id, exit_reason, rounds_used, rounds_total
        FROM agent_runs WHERE session_id = ? ORDER BY created_at DESC
      `).all(sessionId) as Array<{
        run_id: string;
        exit_reason: RunExitInfo["exitReason"];
        rounds_used: number;
        rounds_total: number;
      }>).map((row) => ({
        runId: row.run_id,
        exitReason: row.exit_reason,
        roundsUsed: row.rounds_used,
        roundsTotal: row.rounds_total,
      }));
    },

    // 异常退出遗留的 streaming 占位在下次启动时转为取消，保留已写入内容。
    abandonInterruptedMessages(message: string) {
      abandonStreamingStatement.run(message, now());
    },

    close() {
      database.close();
    },
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;
