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
    }, 10_000);

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
        text: document.body?.innerText ?? "",
        ready: Boolean(document.querySelector('.library-view, .workspace')),
      })`,
    );
    if (state.apiType === "object" && state.ready) return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return state;
}

async function waitForText(webSocketUrl, expected, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  let bodyText = "";
  while (Date.now() < deadline) {
    bodyText = await evaluate(webSocketUrl, "document.body?.innerText ?? ''");
    if (bodyText.includes(expected)) return bodyText;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return bodyText;
}

async function waitForSelector(webSocketUrl, selector, present = true) {
  return evaluate(
    webSocketUrl,
    `new Promise((resolve) => {
      const deadline = Date.now() + 3000;
      const inspect = () => {
        const found = Boolean(document.querySelector(${JSON.stringify(selector)}));
        if (found === ${present}) return resolve(found);
        if (Date.now() >= deadline) return resolve(found);
        setTimeout(inspect, 40);
      };
      inspect();
    })`,
  );
}

async function selectPdfText(webSocketUrl, startPage, startNeedle, endPage, endNeedle) {
  return evaluate(
    webSocketUrl,
    `(() => {
      const pageText = (pageNumber) => {
        const page = document.querySelector('.pdfViewer .page[data-page-number="' + pageNumber + '"]');
        if (!page) return undefined;
        const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        return { nodes, text: nodes.map((node) => node.textContent ?? '').join('') };
      };
      const locate = (nodes, index) => {
        let consumed = 0;
        for (const node of nodes) {
          const length = node.textContent?.length ?? 0;
          if (index <= consumed + length) return { node, offset: index - consumed };
          consumed += length;
        }
        return undefined;
      };
      const startPageText = pageText(${startPage});
      const endPageText = pageText(${endPage});
      if (!startPageText || !endPageText) return false;
      const startIndex = startPageText.text.indexOf(${JSON.stringify(startNeedle)});
      const endIndex = endPageText.text.lastIndexOf(${JSON.stringify(endNeedle)});
      if (startIndex < 0 || endIndex < 0) return false;
      const start = locate(startPageText.nodes, startIndex);
      const end = locate(endPageText.nodes, endIndex + ${JSON.stringify(endNeedle)}.length);
      if (!start || !end) return false;
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return true;
    })()`,
  );
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
const lifecycleFixturePath = path.join(testApplicationDirectory, "lifecycle-book.pdf");
await copyFile(path.join(projectRoot, "src", "main", "fixtures", "three-page.pdf"), lifecycleFixturePath);
const lifecycleSourceBefore = await readFile(lifecycleFixturePath);
const encryptedFixturePath = path.join(testApplicationDirectory, "encrypted-book.pdf");
await copyFile(path.join(projectRoot, "src", "main", "fixtures", "encrypted.pdf"), encryptedFixturePath);
let receivedModelRequest;
let receivedEmbeddingRequest;
let receivedAgentStreamRequest;
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
    if (request.url?.endsWith("/chat/completions") && receivedRequest.body.stream) {
      receivedAgentStreamRequest = receivedRequest;
      const messages = receivedRequest.body.messages ?? [];
      const hasToolResult = messages.some((message) => message.role === "tool");
      const lastUser = [...messages].reverse().find((message) => message.role === "user");
      const isToolQuestion = typeof lastUser?.content === "string" && lastUser.content.includes("第二章在哪");
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      let events;
      if (isToolQuestion && !hasToolResult) {
        // 第一轮：模型请求检索本书。
        events = [
          {
            id: "chatcmpl-tool",
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: "call-smoke-book",
                  type: "function",
                  function: { name: "search_book", arguments: JSON.stringify({ query: "Chapter Two" }) },
                }],
              },
            }],
          },
          { id: "chatcmpl-tool", choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        ];
      } else if (hasToolResult) {
        // 第二轮：模型基于工具结果回答并引用页码。
        events = [
          { id: "chatcmpl-tool", choices: [{ delta: { role: "assistant" } }] },
          { id: "chatcmpl-tool", choices: [{ delta: { content: "第二章从本书第 2 页开始，讲的是 Chapter Two。" } }] },
          { id: "chatcmpl-tool", choices: [{ delta: {}, finish_reason: "stop" }] },
        ];
      } else {
        const chunks = ["PDFMuse 冒烟", "流式回答", "已完成。"];
        events = [
          { id: "chatcmpl-agent", choices: [{ delta: { role: "assistant" } }] },
          ...chunks.map((content) => ({ id: "chatcmpl-agent", choices: [{ delta: { content } }] })),
          { id: "chatcmpl-agent", choices: [{ delta: {}, finish_reason: "stop" }] },
        ];
      }
      for (const event of events) {
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      response.end("data: [DONE]\n\n");
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
  const backgroundState = await evaluate(
    page.webSocketDebuggerUrl,
    `(async () => {
      const [book] = await window.pdfMuse.listLibraryBooks();
      const deadline = Date.now() + 2500;
      let jobs = [];
      while (Date.now() < deadline) {
        jobs = await window.pdfMuse.listBackgroundJobs(book.id);
        if (jobs.some((job) => job.kind === 'index') && jobs.some((job) => job.kind === 'outline')) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const unknownBookId = 'f'.repeat(64);
      return {
        jobs,
        unknownJobs: await window.pdfMuse.listBackgroundJobs(unknownBookId),
        unknownOutline: (await window.pdfMuse.getBookOutline(unknownBookId)) ?? null,
        unknownSchedule: await window.pdfMuse.scheduleBackgroundJob({ bookId: unknownBookId, kind: 'index' }),
      };
    })()`,
  );
  assert.equal(backgroundState.jobs.some((job) => job.kind === "index"), true, "opening a book did not schedule its background index");
  assert.equal(backgroundState.jobs.some((job) => job.kind === "outline"), true, "opening a book did not schedule outline recovery");
  assert.deepEqual(backgroundState.unknownJobs, [], "background jobs leaked across the Library boundary");
  assert.equal(backgroundState.unknownOutline, null, "a generated outline leaked across the Library boundary");
  assert.equal(backgroundState.unknownSchedule.ok, false, "an unknown book could schedule a background job");
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
        const firstPage = document.querySelector('.pdfViewer .page[data-page-number="1"]');
        const beforePageRect = firstPage.getBoundingClientRect();
        const pointerX = beforePageRect.left + beforePageRect.width * 0.72;
        const pointerY = beforePageRect.top + Math.min(beforePageRect.height * 0.3, 180);
        const beforeAnchor = {
          x: (pointerX - beforePageRect.left) / beforePageRect.width,
          y: (pointerY - beforePageRect.top) / beforePageRect.height,
        };
        const initialScale = Number(document.querySelector('.zoom-value')?.textContent?.replace('%', ''));
        container.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaY: -120,
          clientX: pointerX,
          clientY: pointerY,
        }));
        setTimeout(() => {
          const afterPageRect = firstPage.getBoundingClientRect();
          const afterAnchor = {
            x: (pointerX - afterPageRect.left) / afterPageRect.width,
            y: (pointerY - afterPageRect.top) / afterPageRect.height,
          };
          resolve({
            initialScale,
            scale: Number(document.querySelector('.zoom-value')?.textContent?.replace('%', '')),
            anchorDrift: Math.max(
              Math.abs(afterAnchor.x - beforeAnchor.x),
              Math.abs(afterAnchor.y - beforeAnchor.y),
            ),
            anchorProbe: {
              beforeAnchor,
              afterAnchor,
              beforePage: { left: beforePageRect.left, top: beforePageRect.top, width: beforePageRect.width, height: beforePageRect.height },
              afterPage: { left: afterPageRect.left, top: afterPageRect.top, width: afterPageRect.width, height: afterPageRect.height },
              scrollLeft: container.scrollLeft,
              scrollTop: container.scrollTop,
              scrollWidth: container.scrollWidth,
              clientWidth: container.clientWidth,
            },
          });
        }, 180);
      };
      inspect();
    })`,
  );
  assert.ok(readerControls.scale > readerControls.initialScale, "Ctrl+mouse wheel did not zoom the PDF");
  assert.ok(readerControls.anchorDrift < 0.02, `Ctrl+mouse wheel anchor probe: ${JSON.stringify(readerControls.anchorProbe)}`);
  const panning = await evaluate(
    page.webSocketDebuggerUrl,
    `new Promise((resolve) => {
      document.querySelector('[aria-label="开启拖拽浏览"]')?.click();
      setTimeout(() => {
        const container = document.querySelector('.pdf-container');
        const before = container.scrollTop;
        container.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 7, clientX: 420, clientY: 360 }));
        container.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, pointerId: 7, clientX: 420, clientY: 300 }));
        container.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 7, clientX: 420, clientY: 300 }));
        resolve({ before, after: container.scrollTop, active: container.classList.contains('is-panning') });
      }, 50);
    })`,
  );
  assert.ok(panning.after >= panning.before + 50, "drag-to-pan did not move the PDF viewport");
  assert.equal(panning.active, false, "drag-to-pan remained active after pointer release");
  await evaluate(page.webSocketDebuggerUrl, `document.querySelector('[aria-label="关闭拖拽浏览"]')?.click()`);
  const resizedSidebars = await evaluate(
    page.webSocketDebuggerUrl,
    `new Promise((resolve) => {
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
          initialLeftWidth,
          initialRightWidth,
          leftWidth: document.querySelector('.left-sidebar').getBoundingClientRect().width,
          rightWidth: document.querySelector('.assistant-panel').getBoundingClientRect().width,
          toolbarContained: toolbar.left >= reader.left && toolbar.right <= reader.right,
        });
      }, 100);
    })`,
  );
  assert.ok(resizedSidebars.leftWidth < resizedSidebars.initialLeftWidth, "the left sidebar resize handle did not change its width");
  assert.ok(resizedSidebars.rightWidth < resizedSidebars.initialRightWidth, "the right sidebar resize handle did not change its width");
  assert.equal(resizedSidebars.toolbarContained, true, "resizing a sidebar pushed the PDF toolbar outside the reader");
  await evaluate(page.webSocketDebuggerUrl, `document.querySelector('.sidebar-tabs button:nth-child(2)')?.click()`);
  const thumbnails = await evaluate(
    page.webSocketDebuggerUrl,
    `new Promise((resolve) => setTimeout(() => resolve({
      count: document.querySelectorAll('.pdf-thumbnail').length,
      rendered: document.querySelectorAll('.pdf-thumbnail img').length,
    }), 500))`,
  );
  assert.equal(thumbnails.count, 3, "page thumbnail navigation is incomplete");
  assert.ok(thumbnails.rendered >= 1, "visible page thumbnails were not rendered");
  await evaluate(page.webSocketDebuggerUrl, `document.querySelector('.sidebar-tabs button:first-child')?.click()`);
  assert.equal(
    await selectPdfText(page.webSocketDebuggerUrl, 1, "Chapter One", 1, "PDFMuse search target."),
    true,
    "the fixed PDF text could not be selected",
  );
  assert.equal(await waitForSelector(page.webSocketDebuggerUrl, ".selection-popover"), true, "a same-page cross-paragraph selection has no actions");
  const selectionActions = await evaluate(
    page.webSocketDebuggerUrl,
    `Array.from(document.querySelectorAll('.selection-popover button')).map((button) => button.textContent)`,
  );
  assert.deepEqual(selectionActions, ["解释", "提问", "复制"], "Selected Passage actions are inconsistent");
  await evaluate(page.webSocketDebuggerUrl, `document.querySelector('.selection-popover button:nth-child(2)')?.click()`);
  const attachedPassageText = await waitForText(page.webSocketDebuggerUrl, "已选原文 · 第 1 页");
  assert.match(attachedPassageText, /Chapter One/, "asking did not retain the Selected Passage text");
  await evaluate(page.webSocketDebuggerUrl, `document.querySelector('[aria-label="移除已选原文"]')?.click()`);

  await selectPdfText(page.webSocketDebuggerUrl, 1, "Chapter One", 1, "PDFMuse search target.");
  assert.equal(await waitForSelector(page.webSocketDebuggerUrl, ".selection-popover"), true, "Selected Passage actions did not reopen");
  await evaluate(page.webSocketDebuggerUrl, `document.querySelector('.selection-popover button:last-child')?.click()`);
  const copiedText = await waitForText(page.webSocketDebuggerUrl, "已复制选中原文");
  assert.match(copiedText, /已复制选中原文/, "successful copy has no feedback");

  await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      window.__pdfMuseClipboardWrite = Object.getOwnPropertyDescriptor(navigator.clipboard, 'writeText');
      Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: () => Promise.reject(new Error('smoke failure')) });
    })()`,
  );
  await selectPdfText(page.webSocketDebuggerUrl, 1, "Chapter One", 1, "PDFMuse search target.");
  assert.equal(await waitForSelector(page.webSocketDebuggerUrl, ".selection-popover"), true, "Selected Passage actions did not reopen for copy failure");
  await evaluate(page.webSocketDebuggerUrl, `document.querySelector('.selection-popover button:last-child')?.click()`);
  const copyFailureText = await waitForText(page.webSocketDebuggerUrl, "复制失败");
  assert.match(copyFailureText, /检查系统剪贴板权限/, "failed copy has no understandable feedback");
  await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const descriptor = window.__pdfMuseClipboardWrite;
      if (descriptor) Object.defineProperty(navigator.clipboard, 'writeText', descriptor);
      else delete navigator.clipboard.writeText;
      delete window.__pdfMuseClipboardWrite;
    })()`,
  );

  assert.equal(
    await selectPdfText(page.webSocketDebuggerUrl, 1, "Chapter One", 2, "Chapter Two"),
    true,
    "the cross-page selection fixture is unavailable",
  );
  const crossPageText = await waitForText(page.webSocketDebuggerUrl, "暂不支持跨页选择");
  assert.match(crossPageText, /同一页内重新选择/, "cross-page selection is not explicitly limited");
  assert.equal(await waitForSelector(page.webSocketDebuggerUrl, ".selection-popover", false), false, "cross-page selection exposed passage actions");

  await selectPdfText(page.webSocketDebuggerUrl, 1, "Chapter One", 1, "PDFMuse search target.");
  assert.equal(await waitForSelector(page.webSocketDebuggerUrl, ".selection-popover"), true, "Selected Passage actions did not reopen before scrolling");
  await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const container = document.querySelector('.pdf-container');
      container.scrollTop += 12;
      container.dispatchEvent(new Event('scroll'));
    })()`,
  );
  assert.equal(await waitForSelector(page.webSocketDebuggerUrl, ".selection-popover", false), false, "scrolling did not dismiss Selected Passage actions");
  await selectPdfText(page.webSocketDebuggerUrl, 1, "Chapter One", 1, "PDFMuse search target.");
  assert.equal(await waitForSelector(page.webSocketDebuggerUrl, ".selection-popover"), true, "Selected Passage actions did not reopen before cancellation");
  await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      window.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
    })()`,
  );
  assert.equal(await waitForSelector(page.webSocketDebuggerUrl, ".selection-popover", false), false, "cancelling the selection did not dismiss its actions");
  await selectPdfText(page.webSocketDebuggerUrl, 1, "Chapter One", 1, "PDFMuse search target.");
  assert.equal(await waitForSelector(page.webSocketDebuggerUrl, ".selection-popover"), true, "Selected Passage actions did not reopen before leaving the book");
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
  assert.equal(await waitForSelector(page.webSocketDebuggerUrl, ".selection-popover", false), false, "leaving the PDF Book did not dismiss Selected Passage actions");
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
  assert.equal(modelConnection.contextWindow, 1048576, "context window does not fall back to the default tier");
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
      max_tokens: 16,
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
    `document.querySelector('[aria-label="设置"]')?.click()`,
  );
  const settingsText = await waitForText(page.webSocketDebuggerUrl, "保存配置");
  assert.match(settingsText, /测试连接/, "model connection test command is unavailable");
  assert.match(settingsText, /接口协议/, "model protocol selector is unavailable");
  assert.match(settingsText, /上下文窗口/, "context window selector is unavailable");
  assert.match(settingsText, /API 密钥/, "API key editor is unavailable");
  assert.match(settingsText, /测试嵌入连接/, "embedding connection test command is unavailable");
  assert.match(settingsText, /保存嵌入配置/, "embedding connection save command is unavailable");
  assert.match(settingsText, /尚未安装 OCR 工作进程资源/, "startup warnings are unavailable in settings");
  const protocolOptions = await evaluate(
    page.webSocketDebuggerUrl,
    `Array.from(document.querySelectorAll('select option')).map((option) => option.textContent)`,
  );
  assert.deepEqual(
    protocolOptions,
    [
      // 厂商预设选择器（自定义 + MODEL_PROVIDER_PRESETS）
      "自定义",
      "DeepSeek",
      "Moonshot Kimi",
      "智谱 GLM",
      "OpenAI",
      "Anthropic",
      // 协议选择器
      "OpenAI",
      "Anthropic",
      // 上下文窗口档位
      "256K tokens",
      "1M tokens",
    ],
    "model protocol and context window options are incomplete",
  );
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

  // Book Conversation：从 Renderer 发起问题，验证流式回答与持久化。
  // 阅读状态场景收起过 AI 助手，先展开再走真实输入路径。
  await evaluate(
    page.webSocketDebuggerUrl,
    `document.querySelector('[aria-label="展开 AI 助手"]')?.click()`,
  );
  const savedProfile = await evaluate(
    page.webSocketDebuggerUrl,
    `window.pdfMuse.saveReaderProfile(${JSON.stringify({ content: "我是冒烟测试读者，偏好先给结论。" })})`,
  );
  assert.equal(savedProfile.ok, true, "the reader profile could not be saved through IPC");
  const agentAskStarted = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
    const textarea = document.querySelector('.composer textarea');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, "冒烟测试问题：第一章讲了什么？");
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    setTimeout(() => document.querySelector('[aria-label="发送问题"]')?.click(), 40);
    return true;
  })()`,
  );
  assert.equal(agentAskStarted, true, "the agent question could not be typed into the composer");
  // 先等 Main 侧完成持久化，再验证 UI（问题文本在终态刷新后才上屏）。
  let persistedConversation = [];
  const persistenceDeadline = Date.now() + 8_000;
  while (Date.now() < persistenceDeadline) {
    persistedConversation = await evaluate(
      page.webSocketDebuggerUrl,
      `window.pdfMuse.getBookConversation(${JSON.stringify(populatedLibrary[0].id)})`,
    );
    if (persistedConversation.length === 2 && persistedConversation[1]?.status === "complete") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const agentAnswerText = await waitForText(page.webSocketDebuggerUrl, "冒烟测试问题");
  assert.equal(persistedConversation.length, 2, "the persisted Book Conversation is incomplete");
  assert.equal(persistedConversation[0].role, "reader", "the persisted conversation does not start with the reader");
  assert.equal(persistedConversation[1].status, "complete", "the persisted assistant message is not complete");
  assert.equal(persistedConversation[1].body, "PDFMuse 冒烟流式回答已完成。", "the persisted assistant body is invalid");
  assert.equal(typeof receivedAgentStreamRequest, "object", "the agent run did not reach the local model server");
  assert.equal(receivedAgentStreamRequest.authorization, "Bearer smoke-secret", "the agent run did not use the saved API key");
  assert.equal(receivedAgentStreamRequest.body.stream, true, "the agent run did not request a streaming completion");
  const systemMessage = receivedAgentStreamRequest.body.messages.find((message) => message.role === "system");
  assert.match(systemMessage?.content ?? "", /我是冒烟测试读者，偏好先给结论。/, "the reader profile was not injected into the system prompt");

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
  const restoredConversation = await evaluate(
    page.webSocketDebuggerUrl,
    `window.pdfMuse.getBookConversation(${JSON.stringify(populatedLibrary[0].id)})`,
  );
  assert.equal(restoredConversation.length, 2, "the Book Conversation did not survive the restart");
  assert.equal(restoredConversation[1].body, "PDFMuse 冒烟流式回答已完成。", "the persisted assistant answer changed after restart");
  // 重启后右侧栏按保存状态折叠，先展开助手面板再验证会话渲染。
  await evaluate(page.webSocketDebuggerUrl, `document.querySelector('[aria-label="展开 AI 助手"]')?.click()`);
  const restoredConversationText = await waitForText(page.webSocketDebuggerUrl, "PDFMuse 冒烟流式回答已完成。");
  assert.match(restoredConversationText, /冒烟测试问题/, "the restored conversation is not rendered in the assistant panel");

  // search_book 工具续轮：问题触发检索，回答带可点击的本书页码 Evidence。
  const toolAskStarted = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
    const textarea = document.querySelector('.composer textarea');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, "第二章在哪一章？");
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    setTimeout(() => document.querySelector('[aria-label="发送问题"]')?.click(), 40);
    return true;
  })()`,
  );
  assert.equal(toolAskStarted, true, "the search_book question could not be typed into the composer");
  const toolAnswerText = await waitForText(page.webSocketDebuggerUrl, "第二章从本书第 2 页开始", 15_000);
  assert.match(toolAnswerText, /本书第 2 页/, "the clickable book evidence page tag is unavailable");
  const toolConversation = await evaluate(
    page.webSocketDebuggerUrl,
    `window.pdfMuse.getBookConversation(${JSON.stringify(populatedLibrary[0].id)})`,
  );
  const toolAnswer = toolConversation.at(-1);
  assert.equal(toolAnswer.status, "complete", "the tool-assisted answer is not complete");
  // 证据按页码升序持久化（每页最优、上限 8 条），第 2 页的证据不一定是首条。
  const pageTwoEvidence = toolAnswer.evidence?.find((item) => item.page === 2);
  assert.equal(
    pageTwoEvidence?.source,
    "pdf",
    `pdf evidence for page 2 was not persisted: ${JSON.stringify(toolAnswer.evidence)}`,
  );
  assert.match(
    pageTwoEvidence?.snippet ?? "",
    /Chapter Two/,
    `the persisted evidence snippet is invalid: ${JSON.stringify(toolAnswer.evidence)}`,
  );

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

  await evaluate(page.webSocketDebuggerUrl, `document.querySelector('[aria-label="返回书库"]')?.click()`);
  await waitForText(page.webSocketDebuggerUrl, "书库");
  await dropSmokeFile(page.webSocketDebuggerUrl, lifecycleFixturePath);
  await waitForText(page.webSocketDebuggerUrl, "AI 助手");
  const lifecycleBook = await evaluate(
    page.webSocketDebuggerUrl,
    `window.pdfMuse.listLibraryBooks().then((books) => books.find((book) => book.path === ${JSON.stringify(lifecycleFixturePath)}))`,
  );
  assert.match(lifecycleBook.id, /^[a-f0-9]{64}$/, "the lifecycle fixture was not added by content identity");
  const lifecycleManageLabel = JSON.stringify(`管理《${lifecycleBook.title}》`);
  await evaluate(page.webSocketDebuggerUrl, `document.querySelector('[aria-label="返回书库"]')?.click()`);
  await waitForText(page.webSocketDebuggerUrl, "书库");
  await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const label = ${lifecycleManageLabel};
      [...document.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === label)?.click();
    })()`,
  );
  const manageText = await waitForText(page.webSocketDebuggerUrl, "移出书库");
  assert.match(manageText, /两种操作都不会修改或删除 PDF 原文件/, "the Library actions do not explain source-file safety");
  await evaluate(
    page.webSocketDebuggerUrl,
    `(() => [...document.querySelectorAll('.library-manage-dialog button')].find((button) => button.textContent.trim() === '移出')?.click())()`,
  );
  await waitForText(page.webSocketDebuggerUrl, "书库");
  const removedLibrary = await evaluate(page.webSocketDebuggerUrl, "window.pdfMuse.listLibraryBooks()");
  assert.equal(removedLibrary.some((book) => book.id === lifecycleBook.id), false, "removing a book left it visible in the Library");

  await dropSmokeFile(page.webSocketDebuggerUrl, lifecycleFixturePath);
  await waitForText(page.webSocketDebuggerUrl, "AI 助手");
  const restoredLifecycleBook = await evaluate(
    page.webSocketDebuggerUrl,
    `window.pdfMuse.listLibraryBooks().then((books) => books.find((book) => book.path === ${JSON.stringify(lifecycleFixturePath)}))`,
  );
  assert.equal(restoredLifecycleBook.id, lifecycleBook.id, "reopening a removed book did not restore the same content identity");
  await evaluate(page.webSocketDebuggerUrl, `document.querySelector('[aria-label="返回书库"]')?.click()`);
  await waitForText(page.webSocketDebuggerUrl, "书库");
  await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const label = ${lifecycleManageLabel};
      [...document.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === label)?.click();
    })()`,
  );
  await waitForText(page.webSocketDebuggerUrl, "删除本书数据");
  await evaluate(
    page.webSocketDebuggerUrl,
    `(() => [...document.querySelectorAll('.library-manage-dialog button')].find((button) => button.textContent.trim() === '删除数据')?.click())()`,
  );
  const confirmDeleteText = await waitForText(page.webSocketDebuggerUrl, "永久删除本书数据");
  assert.match(confirmDeleteText, /此操作无法撤销/, "deleting book data did not require explicit confirmation");
  await evaluate(
    page.webSocketDebuggerUrl,
    `(() => [...document.querySelectorAll('.library-manage-dialog button')].find((button) => button.textContent.includes('永久删除本书数据'))?.click())()`,
  );
  await waitForText(page.webSocketDebuggerUrl, "书库");
  const deletedLibrary = await evaluate(page.webSocketDebuggerUrl, "window.pdfMuse.listLibraryBooks()");
  assert.equal(deletedLibrary.some((book) => book.id === lifecycleBook.id), false, "deleting book data left the Library record behind");
  assert.deepEqual(await readFile(lifecycleFixturePath), lifecycleSourceBefore, "deleting product data changed the PDF source file");

  console.log("Electron smoke test passed: Library lifecycle, PDF controls, Selected Passage, encrypted books, settings, and reading recovery are available.");
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
