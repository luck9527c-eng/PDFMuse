import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createModelConnectionModule } from "./model-connection.js";

const dataHomes: string[] = [];
const servers: Server[] = [];

async function createDataHome() {
  const workspace = await mkdtemp(path.join(tmpdir(), "pdfmuse-model-connection-"));
  const dataHome = path.join(workspace, "data");
  await mkdir(dataHome);
  dataHomes.push(workspace);
  return dataHome;
}

afterEach(async () => {
  await Promise.all([
    ...dataHomes.splice(0).map((workspace) => rm(workspace, { recursive: true })),
    ...servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })),
  ]);
});

async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未获得端口");
  return `http://127.0.0.1:${address.port}`;
}

describe("Model Connection Module", () => {
  it("保存连接后只向 Reader 返回脱敏状态", async () => {
    const dataHome = await createDataHome();
    const connection = createModelConnectionModule(dataHome);

    await expect(connection.save({
      protocol: "openai",
      baseUrl: "https://api.example.com/v1/",
      model: "example-chat-model",
      apiKey: "secret-api-key",
    })).resolves.toEqual({
      ok: true,
      connection: {
        protocol: "openai",
        baseUrl: "https://api.example.com/v1",
        model: "example-chat-model",
        hasApiKey: true,
        contextWindow: 1_048_576,
      },
    });

    const reloaded = createModelConnectionModule(dataHome);
    await expect(reloaded.get()).resolves.toEqual({
      protocol: "openai",
      baseUrl: "https://api.example.com/v1",
      model: "example-chat-model",
      hasApiKey: true,
      contextWindow: 1_048_576,
    });
  });

  it("上下文窗口随连接保存读回，两档之外拒绝，缺省回落 1M", async () => {
    const dataHome = await createDataHome();
    const connection = createModelConnectionModule(dataHome);

    await expect(connection.save({
      protocol: "openai",
      baseUrl: "https://api.example.com/v1",
      model: "example-chat-model",
      contextWindow: 262_144,
    })).resolves.toMatchObject({ ok: true, connection: { contextWindow: 262_144 } });
    await expect(createModelConnectionModule(dataHome).get()).resolves.toMatchObject({
      contextWindow: 262_144,
    });

    await expect(connection.save({
      protocol: "openai",
      baseUrl: "https://api.example.com/v1",
      model: "example-chat-model",
      contextWindow: 100_000,
    })).resolves.toMatchObject({ ok: false, code: "VALIDATION_ERROR" });
    // 非法值被拒后原配置不变。
    await expect(connection.get()).resolves.toMatchObject({ contextWindow: 262_144 });
  });

  it("只有 Reader 明确要求时才清除已保存的 API Key", async () => {
    const dataHome = await createDataHome();
    const connection = createModelConnectionModule(dataHome);
    await connection.save({
      protocol: "openai",
      baseUrl: "https://api.example.com/v1",
      model: "first-model",
      apiKey: "saved-secret",
    });

    await expect(connection.save({
      protocol: "openai",
      baseUrl: "https://api.example.com/v1",
      model: "second-model",
    })).resolves.toMatchObject({
      ok: true,
      connection: { model: "second-model", hasApiKey: true },
    });

    await expect(connection.save({
      protocol: "openai",
      baseUrl: "https://api.example.com/v1",
      model: "second-model",
      clearApiKey: true,
    })).resolves.toMatchObject({
      ok: true,
      connection: { hasApiKey: false },
    });
  });

  it("拒绝无效配置并保留此前可用的连接", async () => {
    const dataHome = await createDataHome();
    const connection = createModelConnectionModule(dataHome);
    await connection.save({
      protocol: "openai",
      baseUrl: "https://api.example.com/v1",
      model: "working-model",
      apiKey: "saved-secret",
    });

    await expect(connection.save({
      protocol: "openai",
      baseUrl: "ftp://api.example.com/v1",
      model: " ",
    })).resolves.toEqual({
      ok: false,
      code: "VALIDATION_ERROR",
      message: "请选择支持的接口协议，输入有效的 HTTP 或 HTTPS 接口地址，并填写模型名称。",
    });
    await expect(connection.get()).resolves.toEqual({
      protocol: "openai",
      baseUrl: "https://api.example.com/v1",
      model: "working-model",
      hasApiKey: true,
      contextWindow: 1_048_576,
    });
  });

  it("使用已保存密钥测试当前对话模型连接", async () => {
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
          id: "chatcmpl-test",
          choices: [{ message: { role: "assistant", content: "OK" } }],
        }));
      });
    }));
    const dataHome = await createDataHome();
    const connection = createModelConnectionModule(dataHome);
    await connection.save({
      protocol: "openai",
      baseUrl: `${baseUrl}/v1`,
      model: "working-model",
      apiKey: "saved-secret",
    });

    await expect(connection.test({
      protocol: "openai",
      baseUrl: `${baseUrl}/v1`,
      model: "working-model",
    })).resolves.toEqual({
      ok: true,
      model: "working-model",
      message: "连接成功，模型已返回有效响应。",
    });
    expect(receivedRequest).toEqual({
      url: "/v1/chat/completions",
      authorization: "Bearer saved-secret",
      body: {
        model: "working-model",
        messages: [{ role: "user", content: "请回复 OK" }],
        max_tokens: 1,
        stream: false,
      },
    });
  });

  it("使用 Anthropic Messages 协议测试当前连接", async () => {
    let receivedRequest: {
      url?: string;
      authorization?: string;
      apiKey?: string;
      anthropicVersion?: string;
      body?: unknown;
    } = {};
    const baseUrl = await listen(createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        receivedRequest = {
          url: request.url,
          authorization: request.headers.authorization,
          apiKey: request.headers["x-api-key"] as string | undefined,
          anthropicVersion: request.headers["anthropic-version"] as string | undefined,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        };
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          id: "msg-test",
          content: [{ type: "text", text: "OK" }],
        }));
      });
    }));
    const dataHome = await createDataHome();
    const connection = createModelConnectionModule(dataHome);
    await connection.save({
      protocol: "anthropic",
      baseUrl,
      model: "claude-test-model",
      apiKey: "anthropic-secret",
    });

    await expect(connection.test({
      protocol: "anthropic",
      baseUrl,
      model: "claude-test-model",
    })).resolves.toMatchObject({ ok: true, model: "claude-test-model" });
    expect(receivedRequest).toEqual({
      url: "/v1/messages",
      authorization: undefined,
      apiKey: "anthropic-secret",
      anthropicVersion: "2023-06-01",
      body: {
        model: "claude-test-model",
        messages: [{ role: "user", content: "请回复 OK" }],
        max_tokens: 1,
      },
    });
    await expect(connection.get()).resolves.toMatchObject({ protocol: "anthropic" });
  });

  it("测试清除密钥的表单草稿时不回退使用已保存密钥", async () => {
    let authorization: string | undefined;
    const baseUrl = await listen(createServer((request, response) => {
      authorization = request.headers.authorization;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ message: { content: "OK" } }],
      }));
    }));
    const dataHome = await createDataHome();
    const connection = createModelConnectionModule(dataHome);
    await connection.save({
      protocol: "openai",
      baseUrl: `${baseUrl}/v1`,
      model: "working-model",
      apiKey: "saved-secret",
    });

    await expect(connection.test({
      protocol: "openai",
      baseUrl: `${baseUrl}/v1`,
      model: "working-model",
      clearApiKey: true,
    })).resolves.toMatchObject({ ok: true });
    expect(authorization).toBeUndefined();
  });

  it("将鉴权失败转换为 Reader 可理解的结果", async () => {
    const baseUrl = await listen(createServer((_request, response) => {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "invalid token" } }));
    }));
    const dataHome = await createDataHome();
    const connection = createModelConnectionModule(dataHome);

    await expect(connection.test({
      protocol: "openai",
      baseUrl: `${baseUrl}/v1`,
      model: "working-model",
      apiKey: "wrong-secret",
    })).resolves.toEqual({
      ok: false,
      code: "AUTHENTICATION_ERROR",
      message: "API 密钥无效，或当前账号没有访问该模型的权限。",
    });
  });

  it("将网络不可达转换为可重试结果", async () => {
    const unavailableServer = createServer();
    const unavailableBaseUrl = await listen(unavailableServer);
    await new Promise<void>((resolve, reject) => {
      unavailableServer.close((error) => error ? reject(error) : resolve());
    });
    servers.splice(servers.indexOf(unavailableServer), 1);
    const dataHome = await createDataHome();
    const connection = createModelConnectionModule(dataHome);

    await expect(connection.test({
      protocol: "openai",
      baseUrl: `${unavailableBaseUrl}/v1`,
      model: "working-model",
      apiKey: "secret",
    })).resolves.toEqual({
      ok: false,
      code: "NETWORK_ERROR",
      message: "无法连接对话模型服务，请检查接口地址、网络或代理设置。",
    });
  });

  it("将连接超时与普通网络错误区分", async () => {
    const baseUrl = await listen(createServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          choices: [{ message: { content: "OK" } }],
        }));
      }, 250);
    }));
    const dataHome = await createDataHome();
    const connection = createModelConnectionModule(dataHome, { requestTimeoutMs: 25 });

    await expect(connection.test({
      protocol: "openai",
      baseUrl: `${baseUrl}/v1`,
      model: "slow-model",
    })).resolves.toEqual({
      ok: false,
      code: "TIMEOUT",
      message: "连接测试超时，请稍后重试或检查服务状态。",
    });
  });

  it("识别可访问但不兼容的对话模型响应", async () => {
    const baseUrl = await listen(createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ result: "not-openai-compatible" }));
    }));
    const dataHome = await createDataHome();
    const connection = createModelConnectionModule(dataHome);

    await expect(connection.test({
      protocol: "openai",
      baseUrl: `${baseUrl}/v1`,
      model: "wrong-endpoint-model",
    })).resolves.toEqual({
      ok: false,
      code: "INVALID_RESPONSE",
      message: "服务已响应，但返回格式与所选对话协议不兼容。",
    });
  });

  it("测试未保存草稿前先返回配置校验错误", async () => {
    const dataHome = await createDataHome();
    const connection = createModelConnectionModule(dataHome);

    await expect(connection.test({
      protocol: "openai",
      baseUrl: "not-a-url",
      model: "",
    })).resolves.toEqual({
      ok: false,
      code: "VALIDATION_ERROR",
      message: "请选择支持的接口协议，输入有效的 HTTP 或 HTTPS 接口地址，并填写模型名称。",
    });
  });

  it("拒绝来自 IPC 的错误字段类型而不抛出异常", async () => {
    const dataHome = await createDataHome();
    const connection = createModelConnectionModule(dataHome);

    await expect(connection.save({
      protocol: "openai",
      baseUrl: 42,
      model: ["wrong-type"],
    } as unknown as Parameters<typeof connection.save>[0])).resolves.toEqual({
      ok: false,
      code: "VALIDATION_ERROR",
      message: "请选择支持的接口协议，输入有效的 HTTP 或 HTTPS 接口地址，并填写模型名称。",
    });
    await expect(connection.test({
      protocol: "openai",
      baseUrl: "https://api.example.com/v1",
      model: "test-model",
      clearApiKey: "yes",
    } as unknown as Parameters<typeof connection.test>[0])).resolves.toMatchObject({
      ok: false,
      code: "VALIDATION_ERROR",
    });
    await expect(connection.save({
      protocol: "unsupported",
      baseUrl: "https://api.example.com/v1",
      model: "test-model",
    } as unknown as Parameters<typeof connection.save>[0])).resolves.toMatchObject({
      ok: false,
      code: "VALIDATION_ERROR",
    });
  });
});
