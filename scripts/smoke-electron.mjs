import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to reserve a debugging port."));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForPage(port) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page" && target.title === "PDFMuse");
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // Electron has not exposed the debugging endpoint yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("PDFMuse did not expose a renderer page within 8 seconds.");
}

function evaluate(webSocketUrl, expression) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Renderer evaluation timed out."));
    }, 3_000);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true, awaitPromise: true },
      }));
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (message.error || message.result.exceptionDetails) {
        reject(new Error(JSON.stringify(message.error ?? message.result.exceptionDetails)));
      }
      else resolve(message.result.result.value);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Unable to connect to the Electron renderer."));
    });
  });
}

async function waitForStartup(webSocketUrl) {
  const deadline = Date.now() + 8_000;
  let state = { apiType: "undefined", text: "" };
  while (Date.now() < deadline) {
    state = await evaluate(
      webSocketUrl,
      `({ apiType: typeof window.pdfMuse, text: document.body.innerText })`,
    );
    if (state.apiType === "object" && /选择 PDF/.test(state.text)) return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return state;
}

async function waitForText(webSocketUrl, expected) {
  const deadline = Date.now() + 3_000;
  let bodyText = "";
  while (Date.now() < deadline) {
    bodyText = await evaluate(webSocketUrl, "document.body.innerText");
    if (bodyText.includes(expected)) return bodyText;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return bodyText;
}

const projectRoot = path.resolve(import.meta.dirname, "..");
const electronExecutable = path.join(
  projectRoot,
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron",
);
const profile = await mkdtemp(path.join(os.tmpdir(), "pdfmuse-smoke-"));
const testApplicationDirectory = await mkdtemp(path.join(os.tmpdir(), "pdfmuse-app-"));
const port = await reservePort();
let receivedModelRequest;
let receivedEmbeddingRequest;
const modelServer = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const receivedRequest = {
      url: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
    if (request.url?.endsWith("/embeddings")) {
      receivedEmbeddingRequest = receivedRequest;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        data: [{ index: 0, embedding: [0.1, -0.2, 0.3, 0.4] }],
        model: "smoke-embedding-model",
      }));
      return;
    }
    receivedModelRequest = receivedRequest;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      id: "chatcmpl-smoke",
      choices: [{ message: { role: "assistant", content: "OK" } }],
    }));
  });
});
await new Promise((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
const modelAddress = modelServer.address();
if (!modelAddress || typeof modelAddress === "string") {
  throw new Error("Local model server did not expose a port.");
}
const modelBaseUrl = `http://127.0.0.1:${modelAddress.port}/v1`;
const child = spawn(
  electronExecutable,
  [".", `--remote-debugging-port=${port}`, "--headless", "--disable-gpu", `--user-data-dir=${profile}`],
  {
    cwd: projectRoot,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      PDFMUSE_TEST_APPLICATION_DIRECTORY: testApplicationDirectory,
      VITE_DEV_SERVER_URL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let diagnostics = "";
child.stdout.on("data", (chunk) => { diagnostics += chunk; });
child.stderr.on("data", (chunk) => { diagnostics += chunk; });

try {
  const page = await waitForPage(port);
  const state = await waitForStartup(page.webSocketDebuggerUrl);
  assert.equal(state.apiType, "object", `preload API is ${state.apiType}`);
  assert.match(state.text, /选择 PDF/, "the startup screen is blank");
  const modelConnection = await evaluate(
    page.webSocketDebuggerUrl,
    `window.pdfMuse.getModelConnection()`,
  );
  assert.equal(typeof modelConnection.baseUrl, "string", "model base URL is unavailable");
  assert.equal(typeof modelConnection.model, "string", "model name is unavailable");
  assert.equal(modelConnection.protocol, "openai", "default model protocol is unavailable");
  assert.equal(typeof modelConnection.hasApiKey, "boolean", "API key state is unavailable");
  assert.equal("apiKey" in modelConnection, false, "preload exposed the saved API key");
  const savedConnection = await evaluate(
    page.webSocketDebuggerUrl,
    `window.pdfMuse.saveModelConnection(${JSON.stringify({
      protocol: "openai",
      baseUrl: modelBaseUrl,
      model: "smoke-chat-model",
      apiKey: "smoke-secret",
    })})`,
  );
  assert.equal(savedConnection.ok, true, "model connection could not be saved through IPC");
  assert.equal(savedConnection.connection.hasApiKey, true, "saved API key state is unavailable");
  assert.equal("apiKey" in savedConnection.connection, false, "save IPC exposed the API key");
  const testedConnection = await evaluate(
    page.webSocketDebuggerUrl,
    `window.pdfMuse.testModelConnection(${JSON.stringify({
      protocol: "openai",
      baseUrl: modelBaseUrl,
      model: "smoke-chat-model",
    })})`,
  );
  assert.equal(testedConnection.ok, true, "local model connection test failed through IPC");
  assert.deepEqual(receivedModelRequest, {
    url: "/v1/chat/completions",
    authorization: "Bearer smoke-secret",
    body: {
      model: "smoke-chat-model",
      messages: [{ role: "user", content: "请回复 OK" }],
      max_tokens: 1,
      stream: false,
    },
  });
  const embeddingConnection = await evaluate(
    page.webSocketDebuggerUrl,
    `window.pdfMuse.getEmbeddingConnection()`,
  );
  assert.deepEqual(embeddingConnection, {
    baseUrl: "",
    model: "",
    hasApiKey: false,
  }, "initial embedding connection state is invalid");
  const savedEmbedding = await evaluate(
    page.webSocketDebuggerUrl,
    `window.pdfMuse.saveEmbeddingConnection(${JSON.stringify({
      baseUrl: modelBaseUrl,
      model: "smoke-embedding-model",
      apiKey: "smoke-embedding-secret",
    })})`,
  );
  assert.equal(savedEmbedding.ok, true, "embedding connection could not be saved through IPC");
  assert.equal(savedEmbedding.connection.hasApiKey, true, "embedding API key state is unavailable");
  assert.equal("apiKey" in savedEmbedding.connection, false, "embedding save IPC exposed the API key");
  const testedEmbedding = await evaluate(
    page.webSocketDebuggerUrl,
    `window.pdfMuse.testEmbeddingConnection(${JSON.stringify({
      baseUrl: modelBaseUrl,
      model: "smoke-embedding-model",
    })})`,
  );
  assert.deepEqual(testedEmbedding, {
    ok: true,
    model: "smoke-embedding-model",
    dimensions: 4,
    message: "连接成功，嵌入向量维度为 4。",
  }, "local embedding connection test failed through IPC");
  assert.deepEqual(receivedEmbeddingRequest, {
    url: "/v1/embeddings",
    authorization: "Bearer smoke-embedding-secret",
    body: { model: "smoke-embedding-model", input: "PDFMuse 连接测试" },
  });
  const storedConfig = JSON.parse(await readFile(
    path.join(testApplicationDirectory, "data", "config.json"),
    "utf8",
  ));
  assert.equal(storedConfig.version, 2, "stored config has no explicit version");
  assert.equal(storedConfig.chat.protocol, "openai", "Main did not persist the protocol");
  assert.equal(storedConfig.chat.apiKey, "smoke-secret", "Main did not persist the API key");
  assert.equal(storedConfig.embedding.model, "smoke-embedding-model", "Main did not persist the embedding model");
  assert.equal(storedConfig.embedding.apiKey, "smoke-embedding-secret", "Main did not persist the embedding API key");
  await evaluate(
    page.webSocketDebuggerUrl,
    `document.querySelector('[aria-label="模型与阅读设置"]')?.click()`,
  );
  const settingsText = await waitForText(page.webSocketDebuggerUrl, "保存配置");
  assert.match(settingsText, /测试连接/, "model connection test command is unavailable");
  assert.match(settingsText, /接口协议/, "model protocol selector is unavailable");
  assert.match(settingsText, /API 密钥/, "API key editor is unavailable");
  assert.match(settingsText, /测试嵌入连接/, "embedding connection test command is unavailable");
  assert.match(settingsText, /保存嵌入配置/, "embedding connection save command is unavailable");
  assert.match(settingsText, /尚未安装 OCR 工作进程资源/, "startup warnings are unavailable in settings");
  const protocolOptions = await evaluate(
    page.webSocketDebuggerUrl,
    `Array.from(document.querySelectorAll('select option')).map((option) => option.textContent)`,
  );
  assert.deepEqual(protocolOptions, ["OpenAI", "Anthropic"], "model protocol options are incomplete");
  const visibleTooltipsWithoutHover = await evaluate(
    page.webSocketDebuggerUrl,
    `new Promise((resolve) => setTimeout(() => resolve(
      Array.from(document.querySelectorAll('[role="tooltip"]'))
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => element.textContent)
    ), 650))`,
  );
  assert.deepEqual(visibleTooltipsWithoutHover, [], "icon tooltips are visible without pointer hover");
  const visibleTooltipsOnHover = await evaluate(
    page.webSocketDebuggerUrl,
    `new Promise((resolve) => {
      document.querySelector('[aria-label="关闭设置"]')?.dispatchEvent(
        new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })
      );
      setTimeout(() => resolve(
        Array.from(document.querySelectorAll('[role="tooltip"]'))
          .filter((element) => element.getClientRects().length > 0)
          .map((element) => element.textContent)
      ), 100);
    })`,
  );
  assert.deepEqual(visibleTooltipsOnHover, ["关闭设置"], "icon tooltip is unavailable on pointer hover");
  console.log("Electron smoke test passed: startup UI and preload API are available.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (diagnostics.trim()) console.error(diagnostics.trim());
  process.exitCode = 1;
} finally {
  child.kill();
  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
  }
  await new Promise((resolve, reject) => {
    modelServer.close((error) => error ? reject(error) : resolve());
  });
  await Promise.all([
    rm(profile, { recursive: true, force: true }),
    rm(testApplicationDirectory, { recursive: true, force: true }),
  ]);
}
