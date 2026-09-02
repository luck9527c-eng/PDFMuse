import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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
        params: { expression, returnByValue: true },
      }));
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (message.error) reject(new Error(JSON.stringify(message.error)));
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

const projectRoot = path.resolve(import.meta.dirname, "..");
const electronExecutable = path.join(
  projectRoot,
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron",
);
const profile = await mkdtemp(path.join(os.tmpdir(), "pdfmuse-smoke-"));
const port = await reservePort();
const child = spawn(
  electronExecutable,
  [".", `--remote-debugging-port=${port}`, "--headless", "--disable-gpu", `--user-data-dir=${profile}`],
  {
    cwd: projectRoot,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true", VITE_DEV_SERVER_URL: "" },
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
  await rm(profile, { recursive: true, force: true });
}
