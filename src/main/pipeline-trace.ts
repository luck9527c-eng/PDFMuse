// 管线观测 trace 写入器（spec「采集侧」）：决策瞬间的结构化事件按书追加进 JSONL 文件
// （data/logs/pipeline-trace-<bookId>.jsonl），不进 SQLite——好滚动、好 grep、不污染 schema。
// 常驻写入不门控 dev（打包版用户报障时「把 jsonl 发我」即远程诊断材料）；不自动清理
// （量级：每书几十行）；写失败吞掉 + console.warn，emit 永不抛（管线零风险）。

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  PIPELINE_TRACE_KINDS,
  type PipelineTraceEvent,
  type PipelineTraceKind,
  type PipelineTraceRecord,
} from "../shared/contracts.js";

export type PipelineTraceEmitter = (bookId: string, event: PipelineTraceEvent) => void;

/** 管线模块的观测依赖形态（与 createPipelineTracer 的返回一致）：缺省不埋点。 */
export type PipelineTracer = { emit: PipelineTraceEmitter };

/** ISO 形态的本地时钟（含时区偏移）：面板时间线按本地时间可读，跨时区导出仍无歧义。 */
function localIso(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const pad = (value: number, width = 2) => String(Math.floor(Math.abs(value))).padStart(width, "0");
  const offset = `${sign}${pad(Math.abs(offsetMinutes) / 60)}:${pad(Math.abs(offsetMinutes) % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${offset}`;
}

export function pipelineTraceFilePath(logDirectory: string, bookId: string): string {
  return path.join(logDirectory, `pipeline-trace-${bookId}.jsonl`);
}

export function createPipelineTracer(options: { logDirectory: string }): { emit: PipelineTraceEmitter } {
  const { logDirectory } = options;
  // 每书串行泵：append 之间保持行序。串行调度下本无并发，但不显式假设——按书排队后
  // 无论调用方是否并发都安全。
  const pending = new Map<string, Promise<void>>();
  const enqueue = (bookId: string, line: string) => {
    const previous = pending.get(bookId) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        await mkdir(logDirectory, { recursive: true });
        await appendFile(pipelineTraceFilePath(logDirectory, bookId), `${line}\n`, "utf8");
      })
      .catch((error) => {
        console.warn("管线 trace 写入失败（不影响管线）：", error);
      });
    pending.set(bookId, next);
  };
  return {
    emit(bookId, event) {
      let line: string;
      try {
        line = JSON.stringify({ ts: localIso(new Date()), kind: event.kind, data: event.data });
      } catch (error) {
        console.warn("管线 trace 序列化失败（不影响管线）：", error);
        return;
      }
      enqueue(bookId, line);
    },
  };
}

/** trace:get 内容搬运：逐行解析该书 JSONL，坏行跳过不炸；只收已知 kind（渲染端标签表安全）。 */
export async function readPipelineTrace(logDirectory: string, bookId: string): Promise<PipelineTraceRecord[]> {
  let raw: string;
  try {
    raw = await readFile(pipelineTraceFilePath(logDirectory, bookId), "utf8");
  } catch {
    return [];
  }
  const records: PipelineTraceRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value = JSON.parse(trimmed) as { ts?: unknown; kind?: unknown; data?: unknown };
      if (typeof value?.ts !== "string") continue;
      if (!(PIPELINE_TRACE_KINDS as readonly unknown[]).includes(value.kind)) continue;
      const record = { ts: value.ts, kind: value.kind as PipelineTraceKind, data: value.data ?? {} } as PipelineTraceRecord;
      records.push(record);
    } catch {
      // 残行/坏行跳过。
    }
  }
  return records;
}
