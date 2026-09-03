import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

/**
 * 整本书的页级全文索引（FTS5）。
 * 中文按单字切分写入，查询词同样预处理，使任意长度的中文子串都能命中；
 * 英文单词保持原样由 unicode61 分词。
 */
const CJK_PATTERN = /[\u3000-\u9fff\uff00-\uffef]/;

export function tokenizeForIndex(text: string) {
  return Array.from(text)
    .map((char) => (CJK_PATTERN.test(char) ? ` ${char} ` : char))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

export type BookSearchHit = {
  page: number;
  snippet: string;
};

export type BookSearchOutcome =
  | { status: "ok"; hits: BookSearchHit[]; indexedPages: number; totalPages: number }
  | { status: "partial"; hits: BookSearchHit[]; indexedPages: number; totalPages: number; note: string }
  | { status: "unavailable"; note: string };

type BookRow = { current_path: string; page_count: number; saved_password: string | null };

/** 用 pdfjs 抽取一页文本；失败页返回空串并继续。 */
async function extractPageText(document: Awaited<ReturnType<typeof getDocument>["promise"]>, page: number) {
  try {
    const pageProxy = await document.getPage(page);
    const content = await pageProxy.getTextContent();
    return content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

export function createBookIndex(dataHome: string) {
  const database = new DatabaseSync(path.join(dataHome, "pdfmuse.db"));
  database.exec(`
    CREATE TABLE IF NOT EXISTS book_pages (
      book_id TEXT NOT NULL,
      page INTEGER NOT NULL,
      text TEXT NOT NULL,
      PRIMARY KEY (book_id, page)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS book_pages_fts USING fts5(
      book_id UNINDEXED,
      page UNINDEXED,
      tokens,
      tokenize='unicode61'
    );
  `);

  const indexedPagesStatement = database.prepare(
    "SELECT COUNT(*) AS count FROM book_pages WHERE book_id = ?",
  );
  const bookRowStatement = database.prepare(
    "SELECT current_path, page_count, saved_password FROM library_books WHERE id = ?",
  );
  const insertPageStatement = database.prepare(`
    INSERT INTO book_pages (book_id, page, text) VALUES (?, ?, ?)
    ON CONFLICT(book_id, page) DO UPDATE SET text = excluded.text
  `);
  const insertFtsStatement = database.prepare(
    "INSERT INTO book_pages_fts (book_id, page, tokens) VALUES (?, ?, ?)",
  );
  const clearFtsStatement = database.prepare(
    "DELETE FROM book_pages_fts WHERE book_id = ?",
  );
  const searchStatement = database.prepare(`
    SELECT page, text
    FROM book_pages
    WHERE book_id = ? AND text LIKE ?
    ORDER BY page ASC
    LIMIT 40
  `);
  const indexedPagesBeforeStatement = database.prepare(
    "SELECT MAX(page) AS max_page, COUNT(*) AS count FROM book_pages WHERE book_id = ?",
  );

  async function ensureIndexed(
    bookId: string,
    loadBook: () => Promise<{ bytes: Uint8Array; password?: string }>,
    signal?: AbortSignal,
  ): Promise<{ indexedPages: number; totalPages: number; note?: string }> {
    const row = bookRowStatement.get(bookId) as BookRow | undefined;
    if (!row) return { indexedPages: 0, totalPages: 0, note: "书库中没有这本书的索引来源。" };
    const existing = indexedPagesBeforeStatement.get(bookId) as { max_page: number | null; count: number };
    if (existing.count >= row.page_count && existing.max_page === row.page_count) {
      return { indexedPages: existing.count, totalPages: row.page_count };
    }
    const source = await loadBook();
    const loadingTask = getDocument({
      data: source.bytes.slice(),
      ...(source.password ? { password: source.password } : {}),
    });
    let indexed = 0;
    try {
      const document = await loadingTask.promise;
      database.exec("BEGIN");
      try {
        clearFtsStatement.run(bookId);
        for (let page = 1; page <= document.numPages; page += 1) {
          if (signal?.aborted) break;
          const text = await extractPageText(document, page);
          insertPageStatement.run(bookId, page, text);
          if (text) insertFtsStatement.run(bookId, page, tokenizeForIndex(text));
          indexed = page;
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    } finally {
      await loadingTask.destroy();
    }
    const partial = indexed < row.page_count
      ? { note: `索引尚未完成（已索引 ${indexed}/${row.page_count} 页），当前只在已索引范围内检索。` }
      : {};
    return { indexedPages: indexed, totalPages: row.page_count, ...partial };
  }

  function likePattern(query: string) {
    const escaped = query.replace(/[%_\\]/g, (char) => `\\${char}`);
    return `%${escaped}%`;
  }

  function buildSnippet(pageText: string, query: string) {
    const index = pageText.toLowerCase().indexOf(query.toLowerCase());
    if (index < 0) return pageText.slice(0, 160);
    const start = Math.max(0, index - 60);
    const end = Math.min(pageText.length, index + query.length + 100);
    return `${start > 0 ? "…" : ""}${pageText.slice(start, end)}${end < pageText.length ? "…" : ""}`;
  }

  return {
    async search(
      bookId: string,
      query: string,
      limit = 6,
    ): Promise<BookSearchOutcome> {
      const trimmed = query.trim();
      if (!trimmed) return { status: "unavailable", note: "检索词为空。" };
      const row = bookRowStatement.get(bookId) as BookRow | undefined;
      if (!row) return { status: "unavailable", note: "书库中没有这本书。" };

      // 混合检索：FTS5 命中（token 化）+ LIKE 兜底（覆盖标点分隔的中文与短语）。
      const tokens = tokenizeForIndex(trimmed);
      let pages: { page: number; text: string }[];
      try {
        const fts = database.prepare(`
          SELECT page FROM book_pages_fts
          WHERE book_pages_fts MATCH ?
          ORDER BY rank
          LIMIT 40
        `).all(`"${tokens.replace(/"/g, '""')}"`) as { page: number }[];
        const ftsPages = new Set(fts.map((hit) => hit.page));
        const likePages = searchStatement.all(bookId, likePattern(trimmed)) as { page: number; text: string }[];
        const merged = new Map<number, string>();
        for (const hit of likePages) merged.set(hit.page, hit.text);
        for (const hit of ftsPages) {
          if (!merged.has(hit)) {
            const text = database.prepare(
              "SELECT text FROM book_pages WHERE book_id = ? AND page = ?",
            ).get(bookId, hit) as { text: string } | undefined;
            if (text) merged.set(hit, text.text);
          }
        }
        pages = [...merged.entries()]
          .sort((a, b) => (ftsPages.has(a[0]) && !ftsPages.has(b[0]) ? -1 : 0) || a[0] - b[0])
          .map(([page, text]) => ({ page, text }));
      } catch {
        pages = searchStatement.all(bookId, likePattern(trimmed)) as { page: number; text: string }[];
      }

      const hits: BookSearchHit[] = pages.slice(0, limit).map((hit) => ({
        page: hit.page,
        snippet: buildSnippet(hit.text, trimmed),
      }));
      const indexedPages = indexedPagesStatement.get(bookId) as { count: number };
      const base = {
        hits,
        indexedPages: indexedPages.count,
        totalPages: row.page_count,
      };
      if (indexedPages.count < row.page_count) {
        return {
          status: "partial",
          ...base,
          note: `索引尚未完成（${indexedPages.count}/${row.page_count} 页），结果只覆盖已索引页面。`,
        };
      }
      return { status: "ok", ...base };
    },

    ensureIndexed,

    /** 按书库记录读取原文件字节（含已记住的密码）；原文件只读，永不修改。 */
    async loadBookByBookId(bookId: string) {
      const row = bookRowStatement.get(bookId) as BookRow | undefined;
      if (!row) throw new Error("书库中没有这本书。");
      return loadBookBytes(row.current_path, row.saved_password ?? undefined);
    },

    stats(bookId: string) {
      const row = bookRowStatement.get(bookId) as BookRow | undefined;
      const indexed = indexedPagesStatement.get(bookId) as { count: number };
      return {
        indexedPages: indexed.count,
        totalPages: row?.page_count ?? 0,
      };
    },

    close() {
      database.close();
    },
  };
}

/** 从原文件读取书籍字节用于索引；原文件永不修改。 */
export async function loadBookBytes(currentPath: string, password?: string) {
  const bytes = new Uint8Array(await readFile(currentPath));
  return { bytes, ...(password ? { password } : {}) };
}

export type BookIndex = ReturnType<typeof createBookIndex>;
