import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createEmbeddingConnectionModule } from "./embedding-connection.js";
import { createModelConnectionModule } from "./model-connection.js";

const workspaces: string[] = [];
const servers: Server[] = [];

async function createDataHome() {
  const workspace = await mkdtemp(path.join(tmpdir(), "pdfmuse-embedding-connection-"));
  const dataHome = path.join(workspace, "data");
  await mkdir(dataHome);
  workspaces.push(workspace);
  return dataHome;
}

async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未获得端口");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all([
    ...workspaces.splice(0).map((workspace) => rm(workspace, { recursive: true })),
    ...servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })),
  ]);
});

describe("Embedding Connection Module", () => {
  it("独立保存嵌入连接并只返回脱敏状态", async () => {
    const dataHome = await createDataHome();
    const chat = createModelConnectionModule(dataHome);
    const embedding = createEmbeddingConnectionModule(dataHome);
    await chat.save({
      protocol: "anthropic",
      baseUrl: "https://api.anthropic.com",
      model: "claude-test",
      apiKey: "chat-secret",
    });

    await expect(embedding.save({
      baseUrl: "https://embedding.example.com/v1/",
      model: "embedding-model",
      apiKey: "embedding-secret",
    })).resolves.toEqual({
      ok: true,
      connection: {
        baseUrl: "https://embedding.example.com/v1",
        model: "embedding-model",
        hasApiKey: true,
      },
    });
    await expect(chat.get()).resolves.toMatchObject({
      protocol: "anthropic",
      model: "claude-test",
      hasApiKey: true,
    });
    const stored = JSON.parse(await readFile(path.join(dataHome, "config.json"), "utf8"));
    expect(stored.chat.apiKey).toBe("chat-secret");
    expect(stored.embedding.apiKey).toBe("embedding-secret");
  });

  it("并发保存对话和嵌入连接时互不覆盖", async () => {
    const dataHome = await createDataHome();
    const chat = createModelConnectionModule(dataHome);
    const embedding = createEmbeddingConnectionModule(dataHome);

    await Promise.all([
      chat.save({
        protocol: "openai",
        baseUrl: "https://chat.example.com/v1",
        model: "chat-model",
      }),
      embedding.save({
        baseUrl: "https://embedding.example.com/v1",
        model: "embedding-model",
      }),
    ]);

    await expect(chat.get()).resolves.toMatchObject({ model: "chat-model" });
    await expect(embedding.get()).resolves.toMatchObject({ model: "embedding-model" });
  });

  it("向本地假服务发送最小请求并返回向量维度", async () => {
    let receivedRequest: { url?: string; authorization?: string; body?: unknown } = {};
    const baseUrl = await listen(createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        receivedRequest = {
          url: request.url,
          authorization: request.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        };
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          data: [{ index: 0, embedding: [0.1, -0.2, 0.3] }],
          model: "embedding-model",
        }));
      });
    }));
    const dataHome = await createDataHome();
    const embedding = createEmbeddingConnectionModule(dataHome);
    await embedding.save({
      baseUrl: `${baseUrl}/v1`,
      model: "embedding-model",
      apiKey: "embedding-secret",
    });

    await expect(embedding.test({
      baseUrl: `${baseUrl}/v1`,
      model: "embedding-model",
    })).resolves.toEqual({
      ok: true,
      model: "embedding-model",
      dimensions: 3,
      message: "连接成功，嵌入向量维度为 3。",
    });
    expect(receivedRequest).toEqual({
      url: "/v1/embeddings",
      authorization: "Bearer embedding-secret",
      body: { model: "embedding-model", input: "PDFMuse 连接测试" },
    });
  });

  it("拒绝空向量、非数值和非有限数值", async () => {
    const responses = [[], [0.1, "bad"], [0.1, null]];
    for (const vector of responses) {
      const baseUrl = await listen(createServer((_request, response) => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ data: [{ embedding: vector }] }));
      }));
      const dataHome = await createDataHome();
      const embedding = createEmbeddingConnectionModule(dataHome);

      await expect(embedding.test({
        baseUrl: `${baseUrl}/v1`,
        model: "embedding-model",
      })).resolves.toEqual({
        ok: false,
        code: "INVALID_RESPONSE",
        message: "服务已响应，但返回的嵌入向量格式无效。",
      });
    }
  });

  it("区分鉴权失败和服务暂时不可用", async () => {
    for (const [status, code] of [[401, "AUTHENTICATION_ERROR"], [429, "SERVICE_ERROR"]] as const) {
      const baseUrl = await listen(createServer((_request, response) => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "failed" } }));
      }));
      const dataHome = await createDataHome();
      const embedding = createEmbeddingConnectionModule(dataHome);

      await expect(embedding.test({
        baseUrl: `${baseUrl}/v1`,
        model: "embedding-model",
      })).resolves.toMatchObject({ ok: false, code });
    }
  });

  it("区分网络不可达和连接超时", async () => {
    const unavailableServer = createServer();
    const unavailableBaseUrl = await listen(unavailableServer);
    await new Promise<void>((resolve, reject) => {
      unavailableServer.close((error) => error ? reject(error) : resolve());
    });
    servers.splice(servers.indexOf(unavailableServer), 1);
    const slowBaseUrl = await listen(createServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ data: [{ embedding: [0.1] }] }));
      }, 250);
    }));
    const dataHome = await createDataHome();

    await expect(createEmbeddingConnectionModule(dataHome).test({
      baseUrl: `${unavailableBaseUrl}/v1`,
      model: "embedding-model",
    })).resolves.toMatchObject({ ok: false, code: "NETWORK_ERROR" });
    await expect(createEmbeddingConnectionModule(dataHome, { requestTimeoutMs: 25 }).test({
      baseUrl: `${slowBaseUrl}/v1`,
      model: "embedding-model",
    })).resolves.toMatchObject({ ok: false, code: "TIMEOUT" });
  });

  it("只有 Reader 明确要求时才清除或忽略已保存密钥", async () => {
    let authorization: string | undefined;
    const baseUrl = await listen(createServer((request, response) => {
      authorization = request.headers.authorization;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: [{ embedding: [0.1] }] }));
    }));
    const dataHome = await createDataHome();
    const embedding = createEmbeddingConnectionModule(dataHome);
    await embedding.save({
      baseUrl: `${baseUrl}/v1`,
      model: "embedding-model",
      apiKey: "saved-secret",
    });

    await expect(embedding.test({
      baseUrl: `${baseUrl}/v1`,
      model: "embedding-model",
      clearApiKey: true,
    })).resolves.toMatchObject({ ok: true });
    expect(authorization).toBeUndefined();
    await expect(embedding.save({
      baseUrl: `${baseUrl}/v1`,
      model: "embedding-model",
      clearApiKey: true,
    })).resolves.toMatchObject({ connection: { hasApiKey: false } });
  });

  it("拒绝无效 URL、空模型和错误字段类型", async () => {
    const dataHome = await createDataHome();
    const embedding = createEmbeddingConnectionModule(dataHome);

    await expect(embedding.save({
      baseUrl: "ftp://embedding.example.com",
      model: " ",
    })).resolves.toMatchObject({ ok: false, code: "VALIDATION_ERROR" });
    await expect(embedding.test({
      baseUrl: 42,
      model: ["wrong"],
    } as unknown as Parameters<typeof embedding.test>[0])).resolves.toMatchObject({
      ok: false,
      code: "VALIDATION_ERROR",
    });
  });

  it("嵌入测试在裸域名地址上自动补全 /v1 路径", async () => {
    let receivedUrl: string | undefined;
    const baseUrl = await listen(createServer((request, response) => {
      receivedUrl = request.url;
      if (!request.url?.startsWith("/v1/")) {
        response.writeHead(403, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          message: "HTTP node only allows access to inference API paths (/v1/embeddings)",
          success: false,
        }));
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }));
    }));
    const dataHome = await createDataHome();
    const embedding = createEmbeddingConnectionModule(dataHome);

    await expect(embedding.test({
      baseUrl,
      model: "embedding-model",
      apiKey: "secret",
    })).resolves.toMatchObject({ ok: true, dimensions: 2 });
    expect(receivedUrl).toBe("/v1/embeddings");
  });
});
