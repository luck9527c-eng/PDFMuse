import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
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
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // Electron has not exposed the debugging endpoint yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("PDFMuse did not expose a renderer page within 8 seconds.");
}

function command(webSocketUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Renderer evaluation timed out."));
    }, 3_000);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        id: 1,
        method,
        params,
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
      else resolve(message.result);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Unable to connect to the Electron renderer."));
    });
  });
}

async function evaluate(webSocketUrl, expression) {
  const result = await command(webSocketUrl, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return result.result.value;
}

async function setSmokeFile(webSocketUrl, filePath) {
  await evaluate(
    webSocketUrl,
    `(() => {
      let input = document.querySelector('#smoke-pdf-input');
      if (!input) {
        input = document.createElement('input');
        input.id = 'smoke-pdf-input';
        input.type = 'file';
        input.hidden = true;
        document.body.append(input);
      }
    })()`,
  );
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Setting the smoke test file timed out."));
    }, 3_000);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id: 1, method: "DOM.getDocument", params: {} }));
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.error) {
        clearTimeout(timer);
        socket.close();
        reject(new Error(JSON.stringify(message.error)));
        return;
      }
      if (message.id === 1) {
        socket.send(JSON.stringify({
          id: 2,
          method: "DOM.querySelector",
          params: { nodeId: message.result.root.nodeId, selector: "#smoke-pdf-input" },
        }));
      } else if (message.id === 2) {
        socket.send(JSON.stringify({
          id: 3,
          method: "DOM.setFileInputFiles",
          params: { files: [filePath], nodeId: message.result.nodeId },
        }));
      } else if (message.id === 3) {
        clearTimeout(timer);
        socket.close();
        resolve();
      }
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Unable to set the smoke test file."));
    });
  });
}

async function dropSmokeFile(webSocketUrl, filePath) {
  await setSmokeFile(webSocketUrl, filePath);
  return evaluate(
    webSocketUrl,
    `(() => {
      const input = document.querySelector('#smoke-pdf-input');
      const target = document.querySelector('.library-view');
      const transfer = new DataTransfer();
      transfer.items.add(input.files[0]);
      return target.dispatchEvent(new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }));
    })()`,
  );
}

