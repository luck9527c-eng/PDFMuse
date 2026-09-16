import type { ModelProtocol } from "../../shared/contracts.js";
import {
  createLlmRuntime,
  registerBuiltInApiProviders,
  type CompleteSimpleFn,
  type Model,
  type SimpleStreamOptions,
  type StreamFn,
} from "./openclaw-core.js";

export type ResolvedModelConnection = {
  protocol: ModelProtocol;
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** 模型上下文窗口（token）；压缩阈值按它 70% 计算，缺省回落默认档。 */
  contextWindow?: number;
};

const llmRuntime = createLlmRuntime();
// 内置协议适配器（openai-completions、anthropic-messages 等）按需注册后懒加载。
registerBuiltInApiProviders(llmRuntime.registry);

/** Model Connection 配置映射为 vendored Agent Core 需要的 Model 对象。 */
export function toLlmModel(connection: ResolvedModelConnection, supportsVision = false): Model {
  return {
    id: connection.model,
    name: connection.model,
    api: connection.protocol === "anthropic" ? "anthropic-messages" : "openai-completions",
    provider: "pdfmuse",
    baseUrl: connection.baseUrl,
    reasoning: false,
    input: supportsVision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // 真实窗口随连接传入（vendored 分支摘要等消费者读此字段）；未配置时保持 0（其内部自有兜底）。
    contextWindow: connection.contextWindow ?? 0,
    maxTokens: 0,
    // 会话亲和：sessionId 非空时适配器随请求发亲和头，帮助 provider 侧命中前缀缓存；未知头被忽略，无副作用。
    compat: { sendSessionAffinityHeaders: true },
  };
}

/** 注入 API Key 的流式函数；协议差异由 @openclaw/ai Provider Adapter 承接。 */
export function createModelStreamFn(connection: ResolvedModelConnection): StreamFn {
  return (model, context, options) => {
    const merged: SimpleStreamOptions = {
      ...options,
      apiKey: connection.apiKey,
    };
    return llmRuntime.streamSimple(model, context, merged);
  };
}

/** 注入 API Key 的一次性（非流式对话轮）调用，供目录提取等单轮任务复用。 */
export function createModelCompleteFn(connection: ResolvedModelConnection): CompleteSimpleFn {
  return (model, context, options) => {
    const merged: SimpleStreamOptions = {
      ...options,
      apiKey: connection.apiKey,
    };
    return llmRuntime.completeSimple(model, context, merged);
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
  if (text.includes("vision") || text.includes("multimodal") || text.includes("image input")
    || text.includes("image_url") || text.includes("images are not supported")
    || text.includes("does not support image") || text.includes("图片")) {
    return {
      code: "INVALID_RESPONSE",
      message: "当前配置的模型不支持图片输入，请更换支持视觉的模型后重试。",
    };
  }
  return {
    code: "INVALID_RESPONSE",
    message: "模型服务返回了无法处理的响应，请重试。",
  };
}
