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

  it("searchMessages 只返回本书已完成消息并按时间倒序", async () => {
    store = createSessionStore(dataHome);
    const { append } = seedConversation(BOOK_ID);
    append("第一条 讲解能量守恒");
    await new Promise((resolve) => setTimeout(resolve, 5));
    append("第二条 讲解动量守恒");
    append("失败回答不参与检索", "error");
    seedConversation(OTHER_BOOK_ID).append("另一本书 讲解能量守恒");

    expect(store.searchMessages(BOOK_ID, "%能量守恒%")).toEqual([
      { id: expect.any(String), body: "第一条 讲解能量守恒" },
    ]);
    const both = store.searchMessages(BOOK_ID, "%讲解%");
    expect(both.map((hit) => hit.body)).toEqual(["第二条 讲解动量守恒", "第一条 讲解能量守恒"]);
    expect(store.searchMessages("c".repeat(64), "%讲解%")).toEqual([]);
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
});
