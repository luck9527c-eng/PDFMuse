import { describe, expect, it, vi } from "vitest";

// createLlmRuntime 在 model-runtime 模块加载期即被调用；这里用桩替身捕获
// completeSimple 收到的合并入参，验证 apiKey 与 sessionId 透传（T35 验收）。
const runtimeStub = vi.hoisted(() => {
  const completeCalls: Array<{ options?: Record<string, unknown> }> = [];
  return {
    completeCalls,
    createLlmRuntime: () => ({
      registry: { register: () => undefined, registerApiProvider: () => undefined },
      streamSimple: () => {
        throw new Error("streamSimple is not expected in this test file.");
      },
      completeSimple: async (_model: unknown, _context: unknown, options?: unknown) => {
        completeCalls.push({ options: options as Record<string, unknown> });
        return {
          role: "assistant",
          content: [],
          api: "openai-completions",
          provider: "pdfmuse",
          model: "test-model",
          usage: {},
          stopReason: "stop",
          timestamp: 0,
        };
      },
    }),
  };
});

vi.mock("./openclaw-core.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openclaw-core.js")>();
  return { ...actual, createLlmRuntime: runtimeStub.createLlmRuntime };
});

import { createModelCompleteFn, normalizeModelError, parseContextWindowError, toLlmModel } from "./model-runtime.js";

describe("normalizeModelError", () => {
  it("maps authentication failures", () => {
    expect(normalizeModelError({ stopReason: "error", errorCode: "401", errorMessage: "unauthorized" })).toEqual({
      code: "AUTHENTICATION_ERROR",
      message: "模型服务拒绝了 API 密钥，请在设置中检查密钥后重试。",
    });
  });

  it("maps rate limiting and quota errors", () => {
    expect(normalizeModelError({ stopReason: "error", errorCode: "429", errorMessage: "rate limit exceeded" })).toEqual({
      code: "RATE_LIMITED",
      message: "模型服务限流或额度不足，请稍后重试。",
    });
    expect(normalizeModelError({ stopReason: "error", errorMessage: "quota exceeded" })?.code).toBe("RATE_LIMITED");
  });

  it("maps timeouts and network failures", () => {
    expect(normalizeModelError({ stopReason: "error", errorMessage: "request timed out" })?.code).toBe("TIMEOUT");
    expect(normalizeModelError({ stopReason: "error", errorMessage: "fetch failed" })?.code).toBe("NETWORK_ERROR");
  });

  it("falls back to an invalid-response error with a Chinese message", () => {
    const result = normalizeModelError({ stopReason: "error", errorMessage: "something odd" });
    expect(result).toEqual({
      code: "INVALID_RESPONSE",
      message: "模型服务返回了无法处理的响应，请重试。",
    });
  });

  it("leaves successful and aborted runs unmapped", () => {
    expect(normalizeModelError({ stopReason: "stop" })).toBeUndefined();
    expect(normalizeModelError({ stopReason: "aborted" })).toBeUndefined();
  });

  it("maps unsupported vision responses to a Chinese retry message", () => {
    expect(normalizeModelError({ stopReason: "error", errorMessage: "model does not support image input" })).toEqual({
      code: "INVALID_RESPONSE",
      message: "当前配置的模型不支持图片输入，请更换支持视觉的模型后重试。",
    });
  });
});

describe("toLlmModel", () => {
  it("maps protocols to provider api families", () => {
    expect(toLlmModel({ protocol: "openai", baseUrl: "http://x/v1", model: "gpt" }).api).toBe("openai-completions");
    expect(toLlmModel({ protocol: "anthropic", baseUrl: "http://x", model: "claude" }).api).toBe("anthropic-messages");
    expect(toLlmModel({ protocol: "openai", baseUrl: "http://x/v1", model: "gpt" }).baseUrl).toBe("http://x/v1");
  });

  it("declares image input only for image requests", () => {
    expect(toLlmModel({ protocol: "openai", baseUrl: "http://x/v1", model: "gpt" }).input).toEqual(["text"]);
    expect(toLlmModel({ protocol: "openai", baseUrl: "http://x/v1", model: "gpt" }, true).input).toEqual(["text", "image"]);
  });
});

describe("createModelCompleteFn", () => {
  it("merges the api key and caller session id into the one-shot complete options", async () => {
    const connection = { protocol: "openai" as const, baseUrl: "http://x/v1", model: "gpt", apiKey: "secret-key" };
    const complete = createModelCompleteFn(connection);
    const message = await complete(
      toLlmModel(connection),
      { systemPrompt: "系统提示", messages: [] },
      { sessionId: "session-1" },
    );
    expect(message.role).toBe("assistant");
    expect(runtimeStub.completeCalls).toHaveLength(1);
    expect(runtimeStub.completeCalls[0]!.options).toMatchObject({ apiKey: "secret-key", sessionId: "session-1" });
  });
});

describe("parseContextWindowError", () => {
  it("extracts the reported window from openai-style over-window errors", () => {
    expect(parseContextWindowError(
      "This model's maximum context length is 8192 tokens. However, you requested 10000 tokens (2345 of these are for the system message).",
    )).toEqual({ reportedWindow: 8192 });
  });

  it("extracts the maximum side from anthropic-style comparisons", () => {
    expect(parseContextWindowError("prompt is too long: 204 tokens > 180 tokens maximum")).toEqual({ reportedWindow: 180 });
  });

  it("ignores errors that are not about the context window", () => {
    expect(parseContextWindowError("rate limit exceeded, retry after 30s")).toBeUndefined();
    expect(parseContextWindowError(undefined)).toBeUndefined();
  });

  it("flags over-window errors without an extractable window number", () => {
    expect(parseContextWindowError("context length exceeded")).toEqual({});
  });
});
