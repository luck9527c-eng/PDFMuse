import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

import type { OcrPageRequest, OcrPageResult, RecognizedPageText } from "../shared/contracts.js";
import type { MineruEngine } from "./mineru.js";

const BOOK_ID_PATTERN = /^[a-f0-9]{64}$/;

export type RecognizedPageSource = { path: string; encrypted: boolean };

export type OcrModuleDependencies = {
  /** 书籍原文件定位：识别引擎按页直读 PDF，不再经渲染取图；加密书在此标记并提前拒绝。 */
  resolvePdfPath(bookId: string): RecognizedPageSource | undefined;
};

export function createOcrModule(
  dataHome: string,
  engine: MineruEngine,
  dependencies: OcrModuleDependencies,
) {
  const database = new DatabaseSync(path.join(dataHome, "pdfmuse.db"));
  const activeRecognitions = new Map<string, Promise<OcrPageResult>>();
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
      input_hash TEXT NOT NULL DEFAULT '',
      engine_version TEXT NOT NULL DEFAULT 'unknown',
      input_version TEXT NOT NULL DEFAULT 'unknown',
      created_at TEXT NOT NULL,
      PRIMARY KEY (book_id, page)
    );
  `);
  const columns = database.prepare("PRAGMA table_info(recognized_pages)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "input_hash")) database.exec("ALTER TABLE recognized_pages ADD COLUMN input_hash TEXT NOT NULL DEFAULT ''");
  if (!columns.some((column) => column.name === "engine_version")) database.exec("ALTER TABLE recognized_pages ADD COLUMN engine_version TEXT NOT NULL DEFAULT 'unknown'");
  if (!columns.some((column) => column.name === "input_version")) database.exec("ALTER TABLE recognized_pages ADD COLUMN input_version TEXT NOT NULL DEFAULT 'unknown'");
  if (!columns.some((column) => column.name === "blocks_json")) database.exec("ALTER TABLE recognized_pages ADD COLUMN blocks_json TEXT NOT NULL DEFAULT ''");

  function read(bookId: string, page: number): RecognizedPageText | undefined {
    const row = database.prepare(`
      SELECT book_id, page, blocks_json, engine, model, input_hash, input_version, engine_version, created_at
      FROM recognized_pages WHERE book_id = ? AND page = ?
    `).get(bookId, page) as {
      book_id: string; page: number;
      blocks_json: string; engine: string; model: string; input_hash: string; input_version: string; engine_version: string; created_at: string;
    } | undefined;
    if (!row) return undefined;
    try {
      return {
        bookId: row.book_id,
        page: row.page,
        blocks: JSON.parse(row.blocks_json) as RecognizedPageText["blocks"],
        engine: row.engine,
        model: row.model,
        inputHash: row.input_hash,
        inputVersion: row.input_version,
        engineVersion: row.engine_version,
        createdAt: row.created_at,
      };
    } catch {
      return undefined;
    }
  }

  return {
    async recognizePage(input: OcrPageRequest, signal?: AbortSignal): Promise<OcrPageResult> {
      if (!BOOK_ID_PATTERN.test(input.bookId) || !Number.isSafeInteger(input.page) || input.page <= 0) {
        return { ok: false, code: "VALIDATION_ERROR", message: "OCR 页面请求无效。" };
      }
      const source = dependencies.resolvePdfPath(input.bookId);
      if (!source) return { ok: false, code: "VALIDATION_ERROR", message: "当前 PDF 书籍不可用。" };
      if (source.encrypted) return { ok: false, code: "UNAVAILABLE", message: "加密 PDF 暂不支持识别。" };
      if (signal?.aborted) return { ok: false, code: "CANCELLED", message: "OCR 已取消。" };
      const key = `${input.bookId}:${input.page}`;
      const active = activeRecognitions.get(key);
      if (active) return active;
      const run = (async (): Promise<OcrPageResult> => {
        // bookId 即 PDF 内容指纹，与页码共同构成输入身份；缓存有效期由输入版本守卫。
        const inputHash = createHash("sha256").update(`${input.bookId}:${input.page}`).digest("hex");
        const cached = read(input.bookId, input.page);
        if (
          cached
          && cached.inputHash === inputHash
          && cached.model === engine.model
          && cached.engineVersion === (engine.version ?? "unknown")
          && cached.inputVersion === (engine.inputVersion ?? "unknown")
        ) return { ok: true, page: cached };
        try {
          const recognized = await engine.recognizePage({ page: input.page, pdfPath: source.path }, signal);
          if (signal?.aborted) return { ok: false, code: "CANCELLED", message: "OCR 已取消。" };
          const page: RecognizedPageText = {
            bookId: input.bookId,
            page: input.page,
            blocks: recognized.blocks,
            engine: engine.name,
            model: engine.model,
            inputHash,
            inputVersion: engine.inputVersion ?? "unknown",
            engineVersion: engine.version ?? "unknown",
            createdAt: new Date().toISOString(),
          };
          database.prepare(`
            INSERT INTO recognized_pages (book_id, page, width, height, orientation, lines_json, blocks_json, engine, model, input_hash, input_version, engine_version, created_at)
            VALUES (?, ?, 0, 0, 0, '', ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(book_id, page) DO UPDATE SET
              lines_json = '', blocks_json = excluded.blocks_json, engine = excluded.engine, model = excluded.model, created_at = excluded.created_at,
              input_hash = excluded.input_hash, input_version = excluded.input_version, engine_version = excluded.engine_version
          `).run(page.bookId, page.page, JSON.stringify(page.blocks), page.engine, page.model, page.inputHash, page.inputVersion ?? "unknown", page.engineVersion, page.createdAt);
          return { ok: true, page };
        } catch (error) {
          if (signal?.aborted) return { ok: false, code: "CANCELLED", message: "OCR 已取消。" };
          return { ok: false, code: "UNAVAILABLE", message: error instanceof Error ? error.message : "MinerU 工作进程不可用。" };
        }
      })().finally(() => activeRecognitions.delete(key));
      activeRecognitions.set(key, run);
      return run;
    },
    getPage(bookId: string, page: number) {
      if (!BOOK_ID_PATTERN.test(bookId) || !Number.isSafeInteger(page) || page <= 0) return undefined;
      return read(bookId, page);
    },
    isPageCompatible(bookId: string, page: number, expectedEngine: string, expectedModel: string, expectedInputVersion?: string) {
      const result = read(bookId, page);
      return Boolean(
        result
        && result.engineVersion === expectedEngine
        && result.model === expectedModel
        && (!expectedInputVersion || result.inputVersion === expectedInputVersion),
      );
    },

    /** 每书数据清理钩子：在调用方提供的连接上删除本书识别页。 */
    deleteBookData(bookId: string, connection: DatabaseSync) {
      connection.prepare("DELETE FROM recognized_pages WHERE book_id = ?").run(bookId);
    },

    close() {
      engine.close?.();
      database.close();
    },
  };
}

export type OcrModule = ReturnType<typeof createOcrModule>;
