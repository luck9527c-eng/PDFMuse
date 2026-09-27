import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBackgroundJobModule, type BackgroundJobModule, type JobExecutor } from "./background-jobs.js";

const BOOK_A = "a".repeat(64);
const BOOK_B = "b".repeat(64);
const BOOK_C = "c".repeat(64);

async function waitFor(condition: () => boolean, timeout = 1_000) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeout) throw new Error("等待后台任务状态超时。");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("background jobs", () => {
  let dataHome: string;
  let module: BackgroundJobModule | undefined;

  beforeEach(async () => {
    dataHome = await mkdtemp(path.join(os.tmpdir(), "pdfmuse-background-jobs-"));
  });

  afterEach(async () => {
    module?.close();
    module = undefined;
    await rm(dataHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("executes higher priority jobs first and deduplicates active jobs", async () => {
    const order: string[] = [];
    let releaseBlocker: (() => void) | undefined;
    const executor: JobExecutor = async (job) => {
      order.push(job.bookId);
      if (job.bookId === BOOK_C) await new Promise<void>((resolve) => { releaseBlocker = resolve; });
    };
    module = createBackgroundJobModule(dataHome, { index: executor });
    module.schedule({ bookId: BOOK_C, kind: "index", priority: 0 });
    await waitFor(() => module?.list(BOOK_C)[0]?.status === "running");
    const low = module.schedule({ bookId: BOOK_A, kind: "index", priority: 1 });
    expect(low.ok).toBe(true);
    const duplicate = module.schedule({ bookId: BOOK_A, kind: "index", priority: 100 });
    expect(duplicate).toMatchObject({ ok: true, job: { id: low.ok ? low.job.id : "" } });
    const high = module.schedule({ bookId: BOOK_B, kind: "index", priority: 10 });
    expect(high.ok).toBe(true);
    releaseBlocker?.();
    await waitFor(() => module?.list().every((job) => job.status === "completed") ?? false);
    expect(order).toEqual([BOOK_C, BOOK_B, BOOK_A]);
    expect(module.list(BOOK_A)).toHaveLength(1);
  });

  it("stores an opaque initial checkpoint on the scheduled job", () => {
    module = createBackgroundJobModule(dataHome);
    const scheduled = module.schedule({ bookId: BOOK_A, kind: "ocr", checkpoint: "ocr-order:6:12" });
    expect(scheduled).toMatchObject({ ok: true, job: { checkpoint: "ocr-order:6:12" } });  });

  it("启动恢复的泵推迟到初始化之后：回调不会同步打进装配根死区", async () => {
    // 先建库并预置一条 queued 任务，模拟上次进程被杀留下的可恢复工作。
    const bootstrap = createBackgroundJobModule(dataHome);
    bootstrap.close();
    const raw = new DatabaseSync(path.join(dataHome, "pdfmuse.db"));
    raw.prepare(`
      INSERT INTO background_jobs (id, book_id, kind, priority, status, created_at, updated_at)
      VALUES ('job-recover', ?, 'index', 10, 'queued', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z')
    `).run(BOOK_A);
    raw.close();

    const notified: string[] = [];
    let executions = 0;
    module = createBackgroundJobModule(dataHome, {
      index: async () => { executions += 1; },
    }, (bookId) => notified.push(bookId));

    // 修复点：构造返回时恢复泵尚未运行，通知回调与执行器都没有同步触发。
    expect(executions).toBe(0);
    expect(notified).toEqual([]);
    // 推迟到下一 tick 后，恢复照常完成：任务被执行、通知照发。
    await waitFor(() => executions === 1);
    await waitFor(() => module?.list(BOOK_A)[0]?.status === "completed");
    expect(notified).toContain(BOOK_A);
  });

  it("notifies job changes per book for push delivery", async () => {
    const notified: string[] = [];
    module = createBackgroundJobModule(
      dataHome,
      { index: async (_job, context) => { context.checkpoint("page:1", 1, 2); } },
      (bookId) => notified.push(bookId),
    );
    module.schedule({ bookId: BOOK_A, kind: "index", total: 2 });
    await waitFor(() => module?.list(BOOK_A)[0]?.status === "completed");
    module.schedule({ bookId: BOOK_B, kind: "index" });
    await waitFor(() => module?.list(BOOK_B)[0]?.status === "completed");
    // 入队、运行、检查点、完成各阶段都要通知，渲染层才能以推送替代轮询。
    expect(notified.filter((bookId) => bookId === BOOK_A).length).toBeGreaterThanOrEqual(3);
    expect(notified).toContain(BOOK_B);
  });

  it("persists checkpoint and resumes a paused job", async () => {
    let runs = 0;
    let resolvePause: (() => void) | undefined;
    const executor: JobExecutor = async (job, context) => {
      runs += 1;
      context.checkpoint("page:2", 2, 5);
      if (runs === 1) {
        await new Promise<void>((resolve) => {
          resolvePause = resolve;
          context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        if (context.signal.aborted) throw new Error("任务已暂停。");
      }
      expect(job.checkpoint).toBe(runs === 1 ? undefined : "page:2");
    };
    module = createBackgroundJobModule(dataHome, { ocr: executor });
    const scheduled = module.schedule({ bookId: BOOK_A, kind: "ocr", total: 5 });
    if (!scheduled.ok) throw new Error("任务未创建。");
    await waitFor(() => module?.list()[0]?.status === "running");
    const paused = module.pause(scheduled.job.id);
    expect(paused).toMatchObject({ ok: true, job: { status: "paused", progress: 2, checkpoint: "page:2" } });
    resolvePause?.();
    const resumed = module.resume(scheduled.job.id);
    expect(resumed).toMatchObject({ ok: true, job: { status: "queued", checkpoint: "page:2" } });
    await waitFor(() => module?.list()[0]?.status === "completed");
    expect(runs).toBe(2);
  });

  it("cancels running jobs and hides executor errors behind a Chinese diagnostic", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const executor: JobExecutor = async (job, context) => {
      if (job.bookId === BOOK_B) throw new Error("provider request failed");
      await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
      throw new Error("模拟失败");
    };
    module = createBackgroundJobModule(dataHome, { embedding: executor });
    const scheduled = module.schedule({ bookId: BOOK_A, kind: "embedding" });
    if (!scheduled.ok) throw new Error("任务未创建。");
    await waitFor(() => module?.list()[0]?.status === "running");
    expect(module.cancel(scheduled.job.id)).toMatchObject({ ok: true, job: { status: "cancelled" } });
    await waitFor(() => module?.list()[0]?.status === "cancelled");

    const replacement = module.schedule({ bookId: BOOK_A, kind: "embedding" });
    if (!replacement.ok) throw new Error("替代任务未创建。");
    expect(replacement.job.id).not.toBe(scheduled.job.id);
    await waitFor(() => module?.get(replacement.job.id)?.status === "running");
    module.cancel(replacement.job.id);

    const failed = module.schedule({ bookId: BOOK_B, kind: "embedding" });
    if (!failed.ok) throw new Error("任务未创建。");
    await waitFor(() => module?.list().find((job) => job.id === failed.job.id)?.status === "failed");
    expect(module.list(BOOK_B)[0]).toMatchObject({
      status: "failed",
      errorMessage: "语义索引任务失败，当前继续使用全文检索。",
    });
    expect(errorLog).toHaveBeenCalledWith("后台任务执行失败：embedding", expect.any(Error));
    expect(module.clearFailed("embedding")).toBe(1);
    expect(module.list(BOOK_B)).toEqual([]);
  });

  it("restores running jobs to queued after restart", async () => {
    module = createBackgroundJobModule(dataHome, {
      index: async (_job, context) => {
        await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => setTimeout(resolve, 20), { once: true }));
      },
    });
    const scheduled = module.schedule({ bookId: BOOK_A, kind: "index" });
    if (!scheduled.ok) throw new Error("任务未创建。");
    await waitFor(() => module?.list(BOOK_A)[0]?.status === "running");
    module.close();
    module = createBackgroundJobModule(dataHome, { index: async () => undefined });
    await waitFor(() => module?.list(BOOK_A)[0]?.status === "completed");
    expect(module.list(BOOK_A)[0]).toMatchObject({ id: scheduled.job.id, status: "completed", attempts: 2 });
  });

  it("cancels every job for a book and waits for the running executor to settle", async () => {
    let executorSettled = false;
    module = createBackgroundJobModule(dataHome, {
      outline: async (_job, context) => {
        await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => setTimeout(resolve, 20), { once: true }));
        executorSettled = true;
        throw new Error("cancelled");
      },
    });
    module.schedule({ bookId: BOOK_A, kind: "outline" });
    module.schedule({ bookId: BOOK_A, kind: "index" });
    await waitFor(() => module?.list(BOOK_A).some((job) => job.status === "running") ?? false);

    await module.cancelBook(BOOK_A);

    expect(executorSettled).toBe(true);
    expect(module.list(BOOK_A).every((job) => job.status === "cancelled")).toBe(true);
  });

  it("fails unsupported task types with a Chinese diagnostic", async () => {
    module = createBackgroundJobModule(dataHome);
    const scheduled = module.schedule({ bookId: BOOK_A, kind: "ocr" });
    if (!scheduled.ok) throw new Error("任务未创建。");
    await waitFor(() => module?.list(BOOK_A)[0]?.status === "failed");
    expect(module.list(BOOK_A)[0]).toMatchObject({
      status: "failed",
      errorMessage: "当前任务类型尚未配置执行器。",
    });
  });

  it("automatically retries transient failures up to the configured attempt limit", async () => {
    let runs = 0;
    module = createBackgroundJobModule(dataHome, {
      ocr: async () => {
        runs += 1;
        if (runs < 3) throw new Error("temporary");
      },
    });
    const scheduled = module.schedule({ bookId: BOOK_A, kind: "ocr", maxAttempts: 3, inputVersion: "ocr-v1" });
    if (!scheduled.ok) throw new Error("任务未创建。");
    await waitFor(() => module?.get(scheduled.job.id)?.status === "completed");
    expect(module.get(scheduled.job.id)).toMatchObject({ attempts: 3, maxAttempts: 3, inputVersion: "ocr-v1" });
  });

  it("deleteBookData 在给定连接上清掉本书任务且不影响他书", async () => {
    module = createBackgroundJobModule(dataHome, { index: async () => undefined });
    module.schedule({ bookId: BOOK_A, kind: "index" });
    module.schedule({ bookId: BOOK_B, kind: "index" });

    const connection = new DatabaseSync(path.join(dataHome, "pdfmuse.db"));
    module.deleteBookData(BOOK_A, connection);
    connection.close();

    expect(module.list(BOOK_A)).toEqual([]);
    expect(module.list(BOOK_B)).toHaveLength(1);
  });

  it("lets a running job yield to queued jobs and auto-resumes when the queue idles", async () => {
    const events: string[] = [];
    let yielded = false;
    module = createBackgroundJobModule(dataHome, {
      ocr: async (_job, context) => {
        events.push("ocr:start");
        const aborted = new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        if (!yielded) {
          yielded = true;
          context.yieldOnce();
        }
        if (context.signal.aborted) {
          await aborted;
          throw new Error("OCR 任务已暂停或取消。");
        }
        events.push("ocr:done");
      },
      outline: async () => {
        events.push("outline:done");
      },
    });
    // 真实时序：开书即同时排队 outline 与 ocr，OCR 先跑、让位后 outline 先行。
    module.schedule({ bookId: BOOK_A, kind: "ocr", priority: 20 });
    module.schedule({ bookId: BOOK_A, kind: "outline", priority: 5 });
    await waitFor(() => module?.list(BOOK_A).every((job) => job.status === "completed") ?? false);
    // 让位任务自暂停 → 排队任务先行 → 队列空闲后自动恢复续跑。
    expect(events).toEqual(["ocr:start", "outline:done", "ocr:start", "ocr:done"]);
  });

  it("does not auto-resume a yielded job the reader cancelled while it waited", async () => {
    const events: string[] = [];
    let yielded = false;
    let releaseOutline: (() => void) | undefined;
    module = createBackgroundJobModule(dataHome, {
      ocr: async (_job, context) => {
        events.push("ocr:start");
        const aborted = new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        if (!yielded) {
          yielded = true;
          context.yieldOnce();
        }
        if (context.signal.aborted) {
          await aborted;
          throw new Error("OCR 任务已暂停或取消。");
        }
        events.push("ocr:done");
      },
      outline: async () => {
        events.push("outline:start");
        await new Promise<void>((resolve) => { releaseOutline = resolve; });
        events.push("outline:done");
      },
    });
    module.schedule({ bookId: BOOK_A, kind: "ocr", priority: 20 });
    module.schedule({ bookId: BOOK_A, kind: "outline", priority: 5 });
    // OCR 让位自暂停，outline 已在运行：Reader 在让位等待期取消 OCR。
    await waitFor(() => module?.list(BOOK_A).find((job) => job.kind === "outline")?.status === "running" ?? false);
    const ocrJob = module.list(BOOK_A).find((job) => job.kind === "ocr");
    if (ocrJob) await module.cancel(ocrJob.id);
    releaseOutline?.();
    await waitFor(() => module?.list(BOOK_A).every((job) => job.status === "completed" || job.status === "cancelled") ?? false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(["ocr:start", "outline:start", "outline:done"]);
    expect(module.list(BOOK_A).find((job) => job.kind === "ocr")?.status).toBe("cancelled");
  });

  it("keeps a reader-paused job paused instead of auto-resuming it", async () => {
    const events: string[] = [];
    module = createBackgroundJobModule(dataHome, {
      ocr: async (_job, context) => {
        events.push("ocr:start");
        await new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error("OCR 任务已暂停或取消。");
      },
      outline: async () => {
        events.push("outline:done");
      },
    });
    const ocrJob = module.schedule({ bookId: BOOK_A, kind: "ocr", priority: 20 });
    await waitFor(() => module?.list(BOOK_A)[0]?.status === "running");
    if (ocrJob.ok) await module.pause(ocrJob.job.id);
    await waitFor(() => module?.list(BOOK_A)[0]?.status === "paused");
    module.schedule({ bookId: BOOK_A, kind: "outline", priority: 5 });
    await waitFor(() => module?.list(BOOK_A).every((job) => job.status !== "queued" && job.status !== "running") ?? false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Reader 主动暂停的任务不经让位通道自动恢复。
    expect(events).toEqual(["ocr:start", "outline:done"]);
    expect(module.list(BOOK_A).find((job) => job.kind === "ocr")?.status).toBe("paused");
  });

});
