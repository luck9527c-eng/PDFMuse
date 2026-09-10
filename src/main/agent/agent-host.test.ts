import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentStreamEvent, StartAgentRunResult } from "../../shared/contracts.js";
import { createAgentHost, type AgentHost } from "./agent-host.js";
import { createBookIndex } from "./book-index.js";
import type { ResolvedModelConnection } from "./model-runtime.js";
import {
  AssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "./openclaw-core.js";
import { createSessionStore } from "./session-store.js";
import { createLibraryModule } from "../library.js";
import { createToolRegistry } from "./tool-registry.js";

const FIXTURE = path.resolve(import.meta.dirname, "../fixtures/navigation.pdf");

const BOOK_ID = "a".repeat(64);
const CONNECTION: ResolvedModelConnection = {
  protocol: "openai",
  baseUrl: "http://127.0.0.1:1/v1",
  model: "test-model",
  apiKey: "test-key",
};

function assistantMessage(
  content: string,
  stopReason: AssistantMessage["stopReason"] = "stop",
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: content ? [{ type: "text", text: content }] : [],
    api: "openai-completions",
    provider: "pdfmuse",
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

type CapturedRequest = { model: Model; context: Context; options?: SimpleStreamOptions };

type FakeStreamScript = (input: {
  stream: AssistantMessageEventStream;
  request: CapturedRequest;
  push(event: AssistantMessageEvent): void;
}) => void | Promise<void>;

function createFakeStreamFn(script: FakeStreamScript) {
  const requests: CapturedRequest[] = [];
  const streamFn = async (model: Model, context: Context, options?: SimpleStreamOptions) => {
    const request: CapturedRequest = { model, context, options };
    requests.push(request);
    const stream = new AssistantMessageEventStream();
    void Promise.resolve().then(() => script({ stream, request, push: (event) => stream.push(event) }));
    return stream;
  };
  return { requests, streamFn };
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition was not met within the timeout.");
}

function lifecyclePhase(events: AgentStreamEvent[]) {
  return events
    .filter((event): event is Extract<AgentStreamEvent, { stream: "lifecycle" }> => event.stream === "lifecycle")
    .map((event) => event.phase);
}

describe("agent host", () => {
  let dataHome: string;
  let events: AgentStreamEvent[];
  let host: AgentHost;

  beforeEach(async () => {
    dataHome = await mkdtemp(path.join(os.tmpdir(), "pdfmuse-agent-"));
    events = [];
  });

  afterEach(async () => {
    host?.close();
    await rm(dataHome, { recursive: true, force: true });
  });

  function buildHost(overrides: Partial<Parameters<typeof createAgentHost>[0]> = {}) {
    host = createAgentHost({
      dataHome,
      emit: (event) => events.push(event),
      loadModelConnection: async () => CONNECTION,
      ...overrides,
    });
    return host;
  }

  async function startRun(question: string, focus?: unknown): Promise<StartAgentRunResult> {
    return host.start({ bookId: BOOK_ID, question, ...(focus ? { focus } : {}) });
  }

  function seedEmbedding(bookId: string, source: "pdf" | "conversation", sourceId: string) {
    const database = new DatabaseSync(path.join(dataHome, "pdfmuse.db"));
    database.exec(`
      CREATE TABLE IF NOT EXISTS semantic_embeddings (
        book_id TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('pdf', 'conversation')),
        source_id TEXT NOT NULL,
        page INTEGER,
        text TEXT NOT NULL,
        vector_json TEXT NOT NULL,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (book_id, source, source_id)
      )
    `);
    const timestamp = new Date().toISOString();
    database.prepare(`
      INSERT INTO semantic_embeddings
        (book_id, source, source_id, page, text, vector_json, model, dimensions, content_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'test', '[1]', 'test-model', 1, 'test-hash', ?, ?)
    `).run(bookId, source, sourceId, source === "pdf" ? 1 : null, timestamp, timestamp);
    database.close();
  }

  it("streams assistant deltas and persists both messages", async () => {
    const fake = createFakeStreamFn(({ push }) => {
      push({ type: "start", partial: assistantMessage("") });
      push({ type: "text_delta", contentIndex: 0, delta: "你" });
      push({ type: "text_delta", contentIndex: 0, delta: "好" });
      push({ type: "done", reason: "stop", message: assistantMessage("你好") });
    });
    buildHost({ createStreamFn: () => fake.streamFn });

    const result = await startRun("打个招呼");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await waitFor(() => events.some((event) => event.stream === "lifecycle" && event.phase === "end"));

    const deltas = events
      .filter((event): event is Extract<AgentStreamEvent, { stream: "assistant" }> => event.stream === "assistant")
      .map((event) => event.delta);
    expect(deltas).toEqual(["你", "好"]);

    const conversation = host.getConversation(BOOK_ID);
    expect(conversation.map((message) => [message.role, message.status])).toEqual([
      ["reader", "complete"],
      ["assistant", "complete"],
    ]);
    expect(conversation[1]?.body).toBe("你好");
    expect(conversation[0]?.runId).toBe(result.runId);

    const messageEvent = events.find((event): event is Extract<AgentStreamEvent, { stream: "message" }> => event.stream === "message");
    expect(messageEvent?.status).toBe("complete");
  });

  it("clears only the selected book conversation when no run is active", async () => {
    const otherBookId = "b".repeat(64);
    seedEmbedding(BOOK_ID, "conversation", "current-conversation");
    seedEmbedding(BOOK_ID, "pdf", "current-pdf");
    seedEmbedding(otherBookId, "conversation", "other-conversation");
    const fake = createFakeStreamFn(({ push }) => {
      push({ type: "start", partial: assistantMessage("") });
      push({ type: "done", reason: "stop", message: assistantMessage("回答") });
    });
    buildHost({
      createStreamFn: () => fake.streamFn,
      isKnownBook: () => true,
    });
    await host.start({ bookId: BOOK_ID, question: "当前书问题" });
    await host.start({ bookId: otherBookId, question: "另一本书问题" });
    await waitFor(() => host.getConversation(BOOK_ID).length === 2 && host.getConversation(otherBookId).length === 2);

    const result = await host.clearConversation(BOOK_ID);

    expect(result).toEqual({ ok: true });
    expect(host.getConversation(BOOK_ID)).toEqual([]);
    expect(host.getConversation(otherBookId)).toHaveLength(2);
    const database = new DatabaseSync(path.join(dataHome, "pdfmuse.db"), { readOnly: true });
    const embeddings = database.prepare(
      "SELECT book_id, source FROM semantic_embeddings ORDER BY book_id, source",
    ).all();
    database.close();
    expect(embeddings).toEqual([
      { book_id: BOOK_ID, source: "pdf" },
      { book_id: otherBookId, source: "conversation" },
    ]);
  });

  it("rolls back message deletion when conversation embedding cleanup fails", async () => {
    seedEmbedding(BOOK_ID, "conversation", "blocked-conversation");
    const fake = createFakeStreamFn(({ push }) => {
      push({ type: "start", partial: assistantMessage("") });
      push({ type: "done", reason: "stop", message: assistantMessage("回答") });
    });
    buildHost({ createStreamFn: () => fake.streamFn, isKnownBook: () => true });
    await startRun("不能丢失的问题");
    await waitFor(() => host.getConversation(BOOK_ID).length === 2);
    const database = new DatabaseSync(path.join(dataHome, "pdfmuse.db"));
    database.exec(`
      CREATE TRIGGER block_conversation_embedding_delete
      BEFORE DELETE ON semantic_embeddings
      WHEN OLD.source = 'conversation'
      BEGIN
        SELECT RAISE(ABORT, 'blocked');
      END
    `);
    database.close();

    const result = await host.clearConversation(BOOK_ID);

    expect(result).toMatchObject({ ok: false, code: "WRITE_ERROR" });
    expect(host.getConversation(BOOK_ID)).toHaveLength(2);
  });

  it("injects history, focus, reader profile and system prompt into the model context", async () => {
    const first = createFakeStreamFn(({ push }) => {
      push({ type: "start", partial: assistantMessage("") });
      push({ type: "done", reason: "stop", message: assistantMessage("第一轮回答") });
    });
    buildHost({ createStreamFn: () => first.streamFn });
    await startRun("第一个问题", { currentPage: 2 });
    await waitFor(() => events.some((event) => event.stream === "lifecycle" && event.phase === "end"));

    events = [];
    host.close();
    const second = createFakeStreamFn(({ push }) => {
      push({ type: "start", partial: assistantMessage("") });
      push({ type: "done", reason: "stop", message: assistantMessage("第二轮回答") });
    });
    buildHost({
      createStreamFn: () => second.streamFn,
      loadReaderProfile: async () => "我是工程师，偏好先结论后展开。",
      loadBookTitle: async () => "计算机组成原理（第3版）",
      resolveReadingSection: async () => "第5章 › 5.2 主存储器",
    });

    const focus = {
      currentPage: 3,
      selectedPassage: { bookId: BOOK_ID, page: 3, text: "选中的原文片段", rects: [] },
    };
    await startRun("第二个问题", focus);
    await waitFor(() => events.some((event) => event.stream === "lifecycle" && event.phase === "end"));

    expect(second.requests).toHaveLength(1);
    const request = second.requests[0]!;
    expect(request.context.systemPrompt).toContain("PDFMuse");
    expect(request.context.systemPrompt).toContain("Reader Profile");
    expect(request.context.systemPrompt).toContain("我是工程师，偏好先结论后展开。");
    expect(request.context.systemPrompt).toContain("计算机组成原理（第3版）");
    expect(request.context.systemPrompt).not.toContain("currentChapter");
    expect(request.context.systemPrompt).not.toContain("currentPage");
    expect(request.context.systemPrompt).toContain("简洁务实");
    expect(request.context.systemPrompt).not.toContain("不要在回答正文中反复插入页码");
    expect(request.context.tools).toEqual([]);
    const serialized = JSON.stringify(request.context.messages);
    expect(serialized).toContain("第一个问题");
    expect(serialized).toContain("第一轮回答");
    expect(serialized).toContain("第二个问题");
    expect(serialized).toContain("Selected Passage");
    expect(serialized).toContain("选中的原文片段");
    expect(serialized).not.toContain("当前阅读位置");
    // 无选段时，当前阅读页以 Reading Focus 进入问题消息。
    expect(JSON.stringify(first.requests[0]!.context.messages)).toContain("Reading Focus · Reader 当前阅读到第 2 页");
    // Main 侧解析的章节路径注入 Reading Focus，帮助模型定位相对引用。
    expect(serialized).toContain("所在章节「第5章 › 5.2 主存储器」");

    const conversation = host.getConversation(BOOK_ID);
    expect(conversation).toHaveLength(4);
    expect(conversation[2]?.passage).toEqual({ page: 3, text: "选中的原文片段", rects: [] });
  });

  it("uses OpenClaw compaction for long history while retaining raw messages", async () => {
    const sessionStore = createSessionStore(dataHome);
    const session = sessionStore.ensureSession(BOOK_ID);
    for (let index = 0; index < 8; index += 1) {
      sessionStore.appendMessage({ sessionId: session.id, runId: `old-${index}`, role: "reader", body: `历史问题 ${index} ${"内容".repeat(80)}`, status: "complete" });
      sessionStore.appendMessage({ sessionId: session.id, runId: `old-${index}`, role: "assistant", body: `历史回答 ${index} ${"回答".repeat(80)}`, status: "complete" });
    }
    sessionStore.close();

    let calls = 0;
    const fake = createFakeStreamFn(({ push }) => {
      calls += 1;
      push({ type: "start", partial: assistantMessage("") });
      push({ type: "done", reason: "stop", message: assistantMessage(calls === 1 ? "历史摘要" : "压缩后回答") });
    });
    buildHost({
      createStreamFn: () => fake.streamFn,
      compactionContextWindow: 80,
      compactionSettings: { reserveTokens: 16, keepRecentTokens: 16 },
    });

    const result = await startRun("压缩后的新问题");
    expect(result.ok).toBe(true);
    await waitFor(() => lifecyclePhase(events).includes("end"), 5_000);

    // OpenClaw 切点在预算不足时保留最新回答原文，把被切开的问题作为分轮前缀单独摘要：
    // 1 主摘要 + 2 分轮前缀摘要 + 3 回答。
    expect(calls).toBe(3);
    expect(fake.requests[2]?.context.messages.some((message) => (
      typeof message.content === "string" && message.content.includes("Conversation Summary")
    ))).toBe(true);
    const conversation = host.getConversation(BOOK_ID);
    expect(conversation.filter((message) => message.role === "reader")).toHaveLength(9);
    expect(conversation.at(-1)?.body).toBe("压缩后回答");
    const persisted = createSessionStore(dataHome);
    expect(persisted.getSummary(session.id)?.summary).toContain("历史摘要");
    expect(persisted.getSummary(session.id)?.summary).toContain("压缩后回答");
    persisted.close();
  });

  it("indexes only newly completed messages per run via the watermark", async () => {
    const indexed: Array<{ role: string; body: string }> = [];
    const streamFns = ["回答一", "回答二", "回答三"].map((body) => createFakeStreamFn(({ push }) => {
      push({ type: "start", partial: assistantMessage("") });
      push({ type: "done", reason: "stop", message: assistantMessage(body) });
    }));
    let call = 0;
    buildHost({
      createStreamFn: () => streamFns[call++]!.streamFn,
      indexConversationMessage: (_bookId, message) => indexed.push({ role: message.role, body: message.body }),
    });

    let finishedRuns = 0;
    for (const question of ["问题一", "问题二", "问题三"]) {
      finishedRuns += 1;
      const result = await startRun(question);
      expect(result.ok).toBe(true);
      await waitFor(() => lifecyclePhase(events).filter((phase) => phase === "end").length >= finishedRuns);
    }

    // 历史消息不重复索引：每轮只新增该轮的问与答。
    expect(indexed.map((item) => item.body)).toEqual([
      "问题一", "回答一", "问题二", "回答二", "问题三", "回答三",
    ]);
  });

  it("captures run diagnostics for requests, tool calls and usage", async () => {
    const library = createLibraryModule(dataHome);
    const bookIndex = createBookIndex(dataHome);
    const opened = await library.openPath(FIXTURE);
    expect(opened.ok).toBe(true);
    const fixtureBookId = opened.ok ? opened.book.id : "";
    const registry = createToolRegistry();

    const requests: CapturedRequest[] = [];
    const streamFn = async (model: Model, context: Context, options?: SimpleStreamOptions) => {
      const request: CapturedRequest = { model, context, options };
      requests.push(request);
      const stream = new AssistantMessageEventStream();
      void Promise.resolve().then(() => {
        if (requests.length === 1) {
          const toolCallMessage = assistantMessage("", "toolUse");
          toolCallMessage.content = [{ type: "toolCall", id: "call-diag-1", name: "book_search", arguments: { query: "Chapter One" } }];
          stream.push({ type: "start", partial: toolCallMessage });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: { type: "toolCall", id: "call-diag-1", name: "book_search", arguments: { query: "Chapter One" } }, partial: toolCallMessage });
          stream.push({ type: "done", reason: "toolUse", message: toolCallMessage });
          return;
        }
        stream.push({ type: "start", partial: assistantMessage("") });
        stream.push({ type: "done", reason: "stop", message: assistantMessage("诊断用回答。") });
      });
      return stream;
    };

    buildHost({
      createStreamFn: () => streamFn,
      buildTools: (context) => registry.buildAgentTools(() => ({
        bookId: context.bookId,
        reportEvidence: context.reportEvidence,
        bookIndex,
      })),
    });

    const result = await host.start({ bookId: fixtureBookId, question: "诊断问题" });
    expect(result.ok).toBe(true);
    await waitFor(() => lifecyclePhase(events).includes("end"), 8_000);

    const diagnostics = host.listDiagnostics(fixtureBookId);
    expect(diagnostics).toHaveLength(1);
    const run = diagnostics[0]!;
    expect(run.status).toBe("complete");
    expect(run.requests).toHaveLength(2);
    expect(run.requests[0]!.role).toBe("main");
    expect(run.requests[1]!.role).toBe("tool-turn");
    expect(run.requests[0]!.systemPrompt).toContain("PDFMuse");
    expect(run.requests[0]!.toolNames).toContain("book_search");
    expect(run.requests[1]!.messages.some((message) => JSON.stringify(message).includes("book_search"))).toBe(true);
    expect(run.requests[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(run.requests[0]!.usage?.totalTokens).toBeGreaterThan(0);
    expect(run.toolCalls).toHaveLength(1);
    expect(run.toolCalls[0]).toMatchObject({ name: "book_search", parameters: { query: "Chapter One" } });
    expect(run.toolCalls[0]!.resultText).toContain("Chapter One");
    expect(run.toolCalls[0]!.evidence?.[0]?.page).toBe(1);
    expect(run.timeline.some((entry) => entry.kind === "run-start")).toBe(true);
    expect(run.totalDurationMs).toBeGreaterThanOrEqual(0);
    // 诊断事件实时推送（请求快照 + 完成 + 工具）。
    const diagnosticEvents = events.filter((event): event is Extract<AgentStreamEvent, { stream: "diagnostics" }> => event.stream === "diagnostics");
    expect(diagnosticEvents.filter((event) => event.kind === "request")).toHaveLength(2);
    expect(diagnosticEvents.filter((event) => event.kind === "request-complete")).toHaveLength(2);
    expect(diagnosticEvents.filter((event) => event.kind === "tool")).toHaveLength(1);

    bookIndex.close();
    library.close();
  });

  it("blocks book_search beyond the per-run cap and still answers", async () => {
    const library = createLibraryModule(dataHome);
    const bookIndex = createBookIndex(dataHome);
    const opened = await library.openPath(FIXTURE);
    expect(opened.ok).toBe(true);
    const fixtureBookId = opened.ok ? opened.book.id : "";
    const registry = createToolRegistry();

    const requests: CapturedRequest[] = [];
    const streamFn = async (model: Model, context: Context, options?: SimpleStreamOptions) => {
      const request: CapturedRequest = { model, context, options };
      requests.push(request);
      const stream = new AssistantMessageEventStream();
      void Promise.resolve().then(() => {
        if (requests.length <= 4) {
          // 连续四次请求检索；第四次应被上限拦截。
          const toolCallMessage = assistantMessage("", "toolUse");
          const callId = `call-cap-${requests.length}`;
          toolCallMessage.content = [{ type: "toolCall", id: callId, name: "book_search", arguments: { query: `Chapter ${requests.length}` } }];
          stream.push({ type: "start", partial: toolCallMessage });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: { type: "toolCall", id: callId, name: "book_search", arguments: { query: `Chapter ${requests.length}` } }, partial: toolCallMessage });
          stream.push({ type: "done", reason: "toolUse", message: toolCallMessage });
          return;
        }
        stream.push({ type: "start", partial: assistantMessage("") });
        stream.push({ type: "done", reason: "stop", message: assistantMessage("基于已有结果回答。") });
      });
      return stream;
    };

    buildHost({
      createStreamFn: () => streamFn,
      buildTools: (context) => registry.buildAgentTools(() => ({
        bookId: context.bookId,
        reportEvidence: context.reportEvidence,
        bookIndex,
      })),
    });

    const result = await host.start({ bookId: fixtureBookId, question: "连续检索的问题" });
    expect(result.ok).toBe(true);
    await waitFor(() => lifecyclePhase(events).includes("end"), 8_000);

    const diagnostics = host.listDiagnostics(fixtureBookId);
    const run = diagnostics.at(-1)!;
    const searchCalls = run.toolCalls.filter((toolCall) => toolCall.name === "book_search");
    expect(searchCalls).toHaveLength(4);
    expect(searchCalls[3]!.resultText).toContain("上限");
    expect(run.requests).toHaveLength(5);
    const conversation = host.getConversation(fixtureBookId);
    expect(conversation.at(-1)?.body).toBe("基于已有结果回答。");

    bookIndex.close();
    library.close();
  });

  it("aggregates evidence per page by best score with an eight-entry cap", async () => {
    // 注入一个返回可控证据列表的假工具，验证聚合规则。
    const fakeTool = {
      name: "fake_evidence",
      label: "假证据工具",
      description: "测试用",
      parameters: { type: "object", properties: {} },
      async execute() {
        return {
          content: [{ type: "text" as const, text: "完成" }],
          details: {
            displaySummary: "完成",
            contentText: "完成",
            evidence: [
              { source: "pdf" as const, page: 10, snippet: "低分", trust: "trusted" as const, score: 0.3 },
              { source: "pdf" as const, page: 10, snippet: "高分", trust: "trusted" as const, score: 0.8 },
              ...Array.from({ length: 10 }, (_, index) => ({
                source: "pdf" as const,
                page: 20 + index,
                snippet: `第 ${20 + index} 页`,
                trust: "trusted" as const,
                score: 0.4 + index * 0.01,
              })),
            ],
          },
        };
      },
    };
    const requests: CapturedRequest[] = [];
    const streamFn = async (model: Model, context: Context, options?: SimpleStreamOptions) => {
      const request: CapturedRequest = { model, context, options };
      requests.push(request);
      const stream = new AssistantMessageEventStream();
      void Promise.resolve().then(() => {
        if (requests.length === 1) {
          const toolCallMessage = assistantMessage("", "toolUse");
          toolCallMessage.content = [{ type: "toolCall", id: "call-agg-1", name: "fake_evidence", arguments: {} }];
          stream.push({ type: "start", partial: toolCallMessage });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: { type: "toolCall", id: "call-agg-1", name: "fake_evidence", arguments: {} }, partial: toolCallMessage });
          stream.push({ type: "done", reason: "toolUse", message: toolCallMessage });
          return;
        }
        stream.push({ type: "start", partial: assistantMessage("") });
        stream.push({ type: "done", reason: "stop", message: assistantMessage("聚合测试回答") });
      });
      return stream;
    };
    buildHost({
      createStreamFn: () => streamFn,
      buildTools: (context) => [{
        ...fakeTool,
        async execute(toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown) {
          const outcome = await fakeTool.execute();
          context.reportEvidence((outcome.details as { evidence: never[] }).evidence);
          return { content: outcome.content };
        },
      } as never],
    });

    const result = await startRun("证据聚合问题");
    expect(result.ok).toBe(true);
    await waitFor(() => lifecyclePhase(events).includes("end"));

    const conversation = host.getConversation(BOOK_ID);
    const evidence = conversation.at(-1)?.evidence ?? [];
    // 第 10 页只保留 0.8 分那条；总量截到 8 条且按页码升序展示。
    expect(evidence).toHaveLength(8);
    expect(evidence.find((item) => item.page === 10)?.snippet).toBe("高分");
    expect(evidence.map((item) => item.page)).toEqual([...evidence.map((item) => item.page)].sort((left, right) => left - right));
    // 截断按分数：0.4 分的第 20 页被挤掉，0.49 分的第 29 页保留。
    expect(evidence.some((item) => item.page === 20)).toBe(false);
    expect(evidence.some((item) => item.page === 29)).toBe(true);
  });

  it("passes current-turn screenshot blocks to the model without indexing them", async () => {
    const fake = createFakeStreamFn(({ push }) => {
      push({ type: "start", partial: assistantMessage("") });
      push({ type: "done", reason: "stop", message: assistantMessage("看到了截图") });
    });
    const indexed: Array<{ role: string; body: string }> = [];
    buildHost({
      createStreamFn: () => fake.streamFn,
      indexConversationMessage: (_bookId, message) => indexed.push({ role: message.role, body: message.body }),
    });
    const result = await host.start({
      bookId: BOOK_ID,
      question: "请看这张图",
      attachments: [{ id: "shot-1", mimeType: "image/png", data: "aGVsbG8=" }],
    });
    expect(result.ok).toBe(true);
    await waitFor(() => lifecyclePhase(events).includes("end"));

    const request = fake.requests[0]!;
    expect(request.model.input).toEqual(["text", "image"]);
    const current = request.context.messages.at(-1);
    expect(current?.role).toBe("user");
    expect(Array.isArray(current?.content)).toBe(true);
    expect(current?.content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("请看这张图") }),
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ]);
    expect(indexed).toEqual([
      { role: "reader", body: "请看这张图" },
      { role: "assistant", body: "看到了截图" },
    ]);
  });

  it("truncates oversized reader profiles inside the system prompt budget", async () => {
    const fake = createFakeStreamFn(({ push }) => {
      push({ type: "start", partial: assistantMessage("") });
      push({ type: "done", reason: "stop", message: assistantMessage("好") });
    });
    buildHost({
      createStreamFn: () => fake.streamFn,
      loadReaderProfile: async () => "长".repeat(2_600),
    });
    await startRun("任何问题");
    await waitFor(() => events.some((event) => event.stream === "lifecycle" && event.phase === "end"));
    const prompt = fake.requests[0]!.context.systemPrompt;
    expect(prompt).toContain("已截断");
    expect(prompt.length).toBeLessThan(2_700);
  });

  it("serializes runs on the same book conversation", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const order: string[] = [];
    const fake = createFakeStreamFn(({ push, request }) => {
      const question = JSON.stringify(request.context.messages.at(-1));
      if (question?.includes("第一")) {
        void firstGate.then(() => {
          push({ type: "start", partial: assistantMessage("") });
          push({ type: "done", reason: "stop", message: assistantMessage("一") });
        });
        return;
      }
      order.push("second-started");
      push({ type: "start", partial: assistantMessage("") });
      push({ type: "done", reason: "stop", message: assistantMessage("二") });
    });
    buildHost({ createStreamFn: () => fake.streamFn });

    await startRun("第一问");
    await startRun("第二问");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(order).toEqual([]);
    releaseFirst?.();
    await waitFor(() => host.getConversation(BOOK_ID).length === 4);
    expect(order).toEqual(["second-started"]);
    // 第二轮上下文已包含第一轮问答。
    const serialized = JSON.stringify(fake.requests[1]?.context.messages);
    expect(serialized).toContain("第一问");
    expect(serialized).toContain("一");
  });

  it("keeps partial content when the reader cancels mid-stream", async () => {
    const fake = createFakeStreamFn(({ push, request }) => {
      push({ type: "start", partial: assistantMessage("") });
      push({ type: "text_delta", contentIndex: 0, delta: "部分" });
      request.options?.signal?.addEventListener("abort", () => {
        push({ type: "error", reason: "aborted", error: assistantMessage("部分", "aborted") });
      });
    });
    buildHost({ createStreamFn: () => fake.streamFn });

    const result = await startRun("长问题");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await waitFor(() => events.some((event) => event.stream === "assistant"));
    host.cancel(result.runId);
    await waitFor(() => lifecyclePhase(events).includes("cancelled"));

    const conversation = host.getConversation(BOOK_ID);
    expect(conversation[1]?.status).toBe("cancelled");
    expect(conversation[1]?.body).toBe("部分");
    expect(conversation[0]?.body).toBe("长问题");
  });

  it("cancels active and queued runs for a book before data removal", async () => {
    const fake = createFakeStreamFn(({ push, request }) => {
      push({ type: "start", partial: assistantMessage("") });
      push({ type: "text_delta", contentIndex: 0, delta: "处理中" });
      request.options?.signal?.addEventListener("abort", () => {
        push({ type: "error", reason: "aborted", error: assistantMessage("处理中", "aborted") });
      });
    });
    buildHost({ createStreamFn: () => fake.streamFn });

    await startRun("第一问");
    await startRun("排队中的第二问");
    await waitFor(() => events.some((event) => event.stream === "assistant"));
    await host.cancelBook(BOOK_ID);

    expect(fake.requests).toHaveLength(1);
    expect(lifecyclePhase(events).filter((phase) => phase === "cancelled")).toHaveLength(2);
    expect(host.getConversation(BOOK_ID).map((message) => message.body)).toEqual([
      "第一问",
      "处理中",
      "排队中的第二问",
    ]);
  });

  it("marks the assistant message as error on timeout", async () => {
    const fake = createFakeStreamFn(({ push, request }) => {
      push({ type: "start", partial: assistantMessage("") });
      push({ type: "text_delta", contentIndex: 0, delta: "开头" });
      request.options?.signal?.addEventListener("abort", () => {
        push({ type: "error", reason: "aborted", error: assistantMessage("开头", "aborted") });
      });
    });
    buildHost({ createStreamFn: () => fake.streamFn, runTimeoutMs: 60 });

    const result = await startRun("会超时的问题");
    expect(result.ok).toBe(true);
    await waitFor(() => lifecyclePhase(events).includes("error"), 3_000);

    const conversation = host.getConversation(BOOK_ID);
    expect(conversation[1]?.status).toBe("error");
    expect(conversation[1]?.errorMessage).toContain("超时");
    expect(conversation[1]?.body).toBe("开头");
  });

  it("normalizes authentication failures from the model stream", async () => {
    const fake = createFakeStreamFn(({ push }) => {
      push({ type: "start", partial: assistantMessage("") });
      push({ type: "error", reason: "error", error: assistantMessage("", "error", "401 unauthorized: invalid api key") });
    });
    buildHost({ createStreamFn: () => fake.streamFn });

    await startRun("任何问题");
    await waitFor(() => lifecyclePhase(events).includes("error"));

    const conversation = host.getConversation(BOOK_ID);
    expect(conversation[1]?.status).toBe("error");
    expect(conversation[1]?.errorMessage).toContain("API 密钥");
    expect(conversation[0]?.body).toBe("任何问题");
  });

  it("normalizes rate limiting that flows through the agent stream", async () => {
    const fake = createFakeStreamFn(({ push }) => {
      push({ type: "start", partial: assistantMessage("") });
      push({ type: "error", reason: "error", error: assistantMessage("", "error", "429 rate limit exceeded") });
    });
    buildHost({ createStreamFn: () => fake.streamFn });

    await startRun("被限流的问题");
    await waitFor(() => lifecyclePhase(events).includes("error"));

    const conversation = host.getConversation(BOOK_ID);
    expect(conversation[1]?.status).toBe("error");
    expect(conversation[1]?.errorMessage).toContain("限流");
  });

  it("marks the run as failed when the model stream ends without a terminal event", async () => {
    const fake = createFakeStreamFn(({ stream, push }) => {
      push({ type: "start", partial: assistantMessage("") });
      push({ type: "text_delta", contentIndex: 0, delta: "残缺" });
      // 畸形响应：没有任何 done/error 事件就结束流。
      stream.end();
    });
    buildHost({ createStreamFn: () => fake.streamFn });

    await startRun("畸形响应问题");
    await waitFor(() => lifecyclePhase(events).some((phase) => phase === "error" || phase === "end"), 4_000);

    const conversation = host.getConversation(BOOK_ID);
    expect(conversation.length).toBe(2);
    expect(["error", "cancelled"]).toContain(conversation[1]?.status);
    expect(conversation[1]?.body).toBe("残缺");
  });

  it("keeps the question and emits a terminal event when a queued run is cancelled before start", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const fake = createFakeStreamFn(({ push }) => {
      void firstGate.then(() => {
        push({ type: "start", partial: assistantMessage("") });
        push({ type: "done", reason: "stop", message: assistantMessage("先回答") });
      });
    });
    buildHost({ createStreamFn: () => fake.streamFn });

    const first = await startRun("第一问");
    const second = await startRun("第二问");
    expect(second.ok).toBe(true);
    if (second.ok) host.cancel(second.runId);
    releaseFirst?.();
    await waitFor(() => lifecyclePhase(events).includes("cancelled"));

    // 被取消的排队运行保留了问题并发出终态；后续运行不受影响。
    const conversation = host.getConversation(BOOK_ID);
    expect(conversation.map((message) => [message.role, message.body])).toEqual([
      ["reader", "第一问"],
      ["assistant", "先回答"],
      ["reader", "第二问"],
    ]);
  });

  it("rejects a fabricated book id that is not in the library", async () => {
    buildHost({ isKnownBook: (bookId) => bookId === BOOK_ID });
    const result = await host.start({ bookId: "b".repeat(64), question: "伪造书籍" });
    expect(result).toEqual({
      ok: false,
      code: "VALIDATION_ERROR",
      message: "书库中没有这本 PDF 书籍，无法开始对话。",
    });
    expect(host.getConversation("b".repeat(64))).toEqual([]);
  });

  it("rejects runs when the model connection is missing", async () => {
    buildHost({ loadModelConnection: async () => undefined });
    const result = await startRun("没有模型时的问题");
    expect(result).toEqual({
      ok: false,
      code: "MODEL_NOT_CONFIGURED",
      message: "尚未配置对话模型，请先在设置中保存并测试模型连接。",
    });
    expect(host.getConversation(BOOK_ID)).toEqual([]);
  });

  it("validates reader input before accepting a run", async () => {
    buildHost();
    expect((await host.start({ bookId: "not-a-book", question: "hi" })).ok).toBe(false);
    expect((await host.start({ bookId: BOOK_ID, question: "   " })).ok).toBe(false);
    expect((await host.start({ bookId: BOOK_ID, question: "x".repeat(9_000) })).ok).toBe(false);
    expect((await host.start(null)).ok).toBe(false);
    expect((await host.start({
      bookId: BOOK_ID,
      question: "图片太多",
      attachments: Array.from({ length: 5 }, (_, index) => ({ id: String(index), mimeType: "image/png", data: "aGVsbG8=" })),
    })).ok).toBe(false);
  });

  it("recovers interrupted streaming messages on restart", async () => {
    // 模拟异常退出遗留：直接写入一个 streaming 占位。
    const store = createSessionStore(dataHome);
    const session = store.ensureSession(BOOK_ID);
    store.appendMessage({ sessionId: session.id, runId: "legacy-run", role: "reader", body: "旧问题", status: "complete" });
    store.appendMessage({ sessionId: session.id, runId: "legacy-run", role: "assistant", body: "写到一半", status: "streaming" });
    store.close();

    buildHost();
    const conversation = host.getConversation(BOOK_ID);
    expect(conversation.at(-1)?.status).toBe("cancelled");
    expect(conversation.at(-1)?.errorMessage).toContain("程序中断，回答未完成");
    expect(conversation.at(-1)?.body).toBe("写到一半");
  });

  it("runs book_search tool turns and persists pdf evidence", async () => {
    // 真实 Library + 索引 + Registry，验证工具续轮闭环。
    const library = createLibraryModule(dataHome);
    const bookIndex = createBookIndex(dataHome);
    const opened = await library.openPath(FIXTURE);
    expect(opened.ok).toBe(true);
    const fixtureBookId = opened.ok ? opened.book.id : "";
    const registry = createToolRegistry();

    const requests: CapturedRequest[] = [];
    const streamFn = async (model: Model, context: Context, options?: SimpleStreamOptions) => {
      const request: CapturedRequest = { model, context, options };
      requests.push(request);
      const stream = new AssistantMessageEventStream();
      void Promise.resolve().then(() => {
        if (requests.length === 1) {
          // 第一轮：模型先说一句再请求检索本书（多段回答，前段不得被后段覆盖）。
          const toolCallMessage = assistantMessage("让我先检索原文。", "toolUse");
          toolCallMessage.content = [
            { type: "text", text: "让我先检索原文。" },
            { type: "toolCall", id: "call-book-1", name: "book_search", arguments: { query: "Chapter One" } },
          ];
          stream.push({ type: "start", partial: toolCallMessage });
          stream.push({ type: "text_delta", contentIndex: 0, delta: "让我先检索原文。" });
          stream.push({
            type: "toolcall_end",
            contentIndex: 1,
            toolCall: { type: "toolCall", id: "call-book-1", name: "book_search", arguments: { query: "Chapter One" } },
            partial: toolCallMessage,
          });
          stream.push({ type: "done", reason: "toolUse", message: toolCallMessage });
          return;
        }
        // 第二轮：模型基于工具结果回答。
        stream.push({ type: "start", partial: assistantMessage("") });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "第一章内容如下。" });
        stream.push({ type: "done", reason: "stop", message: assistantMessage("第一章内容如下。") });
      });
      return stream;
    };

    buildHost({
      createStreamFn: () => streamFn,
      buildTools: (context) => registry.buildAgentTools(() => ({
        bookId: context.bookId,
        reportEvidence: context.reportEvidence,
        bookIndex,
      })),
    });

    const result = await host.start({ bookId: fixtureBookId, question: "第一章讲了什么？" });
    expect(result.ok).toBe(true);
    await waitFor(() => lifecyclePhase(events).includes("end"), 8_000);

    // 两个模型轮次，第二轮上下文含工具结果。
    expect(requests.length).toBe(2);
    const secondRound = JSON.stringify(requests[1]!.context.messages);
    expect(secondRound).toContain("toolResult");
    expect(secondRound).toContain("book_search");
    expect(secondRound).toContain("Chapter One");

    // 工具事件顺序：start 在 end 之前。
    const toolEvents = events.filter((event): event is Extract<AgentStreamEvent, { stream: "tool" }> => event.stream === "tool");
    expect(toolEvents.map((event) => event.phase)).toEqual(["start", "update", "end"]);
    expect(toolEvents[0]?.name).toBe("book_search");

    // Evidence 持久化到 assistant 消息并指向真实页码；工具轮前段的回答不得被后段覆盖。
    const conversation = host.getConversation(fixtureBookId);
    expect(conversation.at(-1)?.status).toBe("complete");
    expect(conversation.at(-1)?.body).toBe("让我先检索原文。第一章内容如下。");
    expect(conversation.at(-1)?.evidence?.[0]).toMatchObject({ source: "pdf", page: 1, trust: "trusted" });
    expect(conversation.at(-1)?.evidence?.[0]?.snippet).toContain("Chapter One");

    await Promise.resolve();
    bookIndex.close();
    library.close();
  });
});
