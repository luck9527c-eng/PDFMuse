import { describe, expect, it } from "vitest";

import type { ConversationMessage } from "../../shared/contracts.js";
import type { AssistantMessage, ToolResultMessage } from "./openclaw-core.js";
import { buildReplayMessages, estimatingImageLoader, type ReplayImageLoader } from "./context-assembly.js";
import type { PersistedToolCall } from "./session-store.js";

function message(role: "reader" | "assistant", runId: string, body: string, status = "complete"): ConversationMessage {
  return {
    id: `${runId}-${role}`,
    sessionId: "session-1",
    runId,
    role,
    body,
    status,
    createdAt: new Date().toISOString(),
  } as ConversationMessage;
}

function row(partial: Partial<PersistedToolCall> & { runId: string; callId: string }): PersistedToolCall {
  return {
    toolName: "book_search",
    title: "检索本书",
    argumentsJson: "{}",
    resultText: "结果",
    status: "executed",
    isError: false,
    ...partial,
  };
}

describe("context assembly replay", () => {
  it("synthesizes merged tool pairs and filters failed runs (T45)", async () => {
    const history = [
      message("reader", "r1", "第一问"),
      message("assistant", "r1", "第一答"),
      message("reader", "r2", "第二问"),
      message("assistant", "r2", "失败回答", "error"),
      message("reader", "r3", "第三问"),
      message("assistant", "r3", "第三答"),
    ];
    const toolCalls: PersistedToolCall[] = [
      {
        runId: "r1",
        callId: "c1",
        toolName: "book_search",
        title: "检索本书",
        argumentsJson: '{"query":"x"}',
        resultText: "命中原文",
        status: "executed",
        isError: false,
        mediaPath: JSON.stringify([{ page: 1, path: "book/p1.png" }, { page: 2, path: "book/p2.png" }]),
      },
      { runId: "r1", callId: "c2", toolName: "read_pages", title: "读取页面", argumentsJson: "{}", resultText: "拒绝文本", status: "rejected", isError: true },
      { runId: "r2", callId: "c3", toolName: "book_search", title: "检索本书", argumentsJson: "{}", resultText: "失败 run 的行", status: "executed", isError: false },
    ];
    // 第一张图可读、第二张缺失：同一条 toolResult 内图块与占位文本并存。
    const loader: ReplayImageLoader = async (path) => (path.endsWith("p1.png") ? "aW1n" : null);

    const messages = await buildReplayMessages({ history, toolCalls, loadImage: loader });

    expect(messages.map((item) => item.role)).toEqual([
      "user", // r1 问题
      "assistant", // 合并后的 toolCall 消息（连续调用不拆成多条 assistant）
      "toolResult", // c1
      "toolResult", // c2
      "assistant", // r1 回答
      "user", // r2 问题（失败 run 悬空问题，现状语义）
      "user", // r3 问题（连续 user 不合并，保持回放字节）
      "assistant", // r3 回答
    ]);

    const withCalls = messages[1] as AssistantMessage;
    expect(withCalls.stopReason).toBe("toolUse");
    expect(withCalls.content.map((block) => (block.type === "toolCall" ? block.id : null))).toEqual(["c1", "c2"]);

    const executed = messages[2] as ToolResultMessage;
    expect(executed.toolCallId).toBe("c1");
    expect(executed.isError).toBe(false);
    expect(executed.content.filter((block) => block.type === "image")).toHaveLength(1);
    expect(executed.content.some((block) => block.type === "text" && block.text.includes("第 2 页原图已缺失"))).toBe(true);

    const rejected = messages[3] as ToolResultMessage;
    expect(rejected.toolCallId).toBe("c2");
    expect(rejected.isError).toBe(true);

    // 失败/取消 run 的工具行整体排除（问题消息保留）。
    expect(JSON.stringify(messages)).not.toContain("失败 run 的行");
    expect(JSON.stringify(messages)).toContain("第二问");
  });

  it("degrades corrupted media references to plain text results", async () => {
    const history = [message("reader", "r1", "问题"), message("assistant", "r1", "回答")];
    const toolCalls: PersistedToolCall[] = [
      row({ runId: "r1", callId: "c1", resultText: "文本结果", mediaPath: "not-json" }),
    ];

    const messages = await buildReplayMessages({ history, toolCalls, loadImage: async () => "aW1n" });

    // 序列：user → assistant(toolCall) → toolResult → assistant(回答)。
    const toolResult = messages[2] as ToolResultMessage;
    expect(toolResult.role).toBe("toolResult");
    expect(toolResult.content).toEqual([{ type: "text", text: "文本结果" }]);
  });

  it("estimates images at fixed tokens without reading files", async () => {
    const history = [message("reader", "r1", "问题"), message("assistant", "r1", "回答")];
    const toolCalls: PersistedToolCall[] = [
      row({ runId: "r1", callId: "c1", mediaPath: JSON.stringify([{ page: 1, path: "book/p1.png" }]) }),
    ];

    // 估算 loader 返回占位串：图块照常计入（vendored 按块固定 2000 token），不触发文件读取。
    const messages = await buildReplayMessages({ history, toolCalls, loadImage: estimatingImageLoader });
    const toolResult = messages[2] as ToolResultMessage;
    expect(toolResult.content.filter((block) => block.type === "image")).toHaveLength(1);
  });
});
