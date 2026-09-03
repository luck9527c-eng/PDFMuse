import type { ModelProtocol } from "../../shared/contracts.js";
import {
  createLlmRuntime,
  registerBuiltInApiProviders,
  type Model,
  type SimpleStreamOptions,
  type StreamFn,
} from "./openclaw-core.js";

export type ResolvedModelConnection = {
  protocol: ModelProtocol;
  baseUrl: string;
  model: string;
  apiKey?: string;
};

const llmRuntime = createLlmRuntime();
// 内置协议适配器（openai-completions、anthropic-messages 等）按需注册后懒加载。
registerBuiltInApiProviders(llmRuntime.registry);

/** Model Connection 配置映射为 vendored Agent Core 需要的 Model 对象。 */
export function toLlmModel(connection: ResolvedModelConnection): Model {
  return {
    id: connection.model,
    name: connection.model,
    api: connection.protocol === "anthropic" ? "anthropic-messages" : "openai-completions",
    provider: "pdfmuse",
    baseUrl: connection.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
  };
}

/** 注入 API Key 的流式函数；协议差异由 @openclaw/ai Provider Adapter 承接。 */
export function createModelStreamFn(connection: ResolvedModelConnection): StreamFn {
  return (model, context, options) => {
    const merged: SimpleStreamOptions = {
      ...options,
      apiKey: connection.apiKey,
      sessionId: undefined,
    };
    return llmRuntime.streamSimple(model, context, merged);
  };
}

export type NormalizedModelError = {
  code: "AUTHENTICATION_ERROR" | "RATE_LIMITED" | "TIMEOUT" | "NETWORK_ERROR" | "INVALID_RESPONSE";
  message: string;
};

/** 把 Provider 流内编码的失败映射为 Reader 可理解的中文错误。 */
export function normalizeModelError(failure: {
  stopReason: string;
  errorMessage?: string;
  errorCode?: string;
}): NormalizedModelError | undefined {
  if (failure.stopReason !== "error") return undefined;
  const text = `${failure.errorCode ?? ""} ${failure.errorMessage ?? ""}`.toLowerCase();
  // 状态码只在词边界上匹配，避免 "1401 tokens" 之类误判为 401。
  if (failure.errorCode === "401" || failure.errorCode === "403"
    || /\b(401|403)\b/.test(text)
    || text.includes("unauthorized") || text.includes("authentication") || text.includes("api key")) {
    return {
      code: "AUTHENTICATION_ERROR",
      message: "模型服务拒绝了 API 密钥，请在设置中检查密钥后重试。",
    };
  }
  if (failure.errorCode === "429" || /\b429\b/.test(text)
    || text.includes("rate limit") || text.includes("quota")) {
    return {
      code: "RATE_LIMITED",
      message: "模型服务限流或额度不足，请稍后重试。",
    };
  }
  if (text.includes("timeout") || text.includes("timed out") || text.includes("aborted")) {
    return {
      code: "TIMEOUT",
      message: "模型响应超时，请稍后重试。",
    };
  }
  if (text.includes("fetch") || text.includes("network") || text.includes("econnrefused")
    || text.includes("enotfound") || text.includes("socket")) {
    return {
      code: "NETWORK_ERROR",
      message: "无法连接模型服务，请检查网络或接口地址后重试。",
    };
  }
  return {
    code: "INVALID_RESPONSE",
    message: "模型服务返回了无法处理的响应，请重试。",
  };
}
