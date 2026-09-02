import path from "node:path";

import {
  readAppConfig,
  type StoredAppConfig,
  writeAppConfig,
} from "./config-store.js";
import type {
  ModelConnectionState,
  SaveModelConnectionInput,
  SaveModelConnectionResult,
  TestModelConnectionInput,
  TestModelConnectionResult,
} from "../shared/contracts.js";

type ModelConnectionModuleOptions = {
  requestTimeoutMs?: number;
};

function toState(config: StoredAppConfig): ModelConnectionState {
  return {
    baseUrl: config.chat?.baseUrl ?? "",
    model: config.chat?.model ?? "",
    hasApiKey: Boolean(config.chat?.apiKey),
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
    message: "请输入有效的 HTTP 或 HTTPS 接口地址，并填写模型名称。",
  };
}

function chatCompletionsUrl(baseUrl: string) {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/chat/completions`;
  url.search = "";
  url.hash = "";
  return url;
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
        || typeof input.baseUrl !== "string"
        || typeof input.model !== "string"
        || (input.apiKey !== undefined && typeof input.apiKey !== "string")
        || (input.clearApiKey !== undefined && typeof input.clearApiKey !== "boolean")) {
        return validationError();
      }
      const current = await readAppConfig(configPath);
      const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
      const model = input.model.trim();
      if (!isHttpUrl(baseUrl) || !model) {
        return validationError();
      }
      const apiKey = input.apiKey?.trim();
      const savedApiKey = input.clearApiKey
        ? undefined
        : apiKey || current.chat?.apiKey;
      const config: StoredAppConfig = {
        ...current,
        version: 1,
        chat: {
          baseUrl,
          model,
          ...(savedApiKey ? { apiKey: savedApiKey } : {}),
        },
      };
      await writeAppConfig(configPath, config);
      return { ok: true, connection: toState(config) };
    },

    async test(input: TestModelConnectionInput): Promise<TestModelConnectionResult> {
      if (!isRecord(input)
        || typeof input.baseUrl !== "string"
        || typeof input.model !== "string"
        || (input.apiKey !== undefined && typeof input.apiKey !== "string")
        || (input.clearApiKey !== undefined && typeof input.clearApiKey !== "boolean")) {
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
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        const response = await fetch(chatCompletionsUrl(baseUrl), {
          method: "POST",
          headers,
          signal: controller.signal,
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "请回复 OK" }],
            max_tokens: 1,
            stream: false,
          }),
        });
        if (response.status === 401 || response.status === 403) {
          return {
            ok: false,
            code: "AUTHENTICATION_ERROR",
            message: "API 密钥无效，或当前账号没有访问该模型的权限。",
          };
        }
        let body: { choices?: Array<{ message?: { content?: unknown } }> };
        try {
          body = await response.json() as typeof body;
        } catch {
          return {
            ok: false,
            code: "INVALID_RESPONSE",
            message: "服务已响应，但返回格式与 OpenAI 对话接口不兼容。",
          };
        }
        if (!response.ok || typeof body.choices?.[0]?.message?.content !== "string") {
          return {
            ok: false,
            code: "INVALID_RESPONSE",
            message: "服务已响应，但返回格式与 OpenAI 对话接口不兼容。",
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
