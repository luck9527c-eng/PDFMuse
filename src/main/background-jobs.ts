import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import type {
  BackgroundJob,
  BackgroundJobKind,
  BackgroundJobMutationResult,
  BackgroundJobStatus,
  ScheduleBackgroundJobInput,
} from "../shared/contracts.js";

const BOOK_ID_PATTERN = /^[a-f0-9]{64}$/;
const KINDS: BackgroundJobKind[] = ["ocr", "embedding", "index"];
type JobRow = {
  id: string;
  book_id: string;
  kind: BackgroundJobKind;
  priority: number;
  status: BackgroundJobStatus;
  progress: number;
  total: number;
  checkpoint: string | null;
  attempts: number;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

export type JobExecutorContext = {
  signal: AbortSignal;
  checkpoint(value: string | undefined, progress: number, total?: number): void;
};

export type JobExecutor = (job: BackgroundJob, context: JobExecutorContext) => Promise<void>;

function toJob(row: JobRow): BackgroundJob {
  return {
    id: row.id,
    bookId: row.book_id,
    kind: row.kind,
    priority: row.priority,
    status: row.status,
    progress: row.progress,
    total: row.total,
    ...(row.checkpoint ? { checkpoint: row.checkpoint } : {}),
    attempts: row.attempts,
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function now() { return new Date().toISOString(); }

export function createBackgroundJobModule(dataHome: string, executors: Partial<Record<BackgroundJobKind, JobExecutor>> = {}) {
  const database = new DatabaseSync(path.join(dataHome, "pdfmuse.db"));
  database.exec(`
    CREATE TABLE IF NOT EXISTS background_jobs (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('ocr', 'embedding', 'index')),
      priority INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'paused', 'completed', 'cancelled', 'failed')),
      progress INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0,
      checkpoint TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS background_jobs_schedule ON background_jobs(status, priority DESC, created_at ASC);
    CREATE INDEX IF NOT EXISTS background_jobs_book ON background_jobs(book_id, updated_at DESC);
  `);
  // A process crash must not leave work permanently marked as running.
  database.prepare("UPDATE background_jobs SET status = 'queued', updated_at = ? WHERE status = 'running'").run(now());

  const active = new Map<string, { controller: AbortController; action?: "pause" | "cancel" }>();
  let pumping = false;
  let closed = false;

  const rowFor = (id: string) => database.prepare(`
    SELECT id, book_id, kind, priority, status, progress, total, checkpoint, attempts, error_message, created_at, updated_at
    FROM background_jobs WHERE id = ?
  `).get(id) as JobRow | undefined;

  function update(id: string, fields: string, values: SQLInputValue[]) {
    if (closed) return;
    database.prepare(`UPDATE background_jobs SET ${fields}, updated_at = ? WHERE id = ?`).run(...values, now(), id);
  }

  function pump() {
    if (pumping || closed) return;
    pumping = true;
    void (async () => {
      try {
        while (!closed) {
          const row = database.prepare(`
            SELECT id, book_id, kind, priority, status, progress, total, checkpoint, attempts, error_message, created_at, updated_at
            FROM background_jobs WHERE status = 'queued'
            ORDER BY priority DESC, created_at ASC LIMIT 1
          `).get() as JobRow | undefined;
          if (!row) break;
          const executor = executors[row.kind];
          if (!executor) {
            update(row.id, "status = ?, error_message = ?", ["failed", "当前任务类型尚未配置执行器。"]);
            continue;
          }
          const job = toJob(row);
          const controller = new AbortController();
          active.set(row.id, { controller });
          update(row.id, "status = ?, attempts = attempts + 1, error_message = NULL", ["running"]);
          const running = toJob(rowFor(row.id)!);
          try {
            await executor(running, {
              signal: controller.signal,
              checkpoint(value, progress, total = running.total) {
                if (closed) return;
                const boundedProgress = Math.max(0, Math.min(total, Math.floor(progress)));
                update(row.id, "progress = ?, total = ?, checkpoint = ?", [boundedProgress, total, value ?? null]);
              },
            });
            if (!closed) {
              const requested = active.get(row.id)?.action;
              const latest = rowFor(row.id);
              if (latest?.status === "queued") {
                // A resume may have been requested while an abort was settling.
              } else if (requested === "pause") update(row.id, "status = ?", ["paused"]);
              else if (requested === "cancel") update(row.id, "status = ?", ["cancelled"]);
              else update(row.id, "status = ?, progress = total, error_message = NULL", ["completed"]);
            }
          } catch (error) {
            if (!closed) {
              const requested = active.get(row.id)?.action;
              const latest = rowFor(row.id);
              if (latest?.status === "queued") {
                // A resume may have been requested while an abort was settling.
              } else if (requested === "pause") update(row.id, "status = ?", ["paused"]);
              else if (requested === "cancel") update(row.id, "status = ?", ["cancelled"]);
              else update(row.id, "status = ?, error_message = ?", ["failed", error instanceof Error ? error.message : "后台任务失败。"]);
            }
          } finally {
            active.delete(row.id);
          }
        }
      } finally {
        pumping = false;
        if (!closed && database.prepare("SELECT 1 FROM background_jobs WHERE status = 'queued' LIMIT 1").get()) pump();
      }
    })();
  }

  function validJobId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 128; }

  // Recover queued work immediately after process startup.
  pump();

  return {
    schedule(input: ScheduleBackgroundJobInput): BackgroundJobMutationResult {
      if (!BOOK_ID_PATTERN.test(input.bookId) || !KINDS.includes(input.kind)) return { ok: false, code: "VALIDATION_ERROR", message: "后台任务参数无效。" };
      const priority = Number.isSafeInteger(input.priority) ? Math.max(-100, Math.min(100, input.priority!)) : 0;
      const total = Number.isSafeInteger(input.total) && input.total! >= 0 ? input.total! : 0;
      const existing = database.prepare(`
        SELECT id, book_id, kind, priority, status, progress, total, checkpoint, attempts, error_message, created_at, updated_at
        FROM background_jobs WHERE book_id = ? AND kind = ? AND status IN ('queued', 'running', 'paused')
        ORDER BY created_at ASC LIMIT 1
      `).get(input.bookId, input.kind) as JobRow | undefined;
      if (existing) return { ok: true, job: toJob(existing) };
      const id = randomUUID();
      const timestamp = now();
      database.prepare(`
        INSERT INTO background_jobs (id, book_id, kind, priority, status, progress, total, attempts, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'queued', 0, ?, 0, ?, ?)
      `).run(id, input.bookId, input.kind, priority, total, timestamp, timestamp);
      pump();
      return { ok: true, job: toJob(rowFor(id)!) };
    },
    list(bookId?: string): BackgroundJob[] {
      if (closed) return [];
      const rows = bookId && BOOK_ID_PATTERN.test(bookId)
        ? database.prepare(`SELECT id, book_id, kind, priority, status, progress, total, checkpoint, attempts, error_message, created_at, updated_at FROM background_jobs WHERE book_id = ? ORDER BY updated_at DESC`).all(bookId)
        : database.prepare(`SELECT id, book_id, kind, priority, status, progress, total, checkpoint, attempts, error_message, created_at, updated_at FROM background_jobs ORDER BY updated_at DESC`).all();
      return (rows as JobRow[]).map(toJob);
    },
    get(id: string): BackgroundJob | undefined {
      if (closed || !validJobId(id)) return undefined;
      const row = rowFor(id);
      return row ? toJob(row) : undefined;
    },
    pause(id: string): BackgroundJobMutationResult {
      const row = validJobId(id) ? rowFor(id) : undefined;
      if (!row) return { ok: false, code: "NOT_FOUND", message: "后台任务不存在。" };
      if (row.status === "queued") update(id, "status = ?", ["paused"]);
      else if (row.status === "running") {
        const state = active.get(id);
        if (state) { state.action = "pause"; update(id, "status = ?", ["paused"]); state.controller.abort(); }
      }
      else if (row.status !== "paused") return { ok: false, code: "CONFLICT", message: "当前任务无法暂停。" };
      return { ok: true, job: toJob(rowFor(id)!) };
    },
    resume(id: string): BackgroundJobMutationResult {
      const row = validJobId(id) ? rowFor(id) : undefined;
      if (!row) return { ok: false, code: "NOT_FOUND", message: "后台任务不存在。" };
      if (row.status !== "paused") return { ok: false, code: "CONFLICT", message: "当前任务不在暂停状态。" };
      update(id, "status = ?, error_message = NULL", ["queued"]);
      pump();
      return { ok: true, job: toJob(rowFor(id)!) };
    },
    cancel(id: string): BackgroundJobMutationResult {
      const row = validJobId(id) ? rowFor(id) : undefined;
      if (!row) return { ok: false, code: "NOT_FOUND", message: "后台任务不存在。" };
      if (row.status === "queued" || row.status === "paused") update(id, "status = ?", ["cancelled"]);
      else if (row.status === "running") {
        const state = active.get(id);
        if (state) { state.action = "cancel"; update(id, "status = ?", ["cancelled"]); state.controller.abort(); }
      }
      else return { ok: false, code: "CONFLICT", message: "当前任务无法取消。" };
      return { ok: true, job: toJob(rowFor(id)!) };
    },
    close() {
      closed = true;
      for (const state of active.values()) state.controller.abort();
      active.clear();
      database.close();
    },
  };
}

export type BackgroundJobModule = ReturnType<typeof createBackgroundJobModule>;
