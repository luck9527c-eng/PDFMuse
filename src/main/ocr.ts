import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";

import type { OcrPageRequest, OcrPageResult, RecognizedPageText } from "../shared/contracts.js";

export type OcrEngine = {
  name: string;
  model: string;
  recognize(input: OcrPageRequest, signal?: AbortSignal): Promise<Pick<RecognizedPageText, "width" | "height" | "orientation" | "lines">>;
  close?(): void;
};

const BOOK_ID_PATTERN = /^[a-f0-9]{64}$/;
const MAX_IMAGE_LENGTH = 24 * 1024 * 1024;

function validRequest(input: OcrPageRequest) {
  return BOOK_ID_PATTERN.test(input.bookId)
    && Number.isSafeInteger(input.page) && input.page > 0
    && Number.isSafeInteger(input.width) && input.width > 0
    && Number.isSafeInteger(input.height) && input.height > 0
    && typeof input.imageData === "string" && input.imageData.length > 0 && input.imageData.length <= MAX_IMAGE_LENGTH;
}

export function createWorkerOcrEngine(): OcrEngine {
  const worker = new Worker(new URL("./ocr-worker.js", import.meta.url));
  const pending = new Map<string, { resolve: (value: Pick<RecognizedPageText, "width" | "height" | "orientation" | "lines">) => void; reject: (error: Error) => void }>();
  worker.on("message", (message: { id: string; ok: boolean; result?: Pick<RecognizedPageText, "width" | "height" | "orientation" | "lines">; message?: string }) => {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.ok && message.result) request.resolve(message.result);
    else request.reject(new Error(message.message ?? "OCR 工作进程不可用。"));
  });
  worker.on("error", (error) => {
    for (const request of pending.values()) request.reject(error instanceof Error ? error : new Error(String(error)));
    pending.clear();
  });
  return {
    name: "OCR Worker",
    model: "待安装",
    recognize(input, signal) {
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        pending.set(id, { resolve, reject });
        const onAbort = () => {
          pending.delete(id);
          reject(new Error("OCR 已取消。"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        worker.postMessage({ id, input });
      });
    },
    close() {
      void worker.terminate();
    },
  };
}

function unavailableEngine(): OcrEngine {
  return {
    name: "未安装",
    model: "未安装",
    async recognize() {
      throw new Error("OCR 工作进程资源尚未安装。");
    },
  };
}

export function createOcrModule(dataHome: string, engine: OcrEngine = createWorkerOcrEngine()) {
  const database = new DatabaseSync(path.join(dataHome, "pdfmuse.db"));
  database.exec(`
    CREATE TABLE IF NOT EXISTS recognized_pages (
      book_id TEXT NOT NULL,
      page INTEGER NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      orientation INTEGER NOT NULL,
      lines_json TEXT NOT NULL,
      engine TEXT NOT NULL,
      model TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (book_id, page)
    );
  `);

  function read(bookId: string, page: number): RecognizedPageText | undefined {
    const row = database.prepare(`
      SELECT book_id, page, width, height, orientation, lines_json, engine, model, created_at
      FROM recognized_pages WHERE book_id = ? AND page = ?
    `).get(bookId, page) as {
      book_id: string; page: number; width: number; height: number; orientation: number;
      lines_json: string; engine: string; model: string; created_at: string;
    } | undefined;
    if (!row) return undefined;
    try {
      return {
        bookId: row.book_id,
        page: row.page,
        width: row.width,
        height: row.height,
        orientation: row.orientation,
        lines: JSON.parse(row.lines_json),
        engine: row.engine,
        model: row.model,
        createdAt: row.created_at,
      };
    } catch {
      return undefined;
    }
  }

  return {
    async recognizePage(input: OcrPageRequest, signal?: AbortSignal): Promise<OcrPageResult> {
      if (!validRequest(input)) return { ok: false, code: "VALIDATION_ERROR", message: "OCR 页面请求无效。" };
      if (signal?.aborted) return { ok: false, code: "CANCELLED", message: "OCR 已取消。" };
      try {
        const recognized = await engine.recognize(input, signal);
        if (signal?.aborted) return { ok: false, code: "CANCELLED", message: "OCR 已取消。" };
        const page: RecognizedPageText = {
          bookId: input.bookId,
          page: input.page,
          width: recognized.width,
          height: recognized.height,
          orientation: recognized.orientation,
          lines: recognized.lines,
          engine: engine.name,
          model: engine.model,
          createdAt: new Date().toISOString(),
        };
        database.prepare(`
          INSERT INTO recognized_pages (book_id, page, width, height, orientation, lines_json, engine, model, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(book_id, page) DO UPDATE SET
            width = excluded.width, height = excluded.height, orientation = excluded.orientation,
            lines_json = excluded.lines_json, engine = excluded.engine, model = excluded.model, created_at = excluded.created_at
        `).run(page.bookId, page.page, page.width, page.height, page.orientation, JSON.stringify(page.lines), page.engine, page.model, page.createdAt);
        return { ok: true, page };
      } catch (error) {
        if (signal?.aborted) return { ok: false, code: "CANCELLED", message: "OCR 已取消。" };
        return { ok: false, code: "UNAVAILABLE", message: error instanceof Error ? error.message : "OCR 工作进程不可用。" };
      }
    },
    getPage(bookId: string, page: number) {
      if (!BOOK_ID_PATTERN.test(bookId) || !Number.isSafeInteger(page) || page <= 0) return undefined;
      return read(bookId, page);
    },
    close() {
      engine.close?.();
      database.close();
    },
  };
}

export type OcrModule = ReturnType<typeof createOcrModule>;
