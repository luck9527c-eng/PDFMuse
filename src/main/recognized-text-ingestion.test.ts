import { describe, expect, it } from "vitest";

import {
  createRecognizedTextIngestion,
  type RecognizedTextIngestionDependencies,
} from "./recognized-text-ingestion.js";

const BOOK = "a".repeat(64);

function createHarness(overrides: Partial<RecognizedTextIngestionDependencies> = {}) {
  const calls: string[] = [];
  const activeJobs = [
    { id: "job-outline-running", kind: "outline" as const, status: "running" as const },
    { id: "job-embedding-queued", kind: "embedding" as const, status: "queued" as const },
  ];
  const dependencies: RecognizedTextIngestionDependencies = {
    indexRecognizedPage: (bookId, page, lines) => {
      calls.push(`index:${bookId[0]}:${page}:${lines.length}`);
    },
    scheduleEmbedding: async (input) => {
      calls.push(`embedding:${input.priority}:${input.total}`);
      return true;
    },
    invalidateOutline: (_bookId, page) => {
      calls.push(`invalidate:${page}`);
    },
    loadPageCount: () => 120,
    listJobs: () => activeJobs,
    cancelJob: (id) => {
      calls.push(`cancel:${id}`);
    },
    scheduleJob: (input) => {
      calls.push(`schedule:${input.kind}:${input.priority}:${input.total}`);
    },
    ...overrides,
  };
  return { ingestion: createRecognizedTextIngestion(dependencies), calls };
}

describe("recognized text ingestion", () => {
  it("runs the background reaction in order without requeueing the outline per page", async () => {
    const { ingestion, calls } = createHarness();
    await ingestion.ingestRecognizedPage(BOOK, 7, [{ text: "认识到的一行" }], "background");
    expect(calls).toEqual([
      "index:a:7:1",
      "embedding:5:120",
      "invalidate:7",
    ]);
  });

  it("requeues the outline at interactive priority and only cancels active outline jobs", async () => {
    const { ingestion, calls } = createHarness();
    await ingestion.ingestRecognizedPage(BOOK, 9, [{ text: "甲" }, { text: "乙" }], "interactive");
    expect(calls).toEqual([
      "index:a:9:2",
      "embedding:5:120",
      "invalidate:9",
      "cancel:job-outline-running",
      "schedule:outline:20:120",
    ]);
  });

  it("requeues the outline once at background priority when a whole book finishes OCR", () => {
    const { ingestion, calls } = createHarness();
    ingestion.completeBookOcr(BOOK);
    expect(calls).toEqual(["schedule:outline:15:120"]);
  });

  it("encodes and decodes linear OCR checkpoints and treats legacy formats as stale", () => {
    const { ingestion } = createHarness();
    expect(ingestion.encodeOcrCheckpoint(12)).toBe("ocr-linear:12");
    expect(ingestion.decodeOcrCheckpoint("ocr-linear:12")).toEqual({ completed: 12 });
    // 旧格式断点（从开书页扩散的页序语义）一律判过期从头重扫：线性序下的 completed
    // 前缀与旧扩散序前缀不可混读，兼容检查让重扫对已识别页近乎零成本。
    expect(ingestion.decodeOcrCheckpoint("ocr-order:6:12")).toEqual({ completed: 0 });
    expect(ingestion.decodeOcrCheckpoint("start:9")).toEqual({ completed: 0 });
    expect(ingestion.decodeOcrCheckpoint("page:4")).toEqual({ completed: 0 });
    expect(ingestion.decodeOcrCheckpoint(undefined)).toEqual({ completed: 0 });
    expect(ingestion.decodeOcrCheckpoint("无法解析的断点")).toEqual({ completed: 0 });
    expect(ingestion.decodeOcrCheckpoint(ingestion.encodeOcrCheckpoint(0))).toEqual({ completed: 0 });
    expect(ingestion.decodeOcrCheckpoint(ingestion.encodeOcrCheckpoint(40))).toEqual({ completed: 40 });
  });

  it("完成前沿只计连续前缀：乱序完成不推进，补齐后跳到新前沿", () => {
    const { ingestion } = createHarness();
    const frontier = ingestion.createOcrFrontier(2);
    expect(frontier.frontier()).toBe(2);
    expect(frontier.complete(3)).toBe(2);
    expect(frontier.complete(2)).toBe(4);
    expect(frontier.complete(0)).toBe(4);
    expect(frontier.complete(4)).toBe(5);
    expect(frontier.complete(1)).toBe(5);
  });

  it("完成前沿从零起步并容忍非法页序", () => {
    const { ingestion } = createHarness();
    const frontier = ingestion.createOcrFrontier(0);
    expect(frontier.complete(1)).toBe(0);
    expect(frontier.complete(0)).toBe(2);
    expect(frontier.complete(-3)).toBe(2);
    expect(frontier.complete(2)).toBe(3);
  });
});
