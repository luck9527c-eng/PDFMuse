import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSessionStore } from "./session-store.js";

const BOOK_ID = "a".repeat(64);
const OTHER_BOOK_ID = "b".repeat(64);

describe("session store", () => {
  let dataHome: string;
  let store: ReturnType<typeof createSessionStore>;

  beforeEach(async () => {
    dataHome = await mkdtemp(path.join(os.tmpdir(), "pdfmuse-session-"));
  });

  afterEach(async () => {
    store?.close();
    await rm(dataHome, { recursive: true, force: true });
  });

  function seedConversation(bookId: string) {
    const session = store.ensureSession(bookId);
    const append = (body: string, status: "complete" | "error" = "complete") => (
      store.appendMessage({ sessionId: session.id, runId: "run", role: "reader", body, status })
    );
    return { session, append };
  }

  it("finalizeRun 同事务落运行出口行，可按会话读回；清空会话一并清除（T50）", () => {
    store = createSessionStore(dataHome);
    const session = store.ensureSession(BOOK_ID);
    const message = store.appendMessage({ sessionId: session.id, runId: "run-a", role: "assistant", body: "", status: "streaming" });
    store.finalizeRun({
      sessionId: session.id,
      runId: "run-a",
      toolCalls: [],
      message: { messageId: message.id, body: "回答", status: "complete" },
      exit: { exitReason: "max_iterations_reached", roundsUsed: 50, roundsTotal: 50 },
    });
    // 缺省 exit 不写行（旧路径行为不变）。
    store.finalizeRun({ sessionId: session.id, runId: "run-b", toolCalls: [] });

    expect(store.listRunOutcomes(session.id)).toEqual([
      { runId: "run-a", exitReason: "max_iterations_reached", roundsUsed: 50, roundsTotal: 50 },
    ]);

    store.clearConversation(BOOK_ID);
    expect(store.listRunOutcomes(session.id)).toEqual([]);
  });

  it("deleteBookData 在给定连接上清掉本书会话与消息且不影响他书", () => {
    store = createSessionStore(dataHome);
    const kept = seedConversation(OTHER_BOOK_ID);
    kept.append("另一本书保留的消息");
    const removed = seedConversation(BOOK_ID);
    removed.append("会被删除的问题");

    const connection = new DatabaseSync(path.join(dataHome, "pdfmuse.db"));
    store.deleteBookData(BOOK_ID, connection);
    connection.close();

    expect(store.findSession(BOOK_ID)).toBeUndefined();
    expect(store.listMessages(removed.session.id)).toEqual([]);
    expect(store.findSession(OTHER_BOOK_ID)).toBeDefined();
    expect(store.listMessages(kept.session.id)).toHaveLength(1);
  });

  it("clearConversation 在事务内调用会话向量清理钩子", () => {
    const probe = new DatabaseSync(path.join(dataHome, "pdfmuse.db"));
    probe.exec("CREATE TABLE embedding_probe (book_id TEXT NOT NULL)");
    probe.close();
    const calls: string[] = [];
    store = createSessionStore(dataHome, {
      deleteConversationEmbeddings: (bookId, database) => {
        calls.push(bookId);
        database.prepare("INSERT INTO embedding_probe (book_id) VALUES (?)").run(bookId);
      },
    });
    const { session, append } = seedConversation(BOOK_ID);
    append("要被清空的问题");
    store.saveSummary(session.id, "旧摘要", "任意");

    store.clearConversation(BOOK_ID);

    expect(calls).toEqual([BOOK_ID]);
    expect(store.listMessages(session.id)).toEqual([]);
    expect(store.getSummary(session.id)).toBeUndefined();
    const verified = new DatabaseSync(path.join(dataHome, "pdfmuse.db"), { readOnly: true });
    expect((verified.prepare("SELECT COUNT(*) AS count FROM embedding_probe").get() as { count: number }).count).toBe(1);
    verified.close();
  });

  it("clearConversation 的向量清理钩子失败时回滚消息与摘要", () => {
    store = createSessionStore(dataHome, {
      deleteConversationEmbeddings: () => {
        throw new Error("向量删除失败");
      },
    });
    const { session, append } = seedConversation(BOOK_ID);
    append("不能丢失的问题");
    store.saveSummary(session.id, "必须保留的摘要", "任意");

    expect(() => store.clearConversation(BOOK_ID)).toThrow();
    expect(store.listMessages(session.id)).toHaveLength(1);
    expect(store.getSummary(session.id)).toEqual({ summary: "必须保留的摘要", throughMessageId: "任意" });
  });

  it("未注入向量清理钩子时 clearConversation 仍然可用", () => {
    store = createSessionStore(dataHome);
    const { session, append } = seedConversation(BOOK_ID);
    append("直接清空的问题");

    expect(() => store.clearConversation(BOOK_ID)).not.toThrow();
    expect(store.listMessages(session.id)).toEqual([]);
  });

  it("压缩锚点随会话保存读回，清空会话时一并失效（T37/ADR 0010）", () => {
    store = createSessionStore(dataHome);
    const { session, append } = seedConversation(BOOK_ID);
    const lastMessage = append("旧问题");
    expect(store.getSessionAnchor(session.id)).toBeUndefined();

    store.saveSessionAnchor(session.id, 4321, "test-model", lastMessage.id);
    expect(store.getSessionAnchor(session.id)).toEqual({
      inputTokens: 4321,
      model: "test-model",
      throughMessageId: lastMessage.id,
    });

    store.clearConversation(BOOK_ID);
    expect(store.getSessionAnchor(session.id)).toBeUndefined();
  });

  it("旧库缺锚点列时自动迁移并可写入（T37）", async () => {
    store = createSessionStore(dataHome);
    const { session } = seedConversation(BOOK_ID);
    store.close();
    // 模拟 T37 之前的库：agent_sessions 没有锚点三列。
    const database = new DatabaseSync(path.join(dataHome, "pdfmuse.db"));
    database.exec(`
      ALTER TABLE agent_sessions DROP COLUMN last_input_tokens;
      ALTER TABLE agent_sessions DROP COLUMN anchor_model;
      ALTER TABLE agent_sessions DROP COLUMN anchor_through_id;
    `);
    database.close();

    const reopened = createSessionStore(dataHome);
    reopened.saveSessionAnchor(session.id, 77, "m", "msg-1");
    expect(reopened.getSessionAnchor(session.id)).toEqual({
      inputTokens: 77,
      model: "m",
      throughMessageId: "msg-1",
    });
    reopened.close();
    store = undefined as unknown as ReturnType<typeof createSessionStore>;
  });

  it("finalizeRun 批量落工具行：seq 按入参序、字段完整、消息同事务收尾（T44）", () => {
    store = createSessionStore(dataHome);
    const session = store.ensureSession(BOOK_ID);
    const streaming = store.appendMessage({ sessionId: session.id, runId: "run-t44", role: "assistant", body: "", status: "streaming" });
    const finalized = store.finalizeRun({
      sessionId: session.id,
      runId: "run-t44",
      toolCalls: [
        { callId: "call-2", toolName: "book_search", title: "检索本书", argumentsJson: '{"query":"二"}', resultText: "结果二", status: "executed", isError: false },
        { callId: "call-1", toolName: "book_search", title: "检索本书", argumentsJson: '{"query":"一"}', resultText: "结果一", status: "executed", isError: false },
      ],
      message: { messageId: streaming.id, body: "回答", status: "complete" },
    });

    expect(finalized).toBe(true);
    const database = new DatabaseSync(path.join(dataHome, "pdfmuse.db"), { readOnly: true });
    const rows = database.prepare("SELECT * FROM agent_tool_calls ORDER BY created_at, seq").all() as Array<Record<string, unknown>>;
    database.close();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.seq)).toEqual([1, 2]);
    expect(rows[0]).toMatchObject({
      session_id: session.id,
      run_id: "run-t44",
      call_id: "call-2",
      tool_name: "book_search",
      title: "检索本书",
      arguments_json: '{"query":"二"}',
      result_text: "结果二",
      status: "executed",
      is_error: 0,
      media_path: null,
    });
    expect(store.listMessages(session.id).at(-1)).toMatchObject({ body: "回答", status: "complete" });
  });

  it("finalizeRun 消息所有权失败仍落工具行，且可只落工具行（T44 收尾漏洞修复）", () => {
    store = createSessionStore(dataHome);
    const session = store.ensureSession(BOOK_ID);
    // 消息属于另一个 run：所有权校验失败，消息不收尾但工具行照常落库。
    const otherRun = store.appendMessage({ sessionId: session.id, runId: "other-run", role: "assistant", body: "", status: "streaming" });
    const finalized = store.finalizeRun({
      sessionId: session.id,
      runId: "run-t44b",
      toolCalls: [{ callId: "call-x", toolName: "read_pages", title: "读取页面", argumentsJson: "{}", resultText: "页面文本", status: "executed", isError: false }],
      message: { messageId: otherRun.id, body: "不应生效", status: "complete" },
    });
    expect(finalized).toBe(false);
    // 无消息输入（首请求即失败等终态）也照常落行。
    store.finalizeRun({
      sessionId: session.id,
      runId: "run-t44c",
      toolCalls: [{ callId: "call-y", toolName: "book_search", title: "检索本书", argumentsJson: "{}", resultText: "拒绝", status: "rejected", isError: true, mediaPath: '[{"page":3,"path":"x/p3.png"}]' }],
    });
    const database = new DatabaseSync(path.join(dataHome, "pdfmuse.db"), { readOnly: true });
    const rows = database.prepare("SELECT run_id, call_id, status, is_error, media_path FROM agent_tool_calls ORDER BY created_at, seq").all() as Array<Record<string, unknown>>;
    database.close();
    expect(rows).toEqual([
      { run_id: "run-t44b", call_id: "call-x", status: "executed", is_error: 0, media_path: null },
      { run_id: "run-t44c", call_id: "call-y", status: "rejected", is_error: 1, media_path: '[{"page":3,"path":"x/p3.png"}]' },
    ]);
    // streaming 行经公开视图映射为 cancelled（中断语义），证明消息未被收尾。
    expect(store.listMessages(session.id).at(-1)?.status).toBe("cancelled");
  });

  it("clearConversation 与 deleteBookData 一并清理工具行（T44）", () => {
    store = createSessionStore(dataHome);
    const session = store.ensureSession(BOOK_ID);
    store.finalizeRun({
      sessionId: session.id,
      runId: "run-x",
      toolCalls: [{ callId: "c", toolName: "book_search", title: "检索本书", argumentsJson: "{}", resultText: "r", status: "executed", isError: false }],
    });
    const other = store.ensureSession(OTHER_BOOK_ID);
    store.finalizeRun({
      sessionId: other.id,
      runId: "run-y",
      toolCalls: [{ callId: "c2", toolName: "book_search", title: "检索本书", argumentsJson: "{}", resultText: "r2", status: "executed", isError: false }],
    });

    store.clearConversation(BOOK_ID);
    const database = new DatabaseSync(path.join(dataHome, "pdfmuse.db"));
    const countFor = (bookId: string) => (database.prepare(
      "SELECT COUNT(*) AS n FROM agent_tool_calls WHERE session_id IN (SELECT id FROM agent_sessions WHERE book_id = ?)",
    ).get(bookId) as { n: number }).n;
    expect(countFor(BOOK_ID)).toBe(0);
    expect(countFor(OTHER_BOOK_ID)).toBe(1);

    store.deleteBookData(OTHER_BOOK_ID, database);
    expect(countFor(OTHER_BOOK_ID)).toBe(0);
    database.close();
  });
});
