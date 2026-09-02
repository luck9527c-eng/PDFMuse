import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import type {
  LibraryBook,
  OpenedPdfBook,
  OpenPdfBookResult,
} from "../shared/contracts.js";

type BookRow = {
  id: string;
  title: string;
  file_name: string;
  current_path: string;
  page_count: number;
  current_page: number;
  updated_at: string;
};

function toLibraryBook(row: BookRow): LibraryBook {
  return {
    id: row.id,
    title: row.title,
    fileName: row.file_name,
    path: row.current_path,
    pageCount: row.page_count,
    currentPage: row.current_page,
    updatedAt: row.updated_at,
  };
}

function fingerprint(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function failure(
  code: Extract<OpenPdfBookResult, { ok: false }>["code"],
  message: string,
): OpenPdfBookResult {
  return { ok: false, code, message };
}

async function inspectPdf(bytes: Uint8Array, fallbackTitle: string) {
  const loadingTask = getDocument({ data: bytes.slice() });
  try {
    const document = await loadingTask.promise;
    const metadata = await document.getMetadata().catch(() => undefined);
    const metadataTitle = metadata?.info && "Title" in metadata.info
      ? metadata.info.Title
      : undefined;
    return {
      pageCount: document.numPages,
      title: typeof metadataTitle === "string" && metadataTitle.trim()
        ? metadataTitle.trim()
        : fallbackTitle,
    };
  } finally {
    await loadingTask.destroy();
  }
}

export function createLibraryModule(dataHome: string) {
  const database = new DatabaseSync(path.join(dataHome, "pdfmuse.db"));
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS library_books (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      file_name TEXT NOT NULL,
      current_path TEXT NOT NULL,
      page_count INTEGER NOT NULL CHECK (page_count > 0),
      current_page INTEGER NOT NULL DEFAULT 1 CHECK (current_page > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    PRAGMA user_version = 1;
  `);

  const listStatement = database.prepare(`
    SELECT id, title, file_name, current_path, page_count, current_page, updated_at
    FROM library_books
    ORDER BY updated_at DESC, id ASC
  `);
  const findStatement = database.prepare(`
    SELECT id, title, file_name, current_path, page_count, current_page, updated_at
    FROM library_books
    WHERE id = ?
  `);
  const upsertStatement = database.prepare(`
    INSERT INTO library_books (
      id, fingerprint, title, file_name, current_path, page_count, current_page, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(fingerprint) DO UPDATE SET
      title = excluded.title,
      file_name = excluded.file_name,
      current_path = excluded.current_path,
      page_count = excluded.page_count,
      updated_at = excluded.updated_at
  `);
  const touchStatement = database.prepare(`
    UPDATE library_books SET updated_at = ? WHERE id = ?
  `);
  const updatePageStatement = database.prepare(`
    UPDATE library_books
    SET current_page = MIN(MAX(?, 1), page_count), updated_at = ?
    WHERE id = ?
  `);

  async function openBytes(
    filePath: string,
    bytes: Uint8Array,
    expectedFingerprint?: string,
  ): Promise<OpenPdfBookResult> {
    const contentFingerprint = fingerprint(bytes);
    if (expectedFingerprint && contentFingerprint !== expectedFingerprint) {
      return failure(
        "CONTENT_CHANGED",
        "此路径中的 PDF 内容已经变化。原书籍记录保持不变，请重新选择该文件。",
      );
    }

    const fileName = path.basename(filePath);
    let pdf: Awaited<ReturnType<typeof inspectPdf>>;
    try {
      pdf = await inspectPdf(bytes, path.basename(fileName, path.extname(fileName)));
    } catch {
      return failure(
        "INVALID_PDF",
        "无法解析此 PDF 文件。文件可能已损坏、受密码保护或不是有效的 PDF。",
      );
    }

    const now = new Date().toISOString();
    if (!expectedFingerprint) {
      upsertStatement.run(
        contentFingerprint,
        contentFingerprint,
        pdf.title,
        fileName,
        filePath,
        pdf.pageCount,
        now,
        now,
      );
    } else {
      touchStatement.run(now, contentFingerprint);
    }
    const row = findStatement.get(contentFingerprint) as BookRow;
    const opened: OpenedPdfBook = {
      id: row.id,
      name: row.title,
      path: row.current_path,
      pageCount: row.page_count,
      currentPage: row.current_page,
      bytes,
    };
    return { ok: true, book: opened };
  }

  return {
    list(): LibraryBook[] {
      return (listStatement.all() as BookRow[]).map(toLibraryBook);
    },

    async openPath(inputPath: unknown): Promise<OpenPdfBookResult> {
      if (typeof inputPath !== "string" || path.extname(inputPath).toLowerCase() !== ".pdf") {
        return failure("INVALID_FILE_TYPE", "请选择 PDF 文件。其他文件类型不会加入书库。");
      }
      const filePath = path.resolve(inputPath);
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await readFile(filePath));
      } catch {
        return failure("FILE_UNAVAILABLE", "无法读取此 PDF 文件，请检查文件是否仍然存在且可访问。");
      }
      return openBytes(filePath, bytes);
    },

    async openKnown(bookId: unknown): Promise<OpenPdfBookResult> {
      if (typeof bookId !== "string" || !/^[a-f0-9]{64}$/.test(bookId)) {
        return failure("FILE_UNAVAILABLE", "书库记录无效，无法打开此 PDF 书籍。");
      }
      const row = findStatement.get(bookId) as BookRow | undefined;
      if (!row) return failure("FILE_UNAVAILABLE", "书库中没有找到此 PDF 书籍。");
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await readFile(row.current_path));
      } catch {
        return failure("FILE_UNAVAILABLE", "PDF 原文件暂时不可用，书库记录已保留。");
      }
      return openBytes(row.current_path, bytes, row.id);
    },

    updateCurrentPage(bookId: unknown, page: unknown) {
      if (typeof bookId !== "string" || !/^[a-f0-9]{64}$/.test(bookId)
        || typeof page !== "number" || !Number.isSafeInteger(page)) {
        return;
      }
      updatePageStatement.run(page, new Date().toISOString(), bookId);
    },

    close() {
      database.close();
    },
  };
}
