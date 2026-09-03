import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentStreamEvent, StartAgentRunResult } from "../../shared/contracts.js";
import { createAgentHost, type AgentHost } from "./agent-host.js";
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

  it("injects history, focus, reader profile and system prompt into the model context", async () => {
    const first = createFakeStreamFn(({ push }) => {
      push({ type: "start", partial: assistantMessage("") });
      push({ type: "done", reason: "stop", message: assistantMessage("第一轮回答") });
    });
    buildHost({ createStreamFn: () => first.streamFn });
    await startRun("第一个问题");
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
    expect(request.context.tools).toEqual([]);
    const serialized = JSON.stringify(request.context.messages);
    expect(serialized).toContain("第一个问题");
    expect(serialized).toContain("第一轮回答");
    expect(serialized).toContain("第二个问题");
    expect(serialized).toContain("Selected Passage");
    expect(serialized).toContain("选中的原文片段");

    const conversation = host.getConversation(BOOK_ID);
    expect(conversation).toHaveLength(4);
    expect(conversation[2]?.passage).toEqual({ page: 3, text: "选中的原文片段", rects: [] });
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
});
