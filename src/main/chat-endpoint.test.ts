import { describe, expect, it } from "vitest";

import { chatEndpointUrl, normalizeChatApiBase } from "./chat-endpoint.js";

describe("Chat Endpoint 归一化", () => {
  it("openai 协议收敛到 /v1/chat/completions", () => {
    expect(normalizeChatApiBase("openai", "https://api.b.ai")).toBe("https://api.b.ai/v1");
    expect(normalizeChatApiBase("openai", "https://api.b.ai/")).toBe("https://api.b.ai/v1");
    expect(normalizeChatApiBase("openai", "https://api.openai.com/v1")).toBe("https://api.openai.com/v1");
    expect(normalizeChatApiBase("openai", "https://api.deepseek.com")).toBe("https://api.deepseek.com/v1");
    expect(normalizeChatApiBase("openai", "https://gw.internal/team/v1/chat/completions")).toBe("https://gw.internal/team/v1");
    expect(chatEndpointUrl("openai", "https://api.b.ai").href).toBe("https://api.b.ai/v1/chat/completions");
    expect(chatEndpointUrl("openai", "https://x/v1/chat/completions").href).toBe("https://x/v1/chat/completions");
  });

  it("已带 /v数字 版本段的地址不再补 /v1", () => {
    expect(normalizeChatApiBase("openai", "https://api.z.ai/api/paas/v4")).toBe("https://api.z.ai/api/paas/v4");
    expect(chatEndpointUrl("openai", "https://api.z.ai/api/paas/v4").href).toBe("https://api.z.ai/api/paas/v4/chat/completions");
  });

  it("anthropic 协议收敛到无 /v1 的 base，由运行时 SDK 拼 /v1/messages", () => {
    expect(normalizeChatApiBase("anthropic", "https://api.b.ai")).toBe("https://api.b.ai");
    expect(normalizeChatApiBase("anthropic", "https://api.anthropic.com/v1")).toBe("https://api.anthropic.com");
    expect(normalizeChatApiBase("anthropic", "https://gw.internal/v1/messages")).toBe("https://gw.internal");
    expect(chatEndpointUrl("anthropic", "https://api.b.ai").href).toBe("https://api.b.ai/v1/messages");
    expect(chatEndpointUrl("anthropic", "https://api.anthropic.com/v1").href).toBe("https://api.anthropic.com/v1/messages");
  });

  it("丢弃查询与片段并容忍尾部斜杠", () => {
    expect(normalizeChatApiBase("openai", "https://x/v1/?foo=bar#frag")).toBe("https://x/v1");
    expect(normalizeChatApiBase("anthropic", "https://x///")).toBe("https://x");
  });
});
