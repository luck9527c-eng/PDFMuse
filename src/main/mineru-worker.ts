import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";
import { parentPort } from "node:worker_threads";

import type { MineruPageRequest } from "../shared/contracts.js";
import { createMineruResponseRouter } from "./mineru-protocol.js";

export type MineruWorkerRequest =
  | { warmup: true }
  | { id: string; input: MineruPageRequest }
  | { id: string; cancel: true };

// 取消不杀 Python 进程：常驻模型重新加载代价太高，迟到的结果按取消丢弃即可。
if (parentPort) {
  const port = parentPort;
  const command = process.env.PDFMUSE_MINERU_COMMAND;
  const commandArgs = (() => {
    try {
      const parsed = JSON.parse(process.env.PDFMUSE_MINERU_ARGS ?? "[]") as unknown;
      return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
    } catch {
      return [];
    }
  })();
  const mineruHome = process.env.PDFMUSE_MINERU_HOME ?? "";
  const smallBackend = process.env.PDFMUSE_MINERU_SMALL_BACKEND ?? "";
  // 看门狗兜底：任何挂死的解析（第三方缺陷、CUDA 异常）超时后杀子进程重建，队列不再永久卡死。
  const timeoutMs = Number(process.env.PDFMUSE_MINERU_TIMEOUT_MS ?? 180_000) || 0;
  let child: ChildProcessByStdio<Writable, Readable, null> | undefined;
  const router = createMineruResponseRouter((response) => port.postMessage(response), {
    timeoutMs,
    onTimeout: () => stopBridge(),
  });

  function stopBridge() {
    if (child && !child.killed) child.kill();
    child = undefined;
  }

  function startBridge() {
    if (child && !child.killed) return child;
    if (!command) throw new Error("MinerU 工作进程资源尚未安装。");
    // stderr 必须丢弃：MinerU/tqdm/loguru 会持续写进度与 DEBUG 日志，管道缓冲写满后
    // 子进程阻塞在 stderr 写入上造成解析永久挂死（无人消费）。错误走 stdout JSON 协议。
    const processHandle = spawn(command, commandArgs, {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
        PYTHONDONTWRITEBYTECODE: "1",
        ...(mineruHome ? { MINERU_HOME: mineruHome } : {}),
        ...(smallBackend ? { MINERU_MODEL_SMALL_BACKEND: smallBackend } : {}),
      },
    });
    child = processHandle;
    const lines = createInterface({ input: processHandle.stdout });
    lines.on("line", (line) => router.handleLine(line));
    processHandle.once("error", () => {
      router.rejectAll("MinerU 工作进程无法启动。");
      child = undefined;
    });
    processHandle.once("close", () => {
      router.rejectAll("MinerU 工作进程意外退出。");
      child = undefined;
    });
    return processHandle;
  }

  port.on("message", (message: MineruWorkerRequest) => {
    if ("warmup" in message) {
      try { startBridge(); } catch { /* 启动预检会报告资源未安装。 */ }
      return;
    }
    if ("cancel" in message) {
      router.cancel(message.id);
      return;
    }
    try {
      const processHandle = startBridge();
      router.track(message.id);
      processHandle.stdin.write(`${JSON.stringify({ id: message.id, ...message.input })}\n`);
    } catch (error) {
      port.postMessage({
        id: message.id,
        ok: false,
        message: error instanceof Error ? error.message : "MinerU 工作进程不可用。",
      });
    }
  });
}
