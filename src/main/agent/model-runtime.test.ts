import { describe, expect, it } from "vitest";

import { normalizeModelError, toLlmModel } from "./model-runtime.js";

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
});

describe("toLlmModel", () => {
  it("maps protocols to provider api families", () => {
    expect(toLlmModel({ protocol: "openai", baseUrl: "http://x/v1", model: "gpt" }).api).toBe("openai-completions");
    expect(toLlmModel({ protocol: "anthropic", baseUrl: "http://x", model: "claude" }).api).toBe("anthropic-messages");
    expect(toLlmModel({ protocol: "openai", baseUrl: "http://x/v1", model: "gpt" }).baseUrl).toBe("http://x/v1");
  });
});
