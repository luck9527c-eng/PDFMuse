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
    expect(calls).toEqual(["schedule:outline:5:120"]);
  });

  it("encodes and decodes OCR book checkpoints across current and legacy formats", () => {
    const { ingestion } = createHarness();
    expect(ingestion.encodeOcrCheckpoint(6, 12)).toBe("ocr-order:6:12");
    expect(ingestion.decodeOcrCheckpoint("ocr-order:6:12")).toEqual({ focusPage: 6, completed: 12 });
    expect(ingestion.decodeOcrCheckpoint("start:9")).toEqual({ focusPage: 9, completed: 0 });
    expect(ingestion.decodeOcrCheckpoint("page:4")).toEqual({ focusPage: 4, completed: 0 });
    expect(ingestion.decodeOcrCheckpoint(undefined)).toEqual({ focusPage: 1, completed: 0 });
    expect(ingestion.decodeOcrCheckpoint("无法解析的断点")).toEqual({ focusPage: 1, completed: 0 });
    expect(ingestion.decodeOcrCheckpoint(ingestion.encodeOcrCheckpoint(3, 0))).toEqual({ focusPage: 3, completed: 0 });
    expect(ingestion.decodeOcrCheckpoint(ingestion.encodeOcrCheckpoint(1, 40))).toEqual({ focusPage: 1, completed: 40 });
  });
});
