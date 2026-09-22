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
    // 缺一即整条降级为 4 节占位模板（审查修复：不再部分附图 + 变体注记）。
    expect(executed.content).toEqual([
      { type: "text", text: "第 1、2 页原图已省略，如需查看可调用 read_page_image 重新获取。" },
    ]);

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

  it("applies the elision projection deterministically (T47)", async () => {
    const history = [
      message("reader", "r1", "第一问"),
      message("assistant", "r1", "第一答"),
      message("reader", "r2", "第二问"),
      message("assistant", "r2", "第二答"),
    ];
    const toolCalls: PersistedToolCall[] = [
      // 尾内（r2 保留）超大行：即便在保留尾内也投影占位（优先于末轮强制完整）。
      row({ runId: "r2", callId: "c-big", resultText: "长文本".repeat(700), title: "读取页面" }),
      // 尾外普通行：原文超 200 字符 → 占位。
      row({ runId: "r1", callId: "c-old", resultText: "旧检索".repeat(100), title: "检索本书" }),
    ];
    const elision = {
      retainedRunIds: new Set(["r2"]),
      oversizedRowTokenThreshold: 2_000,
    };

    const first = await buildReplayMessages({ history, toolCalls, loadImage: async () => "aW1n", elision });
    const second = await buildReplayMessages({ history, toolCalls, loadImage: async () => "aW1n", elision });
    // 投影纯函数：同库状态同字节。
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));

    const roles = first.map((item) => item.role);
    expect(roles).toEqual(["user", "assistant", "toolResult", "assistant", "user", "assistant", "toolResult", "assistant"]);

    // 尾外普通行被占位。
    const elided = first[2] as ToolResultMessage;
    expect(elided.isError).toBe(false);
    expect(elided.content).toEqual([{ type: "text", text: "此前 检索本书 结果约 300 字符，已省略" }]);
    // 尾内超大行：占位且带重取指引语义的模板不适用（文本类）。
    const oversized = first[6] as ToolResultMessage;
    expect(oversized.content).toEqual([{ type: "text", text: `此前 读取页面 结果约 ${"长文本".repeat(700).length} 字符，已省略` }]);
  });

  it("keeps small tail-external rows verbatim under elision (T47)", async () => {
    const history = [message("reader", "r1", "第一问"), message("assistant", "r1", "第一答")];
    const toolCalls: PersistedToolCall[] = [
      row({ runId: "r1", callId: "c1", resultText: "短结果", title: "检索本书" }),
    ];
    const messages = await buildReplayMessages({
      history,
      toolCalls,
      loadImage: async () => "aW1n",
      elision: { retainedRunIds: new Set<string>(), oversizedRowTokenThreshold: 2_000 },
    });
    // ≤200 字符的尾外行：占位比原文长，没有收益 → 原文保留。
    const toolResult = messages[2] as ToolResultMessage;
    expect(toolResult.content).toEqual([{ type: "text", text: "短结果" }]);
  });
});
