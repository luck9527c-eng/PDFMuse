import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { parentPort } from "node:worker_threads";

import type { OcrPageRequest, RecognizedPageText } from "../shared/contracts.js";

export type OcrWorkerRequest = { id: string; input: OcrPageRequest } | { id: string; cancel: true };
export type OcrWorkerResponse =
  | { id: string; ok: true; result: Pick<RecognizedPageText, "width" | "height" | "orientation" | "lines"> }
  | { id: string; ok: false; message: string };

if (parentPort) {
  const port = parentPort;
  const command = process.env.PDFMUSE_OCR_COMMAND;
  const commandArgs = (() => {
    try {
      const parsed = JSON.parse(process.env.PDFMUSE_OCR_ARGS ?? "[]") as unknown;
      return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
    } catch {
      return [];
    }
  })();
  let child: ChildProcessWithoutNullStreams | undefined;
  const pending = new Set<string>();

  function stopBridge() {
    if (child && !child.killed) child.kill();
    child = undefined;
  }

  function startBridge() {
    if (child && !child.killed) return child;
    if (!command) throw new Error("OCR 工作进程资源尚未安装。");
    const processHandle = spawn(command, commandArgs, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    child = processHandle;
    const lines = createInterface({ input: processHandle.stdout });
    lines.on("line", (line) => {
      try {
        const response = JSON.parse(line) as OcrWorkerResponse;
        if (!response || typeof response.id !== "string" || typeof response.ok !== "boolean") return;
        pending.delete(response.id);
        port.postMessage(response);
      } catch {
        // 第三方运行时日志不能穿透协议；格式错误由进程退出统一收敛。
      }
    });
    processHandle.once("error", () => {
      for (const id of pending) port.postMessage({ id, ok: false, message: "OCR 工作进程无法启动。" } satisfies OcrWorkerResponse);
      pending.clear();
      child = undefined;
    });
    processHandle.once("close", () => {
      for (const id of pending) port.postMessage({ id, ok: false, message: "OCR 工作进程意外退出。" } satisfies OcrWorkerResponse);
      pending.clear();
      child = undefined;
    });
    return processHandle;
  }

  port.on("message", (message: OcrWorkerRequest) => {
    if ("cancel" in message) {
      pending.delete(message.id);
      stopBridge();
      return;
    }
    try {
      const processHandle = startBridge();
      pending.add(message.id);
      processHandle.stdin.write(`${JSON.stringify({ id: message.id, ...message.input })}\n`);
    } catch (error) {
      port.postMessage({
        id: message.id,
        ok: false,
        message: error instanceof Error ? error.message : "OCR 工作进程不可用。",
      } satisfies OcrWorkerResponse);
    }
  });
}
