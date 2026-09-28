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
  const state = { yields: 0 };
  const context: JobExecutorContext = {
    signal: controller.signal,
    checkpoint: (value, progress) => { checkpoints.push({ value: value ?? "", progress }); },
    yieldOnce: () => {
      state.yields += 1;
      controller.abort();
    },
  };
  return { checkpoints, controller, yields: () => state.yields, context };
}

function makeDeps(options: { pageCount?: number; indexPages?: number[]; preRecognized?: number[] } = {}) {
  const pageCount = options.pageCount ?? 40;
  const indexPages = new Set(options.indexPages ?? []);
  const blockFor = (page: number): MineruBlock => ({
    type: indexPages.has(page) ? "index" : "text",
    text: `第${page}页正文内容。`,
    bbox: [0.1, 0.1, 0.9, 0.2],
  });
  const blocks = new Map<number, MineruBlock[]>();
  for (const page of options.preRecognized ?? []) blocks.set(page, [blockFor(page)]);
  const recognized: number[] = [];
  const reranks: number[] = [];
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
    getPageBlocks: (_bookId, page) => blocks.get(page),
    isPageCompatible: (_bookId, page) => blocks.has(page),
    async recognizePage(input) {
      recognized.push(input.page);
      blocks.set(input.page, [blockFor(input.page)]);
      return { ok: true, page: { bookId: input.bookId, page: input.page, blocks: blocks.get(input.page)! } };
    },
    ingestPage: () => undefined,
    scheduleOutlineRerank: () => { reranks.push(reranks.length); },
    completeBook: () => { completed = true; },
    decodeCheckpoint: ingestion.decodeOcrCheckpoint,
    encodeCheckpoint: ingestion.encodeOcrCheckpoint,
    createFrontier: ingestion.createOcrFrontier,
    concurrency: 2,
  };
  return { deps, recognized: () => recognized, completed: () => completed, reran: () => reranks.length };
}