async function waitForStartup(webSocketUrl) {
  const deadline = Date.now() + 8_000;
  let state = { apiType: "undefined", text: "", ready: false };
  while (Date.now() < deadline) {
    state = await evaluate(
      webSocketUrl,
      `({
        apiType: typeof window.pdfMuse,
        text: document.body.innerText,
        ready: Boolean(document.querySelector('.library-view, .workspace')),
      })`,
    );
    if (state.apiType === "object" && state.ready) return state;
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
const damagedPdfPath = path.join(testApplicationDirectory, "damaged.pdf");
await writeFile(damagedPdfPath, "%PDF-1.7\ninvalid");
const fixturePath = path.join(testApplicationDirectory, "smoke-book.pdf");
await copyFile(path.join(projectRoot, "src", "main", "fixtures", "navigation.pdf"), fixturePath);
const encryptedFixturePath = path.join(testApplicationDirectory, "encrypted-book.pdf");
await copyFile(path.join(projectRoot, "src", "main", "fixtures", "encrypted.pdf"), encryptedFixturePath);
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
let diagnostics = "";

function launchElectron(port) {
  const process = spawn(
    electronExecutable,
    [".", `--remote-debugging-port=${port}`, "--headless", "--disable-gpu", `--user-data-dir=${profile}`],
    {
      cwd: projectRoot,
      env: {
        ...globalThis.process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        PDFMUSE_TEST_APPLICATION_DIRECTORY: testApplicationDirectory,
        VITE_DEV_SERVER_URL: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  process.stdout.on("data", (chunk) => { diagnostics += chunk; });
  process.stderr.on("data", (chunk) => { diagnostics += chunk; });
  return process;
}

async function stopElectron(process) {
  if (!process || process.exitCode !== null) return;
  process.kill();
  if (globalThis.process.platform === "win32" && process.pid) {
    spawnSync("taskkill", ["/pid", String(process.pid), "/t", "/f"], { stdio: "ignore" });
  }
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 1_000);
    process.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

let port = await reservePort();
let child = launchElectron(port);

try {
  let page = await waitForPage(port);
  let state = await waitForStartup(page.webSocketDebuggerUrl);
  assert.equal(state.apiType, "object", `preload API is ${state.apiType}`);
  assert.match(state.text, /选择 PDF/, "the startup screen is blank");
  assert.match(state.text, /书库/, "the Library screen is unavailable");
  const initialLibrary = await evaluate(page.webSocketDebuggerUrl, "window.pdfMuse.listLibraryBooks()");
  assert.deepEqual(initialLibrary, [], "the isolated Library is not empty");
  await dropSmokeFile(page.webSocketDebuggerUrl, fixturePath);
  const readerText = await waitForText(page.webSocketDebuggerUrl, "PDFMuse Navigation Fixture");
  assert.match(readerText, /AI 助手/, "dropping a valid PDF did not open the reading workspace");
  const outlineText = await waitForText(page.webSocketDebuggerUrl, "Section One");
  assert.match(outlineText, /Chapter One/, "the embedded Book Outline is unavailable");
  const readerControls = await evaluate(
    page.webSocketDebuggerUrl,
    `new Promise((resolve, reject) => {
      const deadline = Date.now() + 2500;
      const inspect = () => {
        if (document.querySelector('.viewer-loading')) {
          if (Date.now() >= deadline) return reject(new Error('PDF controls did not become ready'));
          setTimeout(inspect, 50);
          return;
        }
        const container = document.querySelector('.pdf-container');
        const initialScale = Number(document.querySelector('.zoom-value')?.textContent?.replace('%', ''));
        container.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaY: -120,
          clientX: container.getBoundingClientRect().left + 100,
          clientY: container.getBoundingClientRect().top + 100,
        }));
        const resize = document.querySelector('[aria-label="调整左侧栏宽度"]');
        const initialLeftWidth = document.querySelector('.left-sidebar').getBoundingClientRect().width;
        const resizeX = resize.getBoundingClientRect().left;
        resize.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: resizeX }));
        window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: resizeX - 40 }));
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: resizeX - 40 }));
        const rightResize = document.querySelector('[aria-label="调整右侧栏宽度"]');
        const initialRightWidth = document.querySelector('.assistant-panel').getBoundingClientRect().width;
        const rightResizeX = rightResize.getBoundingClientRect().left;
        rightResize.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: rightResizeX }));
        window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: rightResizeX + 40 }));
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: rightResizeX + 40 }));
        setTimeout(() => {
          const reader = document.querySelector('.reader').getBoundingClientRect();
          const toolbar = document.querySelector('.reader-toolbar').getBoundingClientRect();
          resolve({
            initialScale,
            initialLeftWidth,
            initialRightWidth,
            scale: Number(document.querySelector('.zoom-value')?.textContent?.replace('%', '')),
            leftWidth: document.querySelector('.left-sidebar').getBoundingClientRect().width,
            rightWidth: document.querySelector('.assistant-panel').getBoundingClientRect().width,
            toolbarContained: toolbar.left >= reader.left && toolbar.right <= reader.right,
          });
        }, 180);
      };
      inspect();
    })`,
  );
  assert.ok(readerControls.scale > readerControls.initialScale, "Ctrl+mouse wheel did not zoom the PDF");
  assert.ok(readerControls.leftWidth < readerControls.initialLeftWidth, "the left sidebar resize handle did not change its width");
  assert.ok(readerControls.rightWidth < readerControls.initialRightWidth, "the right sidebar resize handle did not change its width");
  assert.equal(readerControls.toolbarContained, true, "resizing a sidebar pushed the PDF toolbar outside the reader");
  await evaluate(page.webSocketDebuggerUrl, `document.querySelector('.sidebar-tabs button:nth-child(2)')?.click()`);
  const thumbnails = await evaluate(
    page.webSocketDebuggerUrl,
    `new Promise((resolve) => setTimeout(() => resolve({
      count: document.querySelectorAll('.pdf-thumbnail').length,
      rendered: document.querySelectorAll('.pdf-thumbnail img').length,
    }), 500))`,
  );
  assert.deepEqual(thumbnails, { count: 3, rendered: 3 }, "page thumbnails are incomplete");
  await evaluate(page.webSocketDebuggerUrl, `document.querySelector('.sidebar-tabs button:first-child')?.click()`);
  await evaluate(
    page.webSocketDebuggerUrl,
    `new Promise((resolve) => {
      document.querySelector('[aria-label="在 PDF 中查找"]')?.click();
      setTimeout(() => {
        const input = document.querySelector('.find-bar input');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'PDFMuse search target');
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
        input.form.requestSubmit();
        resolve(true);
      }, 50);
    })`,
  );
  const findText = await waitForText(page.webSocketDebuggerUrl, "1 / 9");
  assert.match(findText, /1 \/ 9/, "PDF search result position and total are unavailable");
  const populatedLibrary = await evaluate(page.webSocketDebuggerUrl, "window.pdfMuse.listLibraryBooks()");
  assert.match(populatedLibrary[0].id, /^[a-f0-9]{64}$/, "the PDF content fingerprint is invalid");
  assert.equal(populatedLibrary[0].title, "PDFMuse Navigation Fixture", "the PDF metadata title is invalid");
  assert.equal(populatedLibrary[0].pageCount, 3, "the PDF page count is invalid");
  await evaluate(
    page.webSocketDebuggerUrl,
    `document.querySelector('[aria-label="返回书库"]')?.click()`,
  );
  const libraryText = await waitForText(page.webSocketDebuggerUrl, "共 1 本 PDF 书籍");
  assert.match(libraryText, /读至第 1 页，共 3 页/, "the Library book card is incomplete");
  await dropSmokeFile(page.webSocketDebuggerUrl, fixturePath);
  await waitForText(page.webSocketDebuggerUrl, "AI 助手");
  const deduplicatedLibrary = await evaluate(page.webSocketDebuggerUrl, "window.pdfMuse.listLibraryBooks()");
  assert.equal(deduplicatedLibrary[0].id, populatedLibrary[0].id, "the content fingerprint changed for the same PDF");
  assert.equal(deduplicatedLibrary.length, 1, "opening the same PDF created a duplicate Library record");
  assert.equal(deduplicatedLibrary[0].currentPage, 1, "the initial recent page is invalid");
  await evaluate(
    page.webSocketDebuggerUrl,
    `document.querySelector('[aria-label="返回书库"]')?.click()`,
  );
  await waitForText(page.webSocketDebuggerUrl, "共 1 本 PDF 书籍");
  await dropSmokeFile(page.webSocketDebuggerUrl, damagedPdfPath);
  const damagedText = await waitForText(page.webSocketDebuggerUrl, "无法解析此 PDF 文件");
  assert.match(damagedText, /文件可能已损坏/, "the damaged PDF error is not shown in Chinese");
  const libraryAfterFailure = await evaluate(page.webSocketDebuggerUrl, "window.pdfMuse.listLibraryBooks()");
  assert.equal(libraryAfterFailure.length, 1, "a damaged PDF changed the Library");
  assert.equal(libraryAfterFailure[0].id, populatedLibrary[0].id, "a damaged PDF replaced the Library record");
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
  await evaluate(
    page.webSocketDebuggerUrl,
    `document.querySelector('[aria-label="关闭设置"]')?.click()`,
  );
  await evaluate(
    page.webSocketDebuggerUrl,
    `document.querySelector('[aria-label^="打开《"]')?.click()`,
  );
  await waitForText(page.webSocketDebuggerUrl, "PDFMuse Navigation Fixture");
  const expectedReadingState = await evaluate(
    page.webSocketDebuggerUrl,
    `new Promise((resolve, reject) => {
      const deadline = Date.now() + 1800;
      const applyReadingState = () => {
        const pagesReady = document.querySelector('.page-control span')?.textContent?.includes('3')
          && !document.querySelector('.viewer-loading');
        if (!pagesReady) {
          if (Date.now() >= deadline) return reject(new Error('PDF pages did not become ready'));
          setTimeout(applyReadingState, 50);
          return;
        }
        const zoom = document.querySelector('[aria-label="放大"]');
        zoom?.click();
        zoom?.click();
        zoom?.click();
        document.querySelector('[aria-label="收起目录"]')?.click();
        document.querySelector('[aria-label="收起 AI 助手"]')?.click();
        const container = document.querySelector('.pdf-container');
        container.scrollTop = Math.min(80, container.scrollHeight - container.clientHeight);
        container.dispatchEvent(new Event('scroll'));
        setTimeout(() => resolve({
          scrollTop: container.scrollTop,
          scale: Number(document.querySelector('.zoom-value')?.textContent?.replace('%', '')),
        }), 700);
      };
      applyReadingState();
    })`,
  );
  const savedReadingState = await evaluate(
    page.webSocketDebuggerUrl,
    `window.pdfMuse.openLibraryBook(${JSON.stringify(populatedLibrary[0].id)}).then(
      (result) => result.ok ? result.book.readingState : result
    )`,
  );
  assert.equal(savedReadingState.zoomMode, "custom", "custom zoom mode was not persisted");
  assert.equal(savedReadingState.zoomScale, expectedReadingState.scale, "custom zoom scale was not persisted");
  assert.equal(savedReadingState.scrollTop, expectedReadingState.scrollTop, "scroll position was not persisted");
  assert.equal(savedReadingState.leftSidebarOpen, false, "left sidebar state was not persisted");
  assert.equal(savedReadingState.rightSidebarOpen, false, "right sidebar state was not persisted");
  const secondPageScrollTop = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const container = document.querySelector('.pdf-container');
      return Math.min(1200, container.scrollHeight - container.clientHeight);
    })()`,
  );
  assert.equal(typeof secondPageScrollTop, "number", "the second PDF page has no scroll position");
  const secondPageCheckpoint = {
    ...savedReadingState,
    page: 2,
    scrollTop: secondPageScrollTop,
  };
  await evaluate(
    page.webSocketDebuggerUrl,
    `window.pdfMuse.updateLibraryBookState(
      ${JSON.stringify(populatedLibrary[0].id)},
      ${JSON.stringify(secondPageCheckpoint)}
    )`,
  );
  const confirmedPage = await evaluate(
    page.webSocketDebuggerUrl,
    `window.pdfMuse.openLibraryBook(${JSON.stringify(populatedLibrary[0].id)}).then(
      (result) => result.ok ? result.book.readingState.page : 0
    )`,
  );
  assert.equal(confirmedPage, 2, "a non-initial page checkpoint was not persisted through IPC");

  await stopElectron(child);
  port = await reservePort();
  child = launchElectron(port);
  page = await waitForPage(port);
  state = await waitForStartup(page.webSocketDebuggerUrl);
  assert.match(state.text, /PDFMuse Navigation Fixture/, "the most recent PDF was not reopened after restart");
  const restoredUi = await evaluate(
    page.webSocketDebuggerUrl,
    `new Promise((resolve) => setTimeout(() => resolve({
      scrollTop: document.querySelector('.pdf-container')?.scrollTop,
      page: Number(document.querySelector('[aria-label="当前页"]')?.value),
      scale: Number(document.querySelector('.zoom-value')?.textContent?.replace('%', '')),
      expandLeft: Boolean(document.querySelector('[aria-label="展开目录"]')),
      expandRight: Boolean(document.querySelector('[aria-label="展开 AI 助手"]')),
    }), 500))`,
  );
  assert.equal(restoredUi.page, 2, "the second page was not restored in the Viewer");
  assert.equal(restoredUi.scale, expectedReadingState.scale, "the zoom scale was not restored in the Viewer");
  assert.equal(restoredUi.scrollTop, secondPageCheckpoint.scrollTop, "the scroll position was not restored in the Viewer");
  assert.equal(restoredUi.expandLeft, true, "the collapsed left sidebar was not restored");
  assert.equal(restoredUi.expandRight, true, "the collapsed right sidebar was not restored");

  await stopElectron(child);
  await unlink(fixturePath);
  port = await reservePort();
  child = launchElectron(port);
  page = await waitForPage(port);
  state = await waitForStartup(page.webSocketDebuggerUrl);
  assert.match(state.text, /PDF 原文件暂时不可用/, "a missing recent PDF did not return to the Library");
  assert.match(state.text, /重新定位原文件/, "the missing PDF cannot be relocated from the Library");
  await dropSmokeFile(page.webSocketDebuggerUrl, encryptedFixturePath);
  const passwordText = await waitForText(page.webSocketDebuggerUrl, "打开加密 PDF");
  assert.match(passwordText, /记住这本书的密码/, "the encrypted PDF password controls are unavailable");
  assert.match(passwordText, /明文保存在 PDFMuse 便携数据目录/, "the plaintext password notice is unavailable");
  await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const input = document.querySelector('.password-dialog input[type="password"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'wrong');
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      input.form.requestSubmit();
    })()`,
  );
  const wrongPasswordText = await waitForText(page.webSocketDebuggerUrl, "密码错误，请重新输入");
  assert.match(wrongPasswordText, /密码错误/, "an incorrect PDF password has no feedback");
  const libraryAfterWrongPassword = await evaluate(page.webSocketDebuggerUrl, "window.pdfMuse.listLibraryBooks()");
  assert.equal(libraryAfterWrongPassword.length, 1, "an incorrect password created a Library record");
  await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const input = document.querySelector('.password-dialog input[type="password"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'muse-test');
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      document.querySelector('.remember-password input').click();
      input.form.requestSubmit();
    })()`,
  );
  const unlockedText = await waitForText(page.webSocketDebuggerUrl, "AI 助手");
  assert.match(unlockedText, /PDFMuse Navigation Fixture/, "the correct password did not open the encrypted PDF");

  await stopElectron(child);
  port = await reservePort();
  child = launchElectron(port);
  page = await waitForPage(port);
  state = await waitForStartup(page.webSocketDebuggerUrl);
  assert.match(state.text, /PDFMuse Navigation Fixture/, "a remembered password did not reopen the encrypted PDF");
  assert.doesNotMatch(state.text, /打开加密 PDF/, "a remembered password still requested manual entry");
  assert.equal(await evaluate(page.webSocketDebuggerUrl, "Boolean(document.querySelector('.workspace'))"), true, "the remembered encrypted PDF did not restore the reading workspace");
  console.log("Electron smoke test passed: Library, PDF controls, encrypted books, settings, and reading recovery are available.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (diagnostics.trim()) console.error(diagnostics.trim());
  process.exitCode = 1;
} finally {
  await stopElectron(child);
  await new Promise((resolve, reject) => {
    modelServer.close((error) => error ? reject(error) : resolve());
  });
  await Promise.all([
    rm(profile, { recursive: true, force: true }),
    rm(testApplicationDirectory, { recursive: true, force: true }),
  ]);
}
