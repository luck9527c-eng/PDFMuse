import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  getDocument,
  PasswordException,
  PasswordResponses,
} from "pdfjs-dist/legacy/build/pdf.mjs";

import type {
  LibraryBook,
  LibraryMutationResult,
  OpenedPdfBook,
  OpenPdfBookResult,
  ReadingState,
  ReadingZoomMode,
} from "../shared/contracts.js";

type BookRow = {
  id: string;
  title: string;
  file_name: string;
  current_path: string;
  page_count: number;
  current_page: number;
  scroll_top: number;
  zoom_mode: ReadingZoomMode;
  zoom_scale: number;
  left_sidebar_open: number;
  right_sidebar_open: number;
  saved_password: string | null;
  in_library: number;
  updated_at: string;
};

const BOOK_ID_PATTERN = /^[a-f0-9]{64}$/;

const readingColumns = `
  id, title, file_name, current_path, page_count, current_page,
  scroll_top, zoom_mode, zoom_scale, left_sidebar_open, right_sidebar_open,
  updated_at, saved_password, in_library
`;

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
  code: Exclude<Extract<OpenPdfBookResult, { ok: false }>["code"], "PASSWORD_REQUIRED">,
  message: string,
  bookId?: string,
): OpenPdfBookResult {
  return { ok: false, code, message, ...(bookId ? { bookId } : {}) };
}

function passwordFailure(
  message: string,
  challengeId: string,
  bookId?: string,
): OpenPdfBookResult {
  return { ok: false, code: "PASSWORD_REQUIRED", message, challengeId, ...(bookId ? { bookId } : {}) };
}

function mutationFailure(code: "NOT_FOUND" | "WRITE_ERROR", message: string): LibraryMutationResult {
  return { ok: false, code, message };
}

function toReadingState(row: BookRow): ReadingState {
  return {
    page: row.current_page,
    scrollTop: row.scroll_top,
    zoomMode: row.zoom_mode,
    zoomScale: row.zoom_scale,
    leftSidebarOpen: row.left_sidebar_open === 1,
    rightSidebarOpen: row.right_sidebar_open === 1,
  };
}

function isZoomMode(value: unknown): value is ReadingZoomMode {
  return value === "page-width" || value === "page-fit" || value === "custom";
}

function isReadingState(value: unknown): value is ReadingState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<ReadingState>;
  return Number.isSafeInteger(state.page)
    && typeof state.scrollTop === "number" && Number.isFinite(state.scrollTop)
    && isZoomMode(state.zoomMode)
    && typeof state.zoomScale === "number" && Number.isFinite(state.zoomScale)
    && typeof state.leftSidebarOpen === "boolean"
    && typeof state.rightSidebarOpen === "boolean";
}

