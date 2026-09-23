import { Worker } from "node:worker_threads";

import type { MineruPageData, MineruPageRequest } from "../shared/contracts.js";
import { createMineruPool, type MineruPoolSlot, type MineruPoolSlotHandlers } from "./mineru-pool.js";

export type MineruEngine = {
  name: string;
  model: string;
  version?: string;
  inputVersion?: string;
  /** 并发槽位数：整书任务按此决定在途上限；与后端绑定（torch=2，其余=1）。 */
  concurrency: number;
  recognizePage(input: MineruPageRequest, signal?: AbortSignal): Promise<MineruPageData>;
  /** 预建首个槽位并加载模型：打开含扫描页的书时后台调用，吸收首次识别的加载延迟。 */
  warmup?(): void;
  close?(): void;
};

export type WorkerMineruOptions = {
  command?: string;
  args?: string[];
  mineruHome?: string;
  /** 小模型推理后端：onnx（CPU 默认）或 torch（CUDA GPU）。透传 MINERU_MODEL_SMALL_BACKEND，并决定池大小。 */
  smallBackend?: "onnx" | "torch";
  model?: string;
  inputVersion?: string;
  engineVersion?: string;
};

/** 池大小与后端绑定，不做环境变量覆盖：torch/CUDA 双槽显存实测 4433MiB/6144MiB；onnx/CPU 算力即瓶颈，并发无收益（ADR 0013）。 */
export function mineruPoolSize(smallBackend?: "onnx" | "torch"): number {
  return smallBackend === "torch" ? 2 : 1;
}

/** 空闲回收：最后一次识别活动后计时，到期全部 worker 进程退场（T49 弹性驻留，ADR 0013 调整 ADR 0011 常驻形态）。 */
const MINERU_WORKER_IDLE_TIMEOUT_MS = 5 * 60_000;

export function createWorkerMineruEngine(options: WorkerMineruOptions = {}): MineruEngine {
  const size = mineruPoolSize(options.smallBackend);
  const pool = createMineruPool({
    size,
    idleTimeoutMs: MINERU_WORKER_IDLE_TIMEOUT_MS,
    createSlot: (handlers) => createThreadSlot(options, handlers),
  });
  return {
    name: "MinerU Worker",
    model: options.model ?? "待安装",
    inputVersion: options.inputVersion,
    version: options.engineVersion ?? "unknown",
    concurrency: size,
    recognizePage(input, signal) {
      return pool.dispatch(input, { priority: input.priority, signal });
    },
    warmup() {
      pool.warmup();
    },
    close() {
      pool.dispose();
    },
  };
}

function createThreadSlot(options: WorkerMineruOptions, handlers: MineruPoolSlotHandlers): MineruPoolSlot {
  let worker: Worker | undefined;
  let disposed = false;
  const ensure = (): Worker => {
    if (worker) return worker;
    const thread = new Worker(new URL("./mineru-worker.js", import.meta.url), {
      env: {
        ...process.env,
        ...(options.command ? { PDFMUSE_MINERU_COMMAND: options.command } : {}),
        ...(options.args ? { PDFMUSE_MINERU_ARGS: JSON.stringify(options.args) } : {}),
        ...(options.mineruHome ? { PDFMUSE_MINERU_HOME: options.mineruHome } : {}),
        ...(options.smallBackend ? { PDFMUSE_MINERU_SMALL_BACKEND: options.smallBackend } : {}),
      },
    });
    thread.on("message", (message: { id: string; ok: boolean; result?: MineruPageData; message?: string }) => {
      if (!message || typeof message.id !== "string" || typeof message.ok !== "boolean") return;
      if (message.ok && message.result) handlers.onResponse(message.id, { ok: true, result: message.result });
      else handlers.onResponse(message.id, { ok: false, message: message.message ?? "MinerU 工作进程不可用。" });
    });
    const down = (message: string) => {
      if (disposed) return;
      worker = undefined;
      handlers.onDown(message);
    };
    thread.on("error", () => down("MinerU 工作进程意外退出。"));
    thread.on("exit", (code) => {
      if (code !== 0) down("MinerU 工作进程意外退出。");
    });
    worker = thread;
    return thread;
  };
  return {
    send: (id, input) => {
      ensure().postMessage({ id, input });
    },
    cancel: (id) => {
      worker?.postMessage({ id, cancel: true });
    },
    warmup: () => {
      ensure().postMessage({ warmup: true });
    },
    dispose: () => {
      disposed = true;
      void worker?.terminate();
      worker = undefined;
    },
  };
}
