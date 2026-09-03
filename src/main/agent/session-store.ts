import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { AgentMessageStatus, ConversationMessage, ReadingFocus } from "../../shared/contracts.js";

type SessionRow = {
  id: string;
  book_id: string;
  created_at: string;
  updated_at: string;
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
  created_at: string;
};

const PASSAGE_FOCUS_COLUMNS = "focus_json";

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
        };
      }
    } catch {
      // 旧的或不完整的 focus 记录不进入会话展示。
    }
  }
  return message;
}

export function createSessionStore(dataHome: string) {
  const database = new DatabaseSync(path.join(dataHome, "pdfmuse.db"));
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_messages_session_order
      ON agent_messages(session_id, created_at, id);
  `);

  const findSessionStatement = database.prepare(`
    SELECT id, book_id, created_at, updated_at FROM agent_sessions WHERE book_id = ?
  `);
  const insertSessionStatement = database.prepare(`
    INSERT INTO agent_sessions (id, book_id, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(book_id) DO NOTHING
  `);
  const touchSessionStatement = database.prepare(`
    UPDATE agent_sessions SET updated_at = ? WHERE id = ?
  `);
  const insertMessageStatement = database.prepare(`
    INSERT INTO agent_messages (
      id, session_id, run_id, role, body, status, error_message, ${PASSAGE_FOCUS_COLUMNS}, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateMessageStatement = database.prepare(`
    UPDATE agent_messages
    SET body = ?, status = ?, error_message = ?, updated_at = ?
    WHERE id = ? AND session_id = ?
  `);
  const listMessagesStatement = database.prepare(`
    SELECT id, session_id, run_id, role, body, status, error_message, focus_json, created_at
    FROM agent_messages
    WHERE session_id = ?
    ORDER BY created_at ASC, id ASC
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
          ? { passage: { page: input.focus.selectedPassage.page, text: input.focus.selectedPassage.text } }
          : {}),
      };
    },

    // 仅当消息仍处于 streaming 语义时才允许同一运行收尾；过期运行不得覆盖新结果。
    finalizeMessage(input: {
      sessionId: string;
      messageId: string;
      runId: string;
      body: string;
      status: AgentMessageStatus;
      errorMessage?: string;
    }) {
      const owned = database.prepare(
        "SELECT run_id FROM agent_messages WHERE id = ? AND session_id = ?",
      ).get(input.messageId, input.sessionId) as { run_id: string } | undefined;
      if (!owned || owned.run_id !== input.runId) return false;
      updateMessageStatement.run(
        input.body,
        input.status,
        input.errorMessage ?? null,
        now(),
        input.messageId,
        input.sessionId,
      );
      touchSessionStatement.run(now(), input.sessionId);
      return true;
    },

    listMessages(sessionId: string): ConversationMessage[] {
      return (listMessagesStatement.all(sessionId) as MessageRow[]).map(toConversationMessage);
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
