import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPipelineTracer, pipelineTraceFilePath, readPipelineTrace } from "./pipeline-trace.js";
import type { PipelineTraceEvent } from "../shared/contracts.js";

const BOOK_A = "a".repeat(64);
const BOOK_B = "b".repeat(64);

function gateEvent(accepted: boolean): PipelineTraceEvent {
  return { kind: "embedded_gate", data: { accepted, entryCount: 3, resolvableCount: 3, distinctPages: 2 } };
}

describe("pipeline tracer", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "pdfmuse-trace-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it("appends events as JSONL lines with ts, kind, data", async () => {
    const tracer = createPipelineTracer({ logDirectory: directory });
    tracer.emit(BOOK_A, gateEvent(true));
    tracer.emit(BOOK_A, { kind: "tier_one_adjudicated", data: {} });
    // emit 同步返回；串行泵异步落盘，等待排空。
    await vi.waitFor(() => expect(readdir(directory)).resolves.toHaveLength(1));
    const raw = await readFile(pipelineTraceFilePath(directory, BOOK_A), "utf8");
    const lines = raw.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as { ts: string; kind: string; data: { accepted: boolean } };
    expect(first.kind).toBe("embedded_gate");
    expect(first.data.accepted).toBe(true);
    expect(first.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    const second = JSON.parse(lines[1]!) as { kind: string; data: Record<string, never> };
    expect(second).toEqual({ ts: second.ts, kind: "tier_one_adjudicated", data: {} });
  });

  it("keeps books in separate files", async () => {
    const tracer = createPipelineTracer({ logDirectory: directory });
    tracer.emit(BOOK_A, gateEvent(true));
    tracer.emit(BOOK_B, { kind: "ocr_start", data: { fromPage: 1 } });
    await vi.waitFor(() => expect(readdir(directory)).resolves.toHaveLength(2));
    const eventsA = await readPipelineTrace(directory, BOOK_A);
    const eventsB = await readPipelineTrace(directory, BOOK_B);
    expect(eventsA.map((record) => record.kind)).toEqual(["embedded_gate"]);
    expect(eventsB.map((record) => record.kind)).toEqual(["ocr_start"]);
    expect(eventsB[0]!.data).toEqual({ fromPage: 1 });
  });

  it("never throws and keeps the pipeline running when the log directory is unwritable", async () => {
    // logDirectory 指向一个普通文件：mkdir 必败，写路径全灭。
    const blocker = path.join(directory, "blocker");
    await writeFile(blocker, "not a directory", "utf8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const tracer = createPipelineTracer({ logDirectory: blocker });
    expect(() => {
      tracer.emit(BOOK_A, gateEvent(false));
      tracer.emit(BOOK_A, { kind: "persist", data: { strategy: "embedded", calibrated: true, nodeCount: 3, version: 8 } });
    }).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect((await readdir(directory)).sort()).toEqual(["blocker"]);
  });

  it("skips corrupted lines and unknown kinds when reading", async () => {
    const tracer = createPipelineTracer({ logDirectory: directory });
    tracer.emit(BOOK_A, gateEvent(true));
    await vi.waitFor(() => expect(readdir(directory)).resolves.toHaveLength(1));
    const file = pipelineTraceFilePath(directory, BOOK_A);
    await writeFile(file, `{"ts":"x","kind":"nonsense"}\n{ broken json\n${await readFile(file, "utf8")}`, "utf8");
    const records = await readPipelineTrace(directory, BOOK_A);
    expect(records).toHaveLength(1);
    expect(records[0]!.kind).toBe("embedded_gate");
  });

  it("returns an empty list when the book has no trace file", async () => {
    await expect(readPipelineTrace(directory, BOOK_A)).resolves.toEqual([]);
  });
});
