import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";

import type { MineruPageData, MineruPageRequest } from "../shared/contracts.js";

export type MineruEngine = {
  name: string;
  model: string;
  version?: string;
  inputVersion?: string;
  recognizePage(input: MineruPageRequest, signal?: AbortSignal): Promise<MineruPageData>;
  close?(): void;
};

export type WorkerMineruOptions = {
  command?: string;
  args?: string[];
  mineruHome?: string;
  /** 小模型推理后端：onnx（CPU 默认）或 torch（CUDA GPU）。透传 MINERU_MODEL_SMALL_BACKEND。 */
  smallBackend?: string;
  model?: string;
  inputVersion?: string;
  engineVersion?: string;
};

export function createWorkerMineruEngine(options: WorkerMineruOptions = {}): MineruEngine {
  const worker = new Worker(new URL("./mineru-worker.js", import.meta.url), {
    env: {
      ...process.env,
      ...(options.command ? { PDFMUSE_MINERU_COMMAND: options.command } : {}),
      ...(options.args ? { PDFMUSE_MINERU_ARGS: JSON.stringify(options.args) } : {}),
      ...(options.mineruHome ? { PDFMUSE_MINERU_HOME: options.mineruHome } : {}),
      ...(options.smallBackend ? { PDFMUSE_MINERU_SMALL_BACKEND: options.smallBackend } : {}),
    },
  });
  const pending = new Map<string, { resolve: (value: MineruPageData) => void; reject: (error: Error) => void; cleanup(): void }>();
  worker.on("message", (message: { id: string; ok: boolean; result?: MineruPageData; message?: string }) => {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    request.cleanup();
    if (message.ok && message.result) request.resolve(message.result);
    else request.reject(new Error(message.message ?? "MinerU 工作进程不可用。"));
  });
  worker.on("error", (error) => {
    for (const request of pending.values()) request.reject(error instanceof Error ? error : new Error(String(error)));
    pending.clear();
  });
  worker.postMessage({ warmup: true });
  return {
    name: "MinerU Worker",
    model: options.model ?? "待安装",
    inputVersion: options.inputVersion,
    version: options.engineVersion ?? "unknown",
    recognizePage(input, signal) {
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const onAbort = () => {
          pending.delete(id);
          worker.postMessage({ id, cancel: true });
          reject(new Error("识别已取消。"));
        };
        pending.set(id, { resolve, reject, cleanup: () => signal?.removeEventListener("abort", onAbort) });
        signal?.addEventListener("abort", onAbort, { once: true });
        worker.postMessage({ id, input });
      });
    },
    close() {
      void worker.terminate();
    },
  };
}
