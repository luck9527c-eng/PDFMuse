import path from "node:path";

import {
  readAppConfig,
  type StoredAppConfig,
  updateAppConfig,
} from "./config-store.js";
import { chatEndpointUrl } from "./chat-endpoint.js";
import {
  isModelProtocol,
  MODEL_CONTEXT_WINDOW_OPTIONS,
  resolveModelContextWindow,
  type ModelProtocol,
  type ModelConnectionState,
  type SaveModelConnectionInput,
  type SaveModelConnectionResult,
  type TestModelConnectionInput,
  type TestModelConnectionResult,
} from "../shared/contracts.js";

type ModelConnectionModuleOptions = {
  requestTimeoutMs?: number;
};

function toState(config: StoredAppConfig): ModelConnectionState {
  return {
    protocol: config.chat?.protocol ?? "openai",
    baseUrl: config.chat?.baseUrl ?? "",
    model: config.chat?.model ?? "",
    hasApiKey: Boolean(config.chat?.apiKey),
    contextWindow: resolveModelContextWindow(config.chat?.contextWindow),
  };
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validationError(): SaveModelConnectionResult & TestModelConnectionResult {
  return {
    ok: false,
    code: "VALIDATION_ERROR",
    message: "请选择支持的接口协议，输入有效的 HTTP 或 HTTPS 接口地址，并填写模型名称。",
  };
}

function connectionTestHeaders(protocol: ModelProtocol, apiKey?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (protocol === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
    if (apiKey) headers["x-api-key"] = apiKey;
  } else if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function hasCompatibleResponse(protocol: ModelProtocol, body: unknown) {
  if (!isRecord(body)) return false;
  if (protocol === "openai") {
    const choices = body.choices;
    return Array.isArray(choices)
      && isRecord(choices[0])
      && isRecord(choices[0].message)
      // 推理模型把 token 花在思考上时会返回 content: null（协议本身兼容）。
      && (typeof choices[0].message.content === "string" || choices[0].message.content === null);
  }
  const content = body.content;
  return Array.isArray(content)
    && content.some((block) => isRecord(block) && block.type === "text" && typeof block.text === "string");
}

/** 提取服务端错误体里的可读信息（OpenAI/Anthropic 的 error.message 与部分网关的裸 message）。 */
function readServerDetail(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const candidates = [
    isRecord(body.error) ? body.error.message : undefined,
    typeof body.error === "string" ? body.error : undefined,
    body.message,
  ];
  const detail = candidates.find((candidate): candidate is string =>
    typeof candidate === "string" && candidate.trim().length > 0);
  if (!detail) return undefined;
  const collapsed = detail.replace(/\s+/g, " ").trim();
  return collapsed.length > 200 ? `${collapsed.slice(0, 200)}…` : collapsed;
}

function withServerDetail(message: string, detail: string | undefined) {
  return detail ? `${message}（服务返回：${detail}）` : message;
}

export function createModelConnectionModule(
  dataHome: string,
  options: ModelConnectionModuleOptions = {},
) {
  const configPath = path.join(dataHome, "config.json");
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;

  return {
    async get(): Promise<ModelConnectionState> {
      return toState(await readAppConfig(configPath));
    },

    async save(input: SaveModelConnectionInput): Promise<SaveModelConnectionResult> {
      if (!isRecord(input)
        || !isModelProtocol(input.protocol)
        || typeof input.baseUrl !== "string"
        || typeof input.model !== "string"
        || (input.apiKey !== undefined && typeof input.apiKey !== "string")
        || (input.clearApiKey !== undefined && typeof input.clearApiKey !== "boolean")
        || (input.contextWindow !== undefined
          && !(MODEL_CONTEXT_WINDOW_OPTIONS as readonly number[]).includes(input.contextWindow))) {
        return validationError();
      }
      const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
      const model = input.model.trim();
      if (!isHttpUrl(baseUrl) || !model) {
        return validationError();
      }
      const apiKey = input.apiKey?.trim();
      const config = await updateAppConfig(configPath, (current): StoredAppConfig => {
        const savedApiKey = input.clearApiKey
          ? undefined
          : apiKey || current.chat?.apiKey;
        return {
          ...current,
          version: 2,
          chat: {
            protocol: input.protocol,
            baseUrl,
            model,
            ...(input.contextWindow !== undefined
              ? { contextWindow: input.contextWindow }
              : current.chat?.contextWindow !== undefined
                ? { contextWindow: current.chat.contextWindow }
                : {}),
            ...(savedApiKey ? { apiKey: savedApiKey } : {}),
          },
        };
      });
      return { ok: true, connection: toState(config) };
    },

    async test(input: TestModelConnectionInput): Promise<TestModelConnectionResult> {
      if (!isRecord(input)
        || !isModelProtocol(input.protocol)
        || typeof input.baseUrl !== "string"
        || typeof input.model !== "string"
        || (input.apiKey !== undefined && typeof input.apiKey !== "string")
        || (input.clearApiKey !== undefined && typeof input.clearApiKey !== "boolean")
        || (input.maxTokensField !== undefined
          && input.maxTokensField !== "max_tokens"
          && input.maxTokensField !== "max_completion_tokens")) {
        return validationError();
      }
      const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
      const model = input.model.trim();
      if (!isHttpUrl(baseUrl) || !model) {
        return validationError();
      }
      const current = await readAppConfig(configPath);
      const apiKey = input.clearApiKey
        ? undefined
        : input.apiKey?.trim() || current.chat?.apiKey;
      const headers = connectionTestHeaders(input.protocol, apiKey);
      // 字段名抄 openclaw 的兼容旗标：OpenAI 家族推理模型只认 max_completion_tokens。
      const maxTokensField = input.protocol === "openai" && input.maxTokensField === "max_completion_tokens"
        ? "max_completion_tokens"
        : "max_tokens";

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        const response = await fetch(chatEndpointUrl(input.protocol, baseUrl), {
          method: "POST",
          headers,
          signal: controller.signal,
          // 数值给到 16：部分推理网关要求 > 2，且推理模型需要余量才能产出可见文本。
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "请回复 OK" }],
            [maxTokensField]: 16,
            ...(input.protocol === "openai" ? { stream: false } : {}),
          }),
        });
        let body: unknown;
        let bodyParseFailed = false;
        try {
          body = await response.json();
        } catch {
          bodyParseFailed = true;
        }
        const detail = readServerDetail(body);
        if (response.status === 401 || response.status === 403) {
          return {
            ok: false,
            code: "AUTHENTICATION_ERROR",
            message: withServerDetail("API 密钥无效，或当前账号没有访问该模型的权限。", detail),
          };
        }
        if (response.status === 429 || response.status >= 500) {
          return {
            ok: false,
            code: "SERVICE_ERROR",
            message: "对话模型服务暂时不可用，请稍后重试。",
          };
        }
        if (!response.ok) {
          return {
            ok: false,
            code: "INVALID_RESPONSE",
            message: withServerDetail(
              "服务已响应，但返回格式与所选对话协议不兼容。",
              detail ? `HTTP ${response.status}：${detail}` : undefined,
            ),
          };
        }
        if (bodyParseFailed || !hasCompatibleResponse(input.protocol, body)) {
          return {
            ok: false,
            code: "INVALID_RESPONSE",
            message: "服务已响应，但返回格式与所选对话协议不兼容。",
          };
        }
        return {
          ok: true,
          model,
          message: "连接成功，模型已返回有效响应。",
        };
      } catch {
        if (controller.signal.aborted) {
          return {
            ok: false,
            code: "TIMEOUT",
            message: "连接测试超时，请稍后重试或检查服务状态。",
          };
        }
        return {
          ok: false,
          code: "NETWORK_ERROR",
          message: "无法连接对话模型服务，请检查接口地址、网络或代理设置。",
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
