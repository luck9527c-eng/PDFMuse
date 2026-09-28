// 复现脚本（Phase 1 反馈环）：验证「重启后历史 run 的运行详情为空」。
// 用法：cp .tmp-baseline/diag-restart-repro.test.ts src/main/agent/__tmp-diag-restart-repro.test.ts
//       npx vitest run src/main/agent/__tmp-diag-restart-repro.test.ts
// 现状：红（expected undefined to be defined）。修复后应转绿。
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createAgentHost, type AgentHost } from "./agent-host.js";
import {
  AssistantMessageEventStream,
  type AssistantMessage,
  type Model,
  type Context,
  type SimpleStreamOptions,
} from "./openclaw-core.js";
import type { AgentStreamEvent } from "../../shared/contracts.js";

const BOOK_ID = "a".repeat(64);

function assistantMessage(content: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: content }],
    api: "openai-completions",
    provider: "pdfmuse",
    model: "test-model",
    usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timeout");
}

describe("run diagnostics across an app restart", () => {
  let dataHome: string;
  let hosts: AgentHost[] = [];

  afterEach(async () => {
    for (const host of hosts) host.close();
    hosts = [];
    await rm(dataHome, { recursive: true, force: true });
  });

  it("keeps a finished run's diagnostics readable after the process restarts", async () => {
    dataHome = await mkdtemp(path.join(os.tmpdir(), "pdfmuse-diag-repro-"));

    const runHost = (events: AgentStreamEvent[]) => {
      const streamFn = async (_model: Model, _context: Context, _options?: SimpleStreamOptions) => {
        const stream = new AssistantMessageEventStream();
        void Promise.resolve().then(() => {
          stream.push({ type: "start", partial: assistantMessage("") });
          stream.push({ type: "done", reason: "stop", message: assistantMessage("回答") });
        });
        return stream;
      };
      const host = createAgentHost({
        dataHome,
        emit: (event) => events.push(event),
        loadModelConnection: async () => ({
          protocol: "openai",
          baseUrl: "http://127.0.0.1:1/v1",
          model: "test-model",
          apiKey: "test-key",
        }),
        createStreamFn: () => streamFn,
      });
      hosts.push(host);
      return host;
    };

    // 第一次进程：跑一问，诊断可见。
    const firstEvents: AgentStreamEvent[] = [];
    const first = runHost(firstEvents);
    const started = await first.start({ bookId: BOOK_ID, question: "第一问" });
    expect(started.ok).toBe(true);
    await waitFor(() => firstEvents.some((event) => event.stream === "lifecycle" && event.phase === "end"));
    expect(first.listDiagnostics(BOOK_ID)).toHaveLength(1);

    // 第二次进程（模拟重启）：会话还在，诊断没了。
    const secondEvents: AgentStreamEvent[] = [];
    const second = runHost(secondEvents);
    const conversation = second.getConversation(BOOK_ID);
    const runId = conversation.find((message) => message.role === "reader")?.runId ?? "";

    expect(conversation.length).toBeGreaterThan(0);
    expect(runId).not.toBe("");

    // 渲染端打开「运行详情」时用的就是这条路：按 runId 找诊断。
    const diagnostics = second.listDiagnostics(BOOK_ID);
    const run = diagnostics.find((item) => item.runId === runId);
    expect(run).toBeDefined();
  });
});
