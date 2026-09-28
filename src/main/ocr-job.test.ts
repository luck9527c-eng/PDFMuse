import { describe, expect, it } from "vitest";

import type { JobExecutorContext } from "./background-jobs.js";
import { createOcrJobExecutor, type OcrJobDependencies } from "./ocr-job.js";
import { createRecognizedTextIngestion } from "./recognized-text-ingestion.js";
import type { BackgroundJob, MineruBlock } from "../shared/contracts.js";

const BOOK_ID = "a".repeat(64);

function makeJob(id: string, checkpoint?: string): BackgroundJob {
  return {
    id,
    bookId: BOOK_ID,
    kind: "ocr",
    priority: 20,
    status: "running",
    progress: 0,
    total: 40,
    attempts: 1,
    maxAttempts: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...(checkpoint ? { checkpoint } : {}),
  };
}

function makeContext() {
  const controller = new AbortController();
  const checkpoints: Array<{ value: string; progress: number }> = [];
  const context: JobExecutorContext = {
    signal: controller.signal,
    checkpoint: (value, progress) => { checkpoints.push({ value: value ?? "", progress }); },
  };
  return { checkpoints, controller, context };
}

function makeDeps(options: { pageCount?: number } = {}) {
  const pageCount = options.pageCount ?? 40;
  const blocks = new Map<number, MineruBlock[]>();
  const recognized: number[] = [];
  let completed = false;
  // 断点编解码复用真实 ingestion 模块：线性序断点格式端到端可验。
  const ingestion = createRecognizedTextIngestion({
    indexRecognizedPage: () => undefined,
    scheduleEmbedding: async () => false,
    invalidateOutline: () => undefined,
    loadPageCount: () => pageCount,
    listJobs: () => [],
    cancelJob: () => undefined,
    scheduleJob: () => undefined,
  });
  const deps: OcrJobDependencies = {
    loadBook: () => ({ pageCount }),
    isPageCompatible: (_bookId, page) => blocks.has(page),
    async recognizePage(input) {
      recognized.push(input.page);
      const pageBlocks: MineruBlock[] = [{ type: "text", text: `第${input.page}页正文内容。`, bbox: [0.1, 0.1, 0.9, 0.2] }];
      blocks.set(input.page, pageBlocks);
      return { ok: true, page: { bookId: input.bookId, page: input.page, blocks: pageBlocks } };
    },
    ingestPage: () => undefined,
    completeBook: () => { completed = true; },
    decodeCheckpoint: ingestion.decodeOcrCheckpoint,
    encodeCheckpoint: ingestion.encodeOcrCheckpoint,
    createFrontier: ingestion.createOcrFrontier,
    concurrency: 2,
  };
  return {
    deps,
    recognized: () => recognized,
    completed: () => completed,
    recognizeFailsWith(message: string) {
      deps.recognizePage = async () => ({ ok: false, code: "FAILED", message });
    },
  };
}

describe("ocr job executor", () => {
  it("scans the whole book linearly and schedules the outline rerank on completion", async () => {
    const harness = makeDeps();
    const run = makeContext();
    await createOcrJobExecutor(harness.deps)(makeJob("job-1"), run.context);
    expect(harness.recognized().length).toBe(40);
    expect(new Set(harness.recognized()).size).toBe(40);
    expect(run.checkpoints.at(-1)).toMatchObject({ value: "ocr-linear:40", progress: 40 });
    expect(harness.completed()).toBe(true);
  });

  it("resumes from a linear checkpoint without re-recognizing earlier pages", async () => {
    const harness = makeDeps();
    const executor = createOcrJobExecutor(harness.deps);
    // 模拟崩溃后恢复：断点已推进到 12，重跑只识别 13..40，每页恰好一次。
    const run = makeContext();
    await executor(makeJob("job-1", "ocr-linear:12"), run.context);
    expect(harness.recognized()).toEqual(Array.from({ length: 28 }, (_, index) => index + 13));
    expect(run.checkpoints.at(-1)).toMatchObject({ value: "ocr-linear:40", progress: 40 });
    expect(harness.completed()).toBe(true);
  });

  it("treats stale checkpoint formats as a restart from page one", async () => {
    const harness = makeDeps();
    const run = makeContext();
    await createOcrJobExecutor(harness.deps)(makeJob("job-1", "ocr-order:6:12"), run.context);
    // 旧格式断点（扩散页序语义）判过期，从头线性重扫。
    expect(harness.recognized().length).toBe(40);
    expect(harness.recognized()[0]).toBe(1);
  });

  it("fails the job with the recognition error and does not schedule the outline rerank", async () => {
    const harness = makeDeps();
    harness.recognizeFailsWith("识别 worker 无响应。");
    const run = makeContext();
    await expect(createOcrJobExecutor(harness.deps)(makeJob("job-1"), run.context)).rejects.toThrow("识别 worker 无响应。");
    expect(harness.completed()).toBe(false);
  });

  it("aborts cleanly when the reader pauses mid-scan", async () => {
    const harness = makeDeps();
    const run = makeContext();
    const executor = createOcrJobExecutor(harness.deps);
    const running = executor(makeJob("job-1"), run.context);
    run.controller.abort();
    await expect(running).rejects.toThrow("OCR 任务已暂停或取消。");
    expect(harness.completed()).toBe(false);
  });

  it("fails the job when the book is no longer available", async () => {
    const harness = makeDeps();
    harness.deps.loadBook = () => undefined;
    const executor = createOcrJobExecutor(harness.deps);
    await expect(executor(makeJob("job-1"), makeContext().context)).rejects.toThrow("当前 PDF 书籍不可用。");
  });
});
