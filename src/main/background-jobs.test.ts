import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

  it("cancels running jobs and records executor errors", async () => {
    const executor: JobExecutor = async (job, context) => {
      if (job.bookId === BOOK_B) throw new Error("模拟失败");
      await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
      throw new Error("模拟失败");
    };
    module = createBackgroundJobModule(dataHome, { embedding: executor });
    const scheduled = module.schedule({ bookId: BOOK_A, kind: "embedding" });
    if (!scheduled.ok) throw new Error("任务未创建。");
    await waitFor(() => module?.list()[0]?.status === "running");
    expect(module.cancel(scheduled.job.id)).toMatchObject({ ok: true, job: { status: "cancelled" } });
    await waitFor(() => module?.list()[0]?.status === "cancelled");

    const failed = module.schedule({ bookId: BOOK_B, kind: "embedding" });
    if (!failed.ok) throw new Error("任务未创建。");
    await waitFor(() => module?.list().find((job) => job.id === failed.job.id)?.status === "failed");
    expect(module.list(BOOK_B)[0]).toMatchObject({ status: "failed", errorMessage: "模拟失败" });
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

  it("migrates the existing task table before scheduling outline recovery", async () => {
    const database = new DatabaseSync(path.join(dataHome, "pdfmuse.db"));
    database.exec(`
      CREATE TABLE background_jobs (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('ocr', 'embedding', 'index')),
        priority INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        total INTEGER NOT NULL DEFAULT 0,
        checkpoint TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    database.close();
    module = createBackgroundJobModule(dataHome, { outline: async () => undefined });
    const scheduled = module.schedule({ bookId: BOOK_A, kind: "outline" });
    expect(scheduled.ok).toBe(true);
    await waitFor(() => module?.list(BOOK_A)[0]?.status === "completed");
  });
});