describe("ocr job executor", () => {
  it("hands over once on run-end, scheduling the outline rerank before pausing", async () => {
    const harness = makeDeps({ indexPages: [5] });
    const run = makeContext();
    await expect(createOcrJobExecutor(harness.deps)(makeJob("job-1"), run.context)).rejects.toThrow("OCR 任务已暂停或取消。");
    expect(run.yields()).toBe(1);
    // 先调度后交棒：目录重排已入队，OCR 才自暂停。
    expect(harness.reran()).toBe(1);
    // run-end：M=5，gap 页 6、7 已扫且无 index → 目录区结束；让位后至多一个在途页把前沿再推进一页。
    const lastCheckpoint = run.checkpoints.at(-1)!.progress;
    expect(lastCheckpoint).toBeGreaterThanOrEqual(7);
    expect(lastCheckpoint).toBeLessThanOrEqual(8);
    expect(run.checkpoints.at(-1)!.value).toBe(`ocr-linear:${lastCheckpoint}`);
    for (const page of [1, 2, 3, 4, 5, 6, 7]) expect(harness.recognized()).toContain(page);
    expect(harness.completed()).toBe(false);
  });

  it("does not hand over again after resuming and completes the book without re-recognizing", async () => {
    const harness = makeDeps({ indexPages: [5] });
    const executor = createOcrJobExecutor(harness.deps);
    const first = makeContext();
    await expect(executor(makeJob("job-1"), first.context)).rejects.toThrow("OCR 任务已暂停或取消。");
    const second = makeContext();
    await executor(makeJob("job-1", "ocr-linear:7"), second.context);
    // 同任务续跑不再交棒（一次性登记），断点之后无损续扫、全书恰好识别一遍。
    expect(second.yields()).toBe(0);
    expect(harness.reran()).toBe(1);
    expect(harness.completed()).toBe(true);
    expect(harness.recognized().length).toBe(40);
    expect(new Set(harness.recognized()).size).toBe(40);
  });

  it("hands over at startup when resuming from a checkpoint past the probe window", async () => {
    // 崩溃恢复：窗口内 30 页崩溃前已入库，断点已越过窗口——启动即检仍要交棒给目录任务。
    const harness = makeDeps({ indexPages: [5], preRecognized: Array.from({ length: 30 }, (_, index) => index + 1) });
    const run = makeContext();
    await expect(createOcrJobExecutor(harness.deps)(makeJob("job-1", "ocr-linear:35"), run.context)).rejects.toThrow("OCR 任务已暂停或取消。");
    expect(run.yields()).toBe(1);
    expect(harness.reran()).toBe(1);
    // 交棒发生在任何续扫识别之前。
    expect(harness.recognized()).toEqual([]);
  });

  it("hands over on window coverage for books without toc signals", async () => {
    const harness = makeDeps({});
    const run = makeContext();
    await expect(createOcrJobExecutor(harness.deps)(makeJob("job-1"), run.context)).rejects.toThrow("OCR 任务已暂停或取消。");
    expect(run.yields()).toBe(1);
    expect(harness.reran()).toBe(1);
    const lastCheckpoint = run.checkpoints.at(-1)!.progress;
    expect(lastCheckpoint).toBeGreaterThanOrEqual(30);
    expect(lastCheckpoint).toBeLessThanOrEqual(31);
  });

  it("waits for window coverage when the only index page sits at the window edge", async () => {
    // 交互识别乱序入库：index 页恰在窗口末页（M=30）而线性前沿未到——gap 页 31、32
    // 越出观察面，不得空集免检放行；前沿扫满窗口才由覆盖兜底触发。
    const harness = makeDeps({ indexPages: [30], preRecognized: [30] });
    const run = makeContext();
    await expect(createOcrJobExecutor(harness.deps)(makeJob("job-1"), run.context)).rejects.toThrow("OCR 任务已暂停或取消。");
    expect(run.yields()).toBe(1);
    const lastCheckpoint = run.checkpoints.at(-1)!.progress;
    expect(lastCheckpoint).toBeGreaterThanOrEqual(30);
    expect(lastCheckpoint).toBeLessThanOrEqual(31);
  });

  it("resumes past the window after the startup handover and finishes without re-recognizing", async () => {
    const harness = makeDeps({});
    const executor = createOcrJobExecutor(harness.deps);
    // 断点 33 已越过窗口：启动即检交棒一次（窗口覆盖判定成立），不识别任何页。
    const first = makeContext();
    await expect(executor(makeJob("job-1", "ocr-linear:33"), first.context)).rejects.toThrow("OCR 任务已暂停或取消。");
    expect(first.yields()).toBe(1);
    expect(harness.recognized()).toEqual([]);
    // Reader 恢复续跑：不再交棒，续扫 34..40 收尾。
    const second = makeContext();
    await executor(makeJob("job-1", "ocr-linear:33"), second.context);
    expect(second.yields()).toBe(0);
    expect(harness.recognized()).toEqual([34, 35, 36, 37, 38, 39, 40]);
    expect(harness.completed()).toBe(true);
  });

  it("fails the job with the recognition error and does not schedule the outline rerank", async () => {
    const harness = makeDeps({});
    harness.deps.recognizePage = async () => ({ ok: false, code: "FAILED", message: "识别 worker 无响应。" });
    const run = makeContext();
    await expect(createOcrJobExecutor(harness.deps)(makeJob("job-1"), run.context)).rejects.toThrow("识别 worker 无响应。");
    expect(harness.completed()).toBe(false);
    expect(harness.reran()).toBe(0);
  });

  it("fails the job when the book is no longer available", async () => {
    const harness = makeDeps();
    harness.deps.loadBook = () => undefined;
    const executor = createOcrJobExecutor(harness.deps);
    await expect(executor(makeJob("job-1"), makeContext().context)).rejects.toThrow("当前 PDF 书籍不可用。");
  });
});
