import path from "node:path";

import {
  readAppConfig,
  type StoredAppConfig,
  updateAppConfig,
} from "./config-store.js";
import type {
  EmbeddingConnectionState,
  SaveEmbeddingConnectionInput,
  SaveEmbeddingConnectionResult,
  TestEmbeddingConnectionInput,
  TestEmbeddingConnectionResult,
} from "../shared/contracts.js";

type EmbeddingConnectionModuleOptions = {
  requestTimeoutMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function validationError(): SaveEmbeddingConnectionResult & TestEmbeddingConnectionResult {
  return {
    ok: false,
    code: "VALIDATION_ERROR",
    message: "请输入有效的 HTTP 或 HTTPS 接口地址，并填写嵌入模型名称。",
  };
}

function embeddingsUrl(baseUrl: string) {
  const url = new URL(baseUrl);
  url.search = "";
  url.hash = "";
  // 与对话连接的 /v1 归一化同一策略：裸域名补 /v1，粘贴完整端点不重复拼接。
  let pathname = url.pathname.replace(/\/+$/, "");
  if (pathname.endsWith("/embeddings")) pathname = pathname.slice(0, -"/embeddings".length);
  if (!pathname.endsWith("/v1")) pathname = `${pathname}/v1`;
  url.pathname = `${pathname}/embeddings`;
  return url;
}

function toState(config: StoredAppConfig): EmbeddingConnectionState {
  return {
    baseUrl: config.embedding?.baseUrl ?? "",
    model: config.embedding?.model ?? "",
    hasApiKey: Boolean(config.embedding?.apiKey),
  };
}

function validateInput(input: unknown): input is SaveEmbeddingConnectionInput {
  return isRecord(input)
    && typeof input.baseUrl === "string"
    && typeof input.model === "string"
    && (input.apiKey === undefined || typeof input.apiKey === "string")
    && (input.clearApiKey === undefined || typeof input.clearApiKey === "boolean");
}

function readDimensions(body: unknown) {
  if (!isRecord(body) || !Array.isArray(body.data) || !isRecord(body.data[0])) return undefined;
  const embedding = body.data[0].embedding;
  if (!Array.isArray(embedding)
    || embedding.length === 0
    || !embedding.every((value) => typeof value === "number" && Number.isFinite(value))) {
    return undefined;
  }
  return embedding.length;
}

function readEmbeddings(body: unknown) {
  if (!isRecord(body) || !Array.isArray(body.data)) return undefined;
  const rows = body.data
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .sort((left, right) => Number(left.index ?? 0) - Number(right.index ?? 0));
  const vectors = rows.map((row) => row.embedding);
  if (vectors.length === 0 || !vectors.every((vector) => (
    Array.isArray(vector)
    && vector.length > 0
    && vector.every((value) => typeof value === "number" && Number.isFinite(value))
  ))) return undefined;
  const dimensions = (vectors[0] as number[]).length;
  if (!vectors.every((vector) => (vector as number[]).length === dimensions)) return undefined;
  return vectors as number[][];
}

export function createEmbeddingConnectionModule(
  dataHome: string,
  options: EmbeddingConnectionModuleOptions = {},
) {
  const configPath = path.join(dataHome, "config.json");
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;

  return {
    async get(): Promise<EmbeddingConnectionState> {
      return toState(await readAppConfig(configPath));
    },

    async save(input: SaveEmbeddingConnectionInput): Promise<SaveEmbeddingConnectionResult> {
      if (!validateInput(input)) return validationError();
      const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
      const model = input.model.trim();
      if (!isHttpUrl(baseUrl) || !model) return validationError();

      const apiKey = input.apiKey?.trim();
      const config = await updateAppConfig(configPath, (current): StoredAppConfig => {
        const savedApiKey = input.clearApiKey
          ? undefined
          : apiKey || current.embedding?.apiKey;
        return {
          ...current,
          embedding: {
            baseUrl,
            model,
            ...(savedApiKey ? { apiKey: savedApiKey } : {}),
          },
        };
      });
      return { ok: true, connection: toState(config) };
    },

    async test(input: TestEmbeddingConnectionInput): Promise<TestEmbeddingConnectionResult> {
      if (!validateInput(input)) return validationError();
      const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
      const model = input.model.trim();
      if (!isHttpUrl(baseUrl) || !model) return validationError();

      const current = await readAppConfig(configPath);
      const apiKey = input.clearApiKey
        ? undefined
        : input.apiKey?.trim() || current.embedding?.apiKey;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        const response = await fetch(embeddingsUrl(baseUrl), {
          method: "POST",
          headers,
          signal: controller.signal,
          body: JSON.stringify({ model, input: "PDFMuse 连接测试" }),
        });
        if (response.status === 401 || response.status === 403) {
          return {
            ok: false,
            code: "AUTHENTICATION_ERROR",
            message: "API 密钥无效，或当前账号没有访问该嵌入模型的权限。",
          };
        }
        if (response.status === 429 || response.status >= 500) {
          return {
            ok: false,
            code: "SERVICE_ERROR",
            message: "嵌入模型服务暂时不可用，请稍后重试。",
          };
        }

        let body: unknown;
        try {
          body = await response.json();
        } catch {
          body = undefined;
        }
        const dimensions = readDimensions(body);
        if (!response.ok || dimensions === undefined) {
          return {
            ok: false,
            code: "INVALID_RESPONSE",
            message: "服务已响应，但返回的嵌入向量格式无效。",
          };
        }
        return {
          ok: true,
          model,
          dimensions,
          message: `连接成功，嵌入向量维度为 ${dimensions}。`,
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
          message: "无法连接嵌入模型服务，请检查接口地址、网络或代理设置。",
        };
      } finally {
        clearTimeout(timeout);
      }
    },

    /** Main 侧批量 Embedding 运行时；不向 Renderer 暴露 API Key。 */
    async embed(inputs: readonly string[], signal?: AbortSignal): Promise<readonly number[][]> {
      const config = await readAppConfig(configPath);
      const embedding = config.embedding;
      if (!embedding) throw new Error("嵌入模型尚未配置。");
      if (inputs.length === 0) return [];
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort);
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (embedding.apiKey) headers.Authorization = `Bearer ${embedding.apiKey}`;
        const response = await fetch(embeddingsUrl(embedding.baseUrl), {
          method: "POST",
          headers,
          signal: controller.signal,
          body: JSON.stringify({ model: embedding.model, input: [...inputs] }),
        });
        if (!response.ok) throw new Error(`嵌入模型服务返回 HTTP ${response.status}。`);
        const vectors = readEmbeddings(await response.json());
        if (!vectors || vectors.length !== inputs.length) throw new Error("嵌入模型返回了无效向量。");
        return vectors;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