async function inspectPdf(bytes: Uint8Array, fallbackTitle: string, password?: string) {
  const loadingTask = getDocument({ data: bytes.slice(), ...(password ? { password } : {}) });
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
      scroll_top REAL NOT NULL DEFAULT 0 CHECK (scroll_top >= 0),
      zoom_mode TEXT NOT NULL DEFAULT 'page-width',
      zoom_scale REAL NOT NULL DEFAULT 100 CHECK (zoom_scale > 0),
      left_sidebar_open INTEGER NOT NULL DEFAULT 1 CHECK (left_sidebar_open IN (0, 1)),
      right_sidebar_open INTEGER NOT NULL DEFAULT 1 CHECK (right_sidebar_open IN (0, 1)),
      saved_password TEXT,
      in_library INTEGER NOT NULL DEFAULT 1 CHECK (in_library IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const existingColumns = new Set(
    (database.prepare("PRAGMA table_info(library_books)").all() as { name: string }[])
      .map((column) => column.name),
  );
  const migrations = [
    ["scroll_top", "ALTER TABLE library_books ADD COLUMN scroll_top REAL NOT NULL DEFAULT 0"],
    ["zoom_mode", "ALTER TABLE library_books ADD COLUMN zoom_mode TEXT NOT NULL DEFAULT 'page-width'"],
    ["zoom_scale", "ALTER TABLE library_books ADD COLUMN zoom_scale REAL NOT NULL DEFAULT 100"],
    ["left_sidebar_open", "ALTER TABLE library_books ADD COLUMN left_sidebar_open INTEGER NOT NULL DEFAULT 1"],
    ["right_sidebar_open", "ALTER TABLE library_books ADD COLUMN right_sidebar_open INTEGER NOT NULL DEFAULT 1"],
    ["saved_password", "ALTER TABLE library_books ADD COLUMN saved_password TEXT"],
    ["in_library", "ALTER TABLE library_books ADD COLUMN in_library INTEGER NOT NULL DEFAULT 1"],
  ] as const;
  for (const [column, statement] of migrations) {
    if (!existingColumns.has(column)) database.exec(statement);
  }
  const schemaVersion = database.prepare("PRAGMA user_version").get() as { user_version: number };
  if (schemaVersion.user_version < 4) database.exec("PRAGMA user_version = 4;");

  const listStatement = database.prepare(`
    SELECT id, title, file_name, current_path, page_count, current_page, updated_at
    FROM library_books
    WHERE in_library = 1
    ORDER BY updated_at DESC, id ASC
  `);
  const findStatement = database.prepare(`
    SELECT ${readingColumns}
    FROM library_books
    WHERE id = ?
  `);
  const recentStatement = database.prepare(`
    SELECT id FROM library_books WHERE in_library = 1 ORDER BY updated_at DESC, id ASC LIMIT 1
  `);
  const findActiveStatement = database.prepare(`
    SELECT ${readingColumns}
    FROM library_books
    WHERE id = ? AND in_library = 1
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
      in_library = 1,
      updated_at = excluded.updated_at
  `);
  const touchStatement = database.prepare(`
    UPDATE library_books SET updated_at = ? WHERE id = ?
  `);
  const relocateStatement = database.prepare(`
    UPDATE library_books SET file_name = ?, current_path = ?, updated_at = ? WHERE id = ?
  `);
  const updateStateStatement = database.prepare(`
    UPDATE library_books
    SET current_page = MIN(MAX(?, 1), page_count),
        scroll_top = MAX(?, 0),
        zoom_mode = ?,
        zoom_scale = MIN(MAX(?, 25), 500),
        left_sidebar_open = ?,
        right_sidebar_open = ?,
        updated_at = ?
    WHERE id = ?
  `);
  const savePasswordStatement = database.prepare(`
    UPDATE library_books SET saved_password = ? WHERE id = ?
  `);
  const removeFromLibraryStatement = database.prepare(`
    UPDATE library_books SET in_library = 0, updated_at = ? WHERE id = ? AND in_library = 1
  `);
  const tableExistsStatement = database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?
  `);
  type PendingOpen = {
    filePath: string;
    bytes: Uint8Array;
    expectedFingerprint?: string;
    relocate: boolean;
    expiresAt: number;
  };
  const passwordChallenges = new Map<string, PendingOpen>();

  function createPasswordChallenge(open: Omit<PendingOpen, "expiresAt">) {
    const now = Date.now();
    for (const [id, pending] of passwordChallenges) {
      if (pending.expiresAt <= now) passwordChallenges.delete(id);
    }
    while (passwordChallenges.size >= 8) {
      const oldestId = passwordChallenges.keys().next().value;
      if (typeof oldestId !== "string") break;
      passwordChallenges.delete(oldestId);
    }
    const challengeId = randomUUID();
    passwordChallenges.set(challengeId, { ...open, expiresAt: now + 5 * 60_000 });
    return challengeId;
  }

  async function openBytes(
    filePath: string,
    bytes: Uint8Array,
    expectedFingerprint?: string,
    relocate = false,
    password?: string,
    challengeId?: string,
  ): Promise<OpenPdfBookResult> {
    const contentFingerprint = fingerprint(bytes);
    if (expectedFingerprint && contentFingerprint !== expectedFingerprint) {
      return failure(
        "CONTENT_CHANGED",
        "此路径中的 PDF 内容已经变化。原书籍记录保持不变，请重新选择该文件。",
        expectedFingerprint,
      );
    }

    const fileName = path.basename(filePath);
    const knownBook = findStatement.get(contentFingerprint) as BookRow | undefined;
    const effectivePassword = password ?? knownBook?.saved_password ?? undefined;
    let pdf: Awaited<ReturnType<typeof inspectPdf>>;
    try {
      pdf = await inspectPdf(bytes, path.basename(fileName, path.extname(fileName)), effectivePassword);
    } catch (error) {
      if (error instanceof PasswordException || (
        typeof error === "object" && error !== null && "name" in error && error.name === "PasswordException"
      )) {
        const code = "code" in (error as object) ? (error as { code?: number }).code : undefined;
        const pendingChallengeId = challengeId ?? createPasswordChallenge({
          filePath,
          bytes,
          expectedFingerprint,
          relocate,
        });
        return passwordFailure(
          code === PasswordResponses.INCORRECT_PASSWORD
            ? "密码错误，请重新输入。"
            : "此 PDF 书籍受密码保护，请输入密码后继续。",
          pendingChallengeId,
          expectedFingerprint,
        );
      }
      return failure(
        "INVALID_PDF",
        "无法解析此 PDF 文件。文件可能已损坏或不是有效的 PDF。",
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
    } else if (relocate) {
      relocateStatement.run(fileName, filePath, now, contentFingerprint);
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
      readingState: toReadingState(row),
      bytes,
      ...(effectivePassword ? { password: effectivePassword } : {}),
    };
    return { ok: true, book: opened };
  }

  return {
    list(): LibraryBook[] {
      return (listStatement.all() as BookRow[]).map(toLibraryBook);
    },

    has(bookId: unknown) {
      return typeof bookId === "string" && BOOK_ID_PATTERN.test(bookId)
        && Boolean(findActiveStatement.get(bookId));
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
      if (typeof bookId !== "string" || !BOOK_ID_PATTERN.test(bookId)) {
        return failure("FILE_UNAVAILABLE", "书库记录无效，无法打开此 PDF 书籍。");
      }
      const row = findActiveStatement.get(bookId) as BookRow | undefined;
      if (!row) return failure("FILE_UNAVAILABLE", "书库中没有找到此 PDF 书籍。", bookId);
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await readFile(row.current_path));
      } catch {
        return failure("FILE_UNAVAILABLE", "PDF 原文件暂时不可用，书库记录已保留。你可以重新定位原文件。", bookId);
      }
      return openBytes(row.current_path, bytes, row.id, false, row.saved_password ?? undefined);
    },

    async openRecent(): Promise<OpenPdfBookResult | null> {
      const recent = recentStatement.get() as { id: string } | undefined;
      return recent ? this.openKnown(recent.id) : null;
    },

    async relocate(bookId: unknown, inputPath: unknown): Promise<OpenPdfBookResult> {
      if (typeof bookId !== "string" || !BOOK_ID_PATTERN.test(bookId)) {
        return failure("FILE_UNAVAILABLE", "书库记录无效，无法重新定位此 PDF 书籍。");
      }
      if (typeof inputPath !== "string" || path.extname(inputPath).toLowerCase() !== ".pdf") {
        return failure("INVALID_FILE_TYPE", "请选择对应的 PDF 原文件。", bookId);
      }
      const knownBook = findActiveStatement.get(bookId) as BookRow | undefined;
      if (!knownBook) {
        return failure("FILE_UNAVAILABLE", "书库中没有找到此 PDF 书籍。", bookId);
      }
      const filePath = path.resolve(inputPath);
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await readFile(filePath));
      } catch {
        return failure("FILE_UNAVAILABLE", "无法读取所选 PDF 文件，请检查它是否可访问。", bookId);
      }
      return openBytes(filePath, bytes, bookId, true, knownBook.saved_password ?? undefined);
    },

    async unlock(
      challengeId: unknown,
      password: unknown,
      rememberPassword: unknown,
    ): Promise<OpenPdfBookResult> {
      if (typeof challengeId !== "string" || typeof password !== "string" || password.length === 0
        || password.length > 1024 || typeof rememberPassword !== "boolean") {
        return failure("INVALID_PDF", "密码请求无效，请重新打开此 PDF 书籍。");
      }
      const pending = passwordChallenges.get(challengeId);
      if (!pending || pending.expiresAt <= Date.now()) {
        passwordChallenges.delete(challengeId);
        return failure("INVALID_PDF", "密码请求已过期，请重新打开此 PDF 书籍。");
      }
      const result = await openBytes(
        pending.filePath,
        pending.bytes,
        pending.expectedFingerprint,
        pending.relocate,
        password,
        challengeId,
      );
      if (!result.ok) {
        if (result.code !== "PASSWORD_REQUIRED") passwordChallenges.delete(challengeId);
        return result;
      }
      passwordChallenges.delete(challengeId);
      if (rememberPassword) savePasswordStatement.run(password, result.book.id);
      return result;
    },

    updateReadingState(bookId: unknown, state: unknown) {
      if (typeof bookId !== "string" || !BOOK_ID_PATTERN.test(bookId)
        || !isReadingState(state)) {
        return;
      }
      updateStateStatement.run(
        state.page,
        state.scrollTop,
        state.zoomMode,
        state.zoomScale,
        state.leftSidebarOpen ? 1 : 0,
        state.rightSidebarOpen ? 1 : 0,
        new Date().toISOString(),
        bookId,
      );
    },

    removeFromLibrary(bookId: unknown): LibraryMutationResult {
      if (typeof bookId !== "string" || !BOOK_ID_PATTERN.test(bookId)) {
        return mutationFailure("NOT_FOUND", "书库中没有找到这本 PDF 书籍。");
      }
      try {
        const result = removeFromLibraryStatement.run(new Date().toISOString(), bookId);
        return result.changes > 0
          ? { ok: true, bookId }
          : mutationFailure("NOT_FOUND", "书库中没有找到这本 PDF 书籍。");
      } catch (error) {
        console.error("移出书库失败", error);
        return mutationFailure("WRITE_ERROR", "无法将这本书移出书库，请稍后重试。");
      }
    },

    deleteBookData(bookId: unknown): LibraryMutationResult {
      if (typeof bookId !== "string" || !BOOK_ID_PATTERN.test(bookId) || !findStatement.get(bookId)) {
        return mutationFailure("NOT_FOUND", "书库中没有找到这本 PDF 书籍。");
      }
      const hasTable = (name: string) => Boolean(tableExistsStatement.get(name));
      try {
        database.exec("BEGIN IMMEDIATE");
        if (hasTable("agent_messages") && hasTable("agent_sessions")) {
          database.prepare(`
            DELETE FROM agent_messages
            WHERE session_id IN (SELECT id FROM agent_sessions WHERE book_id = ?)
          `).run(bookId);
        }
        if (hasTable("agent_sessions")) database.prepare("DELETE FROM agent_sessions WHERE book_id = ?").run(bookId);
        for (const table of [
          "background_jobs",
          "book_outline_pages",
          "book_outlines",
          "recognized_pages",
          "semantic_embeddings",
          "book_pages_fts",
          "book_pages",
          // Book Memory 已移除（ADR 0006）；遗留表在删除书籍数据时一并清理。
          "memory_fts",
          "memory_audit",
          "memory_proposals",
          "book_memories",
        ]) {
          if (hasTable(table)) database.prepare(`DELETE FROM ${table} WHERE book_id = ?`).run(bookId);
        }
        database.prepare("DELETE FROM library_books WHERE id = ?").run(bookId);
        database.exec("COMMIT");
        return { ok: true, bookId };
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch { /* 事务未启动时无需回滚。 */ }
        console.error("删除本书产品数据失败", error);
        return mutationFailure("WRITE_ERROR", "无法删除本书数据，现有数据保持不变，请稍后重试。");
      }
    },

    close() {
      passwordChallenges.clear();
      database.close();
    },
  };
}
