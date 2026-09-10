import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import type { BookOutlineNode, RecognizedTextLine } from "../shared/contracts.js";

const BOOK_ID_PATTERN = /^[a-f0-9]{64}$/;
const OUTLINE_VERSION = 1;
const MAX_HEADINGS = 240;

export type OutlineTextLine = { text: string; size: number; y: number };
export type OutlineHeading = { label: string; page: number; level: number; explicit: boolean };

export type OutlineDocument = {
  pageCount: number;
  hasValidEmbeddedOutline: boolean;
  getNativeLines(page: number): Promise<OutlineTextLine[]>;
  close(): Promise<void>;
};

export type OpenOutlineDocument = (
  source: { bytes: Uint8Array; password?: string },
) => Promise<OutlineDocument>;

type CandidateRow = { page: number; candidates_json: string };
type StoredOutlineRow = { nodes_json: string; updated_at: string };

function normalizeLabel(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function explicitLevel(label: string) {
  if (/^(part|chapter|appendix)\s+(?:\d+|[ivxlcdm]+|[a-z])\b/i.test(label)) return 1;
  if (/^section\s+(?:\d+|[ivxlcdm]+|[a-z])\b/i.test(label)) return 2;
  const chinese = label.match(/^第[一二三四五六七八九十百零〇两\d]+([部篇章节节])/);
  if (chinese) return chinese[1] === "节" ? 2 : 1;
  const numbered = label.match(/^(\d+(?:\.\d+){0,3})[\s、.．]+\S/);
  if (numbered) return Math.min(3, numbered[1]!.split(".").length);
  return undefined;
}

export function detectHeadingCandidates(page: number, lines: readonly OutlineTextLine[]): OutlineHeading[] {
  const usable = lines
    .map((line) => ({ ...line, text: normalizeLabel(line.text) }))
    .filter((line) => line.text && Number.isFinite(line.size) && line.size > 0);
  const sizes = usable.map((line) => line.size).sort((left, right) => left - right);
  const bodySize = median(sizes.slice(0, Math.max(1, Math.floor(sizes.length * 0.75)))) || 1;
  return usable.flatMap((line) => {
    if (line.text.length < 2 || line.text.length > 100) return [];
    if (/^(?:第?\s*\d+\s*页|page\s+\d+(?:\s+of\s+\d+)?)$/i.test(line.text)) return [];
    if (/^\d+$/.test(line.text) || /\.{3,}\s*\d+$/.test(line.text)) return [];
    const explicit = explicitLevel(line.text);
    const ratio = line.size / bodySize;
    if (!explicit && ratio < 1.32) return [];
    if (!explicit && /[。！？!?；;:]$/.test(line.text)) return [];
    const level = explicit ?? (ratio >= 1.7 ? 1 : ratio >= 1.42 ? 2 : 3);
    return [{ label: line.text, page, level, explicit: explicit !== undefined }];
  });
}

/**
 * 查找某页所在的最深章节路径（如「第5章 › 5.2 主存储器」），供 Reading Focus 注入。
 * 规则与渲染端目录高亮一致：起点不晚于该页的节点中，起点最新者优先；同起点取更深层。
 */
export function findOutlineSectionPath(nodes: readonly BookOutlineNode[], page: number): string | undefined {
  let best: { page: number; path: string[] } | undefined;
  const walk = (list: readonly BookOutlineNode[], path: string[]) => {
    for (const node of list) {
      const nextPath = [...path, node.label];
      if (node.page !== undefined && node.page <= page) {
        if (!best || node.page > best.page || (node.page === best.page && nextPath.length > best.path.length)) {
          best = { page: node.page, path: nextPath };
        }
      }
      if (node.children.length > 0) walk(node.children, nextPath);
    }
  };
  walk(nodes, []);
  return best ? best.path.join(" › ") : undefined;
}

export function buildOutlineTree(headings: readonly OutlineHeading[], pageCount: number): BookOutlineNode[] {
  const labelPages = new Map<string, Set<number>>();
  for (const heading of headings) {
    const key = heading.label.toLocaleLowerCase();
    const pages = labelPages.get(key) ?? new Set<number>();
    pages.add(heading.page);
    labelPages.set(key, pages);
  }
  const repeatedThreshold = Math.max(3, Math.ceil(pageCount * 0.6));
  const roots: BookOutlineNode[] = [];
  const stack: Array<{ level: number; node: BookOutlineNode }> = [];
  const seen = new Set<string>();
  for (const heading of headings.slice(0, MAX_HEADINGS)) {
    const key = heading.label.toLocaleLowerCase();
    if (!heading.explicit && (labelPages.get(key)?.size ?? 0) >= repeatedThreshold) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    const node: BookOutlineNode = {
      id: `generated-${heading.page}-${seen.size}`,
      label: heading.label,
      page: heading.page,
      children: [],
    };
    while (stack.length > 0 && stack[stack.length - 1]!.level >= heading.level) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parent.node.children.push(node); else roots.push(node);
    stack.push({ level: heading.level, node });
  }
  return roots;
}

function recognizedLines(value: string): OutlineTextLine[] {
  try {
    const lines = JSON.parse(value) as RecognizedTextLine[];
    if (!Array.isArray(lines)) return [];
    return lines.flatMap((line) => {
      if (!line || typeof line.text !== "string" || !Array.isArray(line.polygon)) return [];
      const ys = line.polygon.map((point) => point?.y).filter((y): y is number => typeof y === "number" && Number.isFinite(y));
      if (ys.length < 3) return [];
      return [{ text: line.text, size: Math.max(...ys) - Math.min(...ys), y: Math.min(...ys) }];
    });
  } catch {
    return [];
  }
}

type PdfDocument = Awaited<ReturnType<typeof getDocument>["promise"]>;
type PdfOutlineItem = NonNullable<Awaited<ReturnType<PdfDocument["getOutline"]>>>[number];

async function hasValidOutline(document: PdfDocument, items: PdfOutlineItem[] | null): Promise<boolean> {
  if (!items) return false;
  for (const item of items) {
    if (item.title.trim() && item.dest) {
      try {
        const destination = typeof item.dest === "string" ? await document.getDestination(item.dest) : item.dest;
        const target = destination?.[0];
        if (typeof target === "number") return true;
        if (target) {
          await document.getPageIndex(target);
          return true;
        }
      } catch {
        // Continue checking other entries before deciding the outline is unusable.
      }
    }
    if (await hasValidOutline(document, item.items)) return true;
  }
  return false;
}

async function openPdfOutlineDocument(source: { bytes: Uint8Array; password?: string }): Promise<OutlineDocument> {
  const loadingTask = getDocument({ data: source.bytes.slice(), ...(source.password ? { password: source.password } : {}) });
  const document = await loadingTask.promise;
  return {
    pageCount: document.numPages,
    hasValidEmbeddedOutline: await hasValidOutline(document, await document.getOutline()),
    async getNativeLines(pageNumber) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const fragments = content.items.flatMap((item) => {
        if (!("str" in item) || !item.str.trim()) return [];
        const transform = item.transform;
        return [{
          text: item.str,
          size: Math.abs(item.height) || Math.hypot(transform[0], transform[1]),
          x: transform[4],
          y: transform[5],
          width: Math.abs(item.width),
        }];
      });
      const groups: Array<typeof fragments> = [];
      for (const fragment of fragments.sort((left, right) => right.y - left.y || left.x - right.x)) {
        const group = groups.find((candidate) => Math.abs(candidate[0]!.y - fragment.y) <= 2);
        if (group) group.push(fragment); else groups.push([fragment]);
      }
      return groups.map((group) => {
        const sorted = group.sort((left, right) => left.x - right.x);
        let text = "";
        let endX: number | undefined;
        for (const fragment of sorted) {
          const gap = endX === undefined ? "" : fragment.x - endX > fragment.size * 0.45 ? " " : "";
          text += `${gap}${fragment.text}`;
          endX = fragment.x + fragment.width;
        }
        return { text, size: Math.max(...sorted.map((item) => item.size)), y: sorted[0]!.y };
      });
    },
    close: () => loadingTask.destroy(),
  };
}

export function createBookOutlineModule(
  dataHome: string,
  options: { openDocument?: OpenOutlineDocument } = {},
) {
  const database = new DatabaseSync(path.join(dataHome, "pdfmuse.db"));
  database.exec(`
    CREATE TABLE IF NOT EXISTS book_outline_pages (
      book_id TEXT NOT NULL,
      page INTEGER NOT NULL,
      candidates_json TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('native', 'ocr', 'empty')),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (book_id, page)
    );
    CREATE TABLE IF NOT EXISTS book_outlines (
      book_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      nodes_json TEXT NOT NULL,
      total_pages INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const openDocument = options.openDocument ?? openPdfOutlineDocument;

  function get(bookId: string): BookOutlineNode[] | undefined {
    if (!BOOK_ID_PATTERN.test(bookId)) return undefined;
    const row = database.prepare("SELECT nodes_json, updated_at FROM book_outlines WHERE book_id = ? AND version = ?")
      .get(bookId, OUTLINE_VERSION) as StoredOutlineRow | undefined;
    if (!row) return undefined;
    try {
      const nodes = JSON.parse(row.nodes_json) as BookOutlineNode[];
      return Array.isArray(nodes) ? nodes : undefined;
    } catch {
      return undefined;
    }
  }

  function invalidate(bookId: string, page?: number) {
    if (!BOOK_ID_PATTERN.test(bookId)) return;
    database.prepare("DELETE FROM book_outlines WHERE book_id = ?").run(bookId);
    if (page && Number.isSafeInteger(page) && page > 0) {
      database.prepare("DELETE FROM book_outline_pages WHERE book_id = ? AND page = ?").run(bookId, page);
    } else {
      database.prepare("DELETE FROM book_outline_pages WHERE book_id = ?").run(bookId);
    }
  }

  async function rebuild(
    bookId: string,
    loadBook: () => Promise<{ bytes: Uint8Array; password?: string }>,
    signal?: AbortSignal,
    onProgress?: (processedPages: number, totalPages: number) => void,
  ) {
    if (!BOOK_ID_PATTERN.test(bookId)) throw new Error("书籍目录任务参数无效。");
    const document = await openDocument(await loadBook());
    try {
      if (document.hasValidEmbeddedOutline) {
        invalidate(bookId);
        return { status: "embedded" as const, nodes: [], processedPages: 0, totalPages: document.pageCount };
      }
      const coverage = database.prepare(`
        SELECT COUNT(*) AS count, MAX(page) AS max_page
        FROM book_outline_pages WHERE book_id = ?
      `).get(bookId) as { count: number; max_page: number | null };
      const contiguous = coverage.count === (coverage.max_page ?? 0);
      let processedPages = contiguous ? coverage.count : 0;
      if (!contiguous) database.prepare("DELETE FROM book_outline_pages WHERE book_id = ?").run(bookId);
      const recognized = database.prepare("SELECT lines_json FROM recognized_pages WHERE book_id = ? AND page = ?");
      const upsert = database.prepare(`
        INSERT INTO book_outline_pages (book_id, page, candidates_json, source, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(book_id, page) DO UPDATE SET
          candidates_json = excluded.candidates_json,
          source = excluded.source,
          updated_at = excluded.updated_at
      `);
      for (let page = processedPages + 1; page <= document.pageCount; page += 1) {
        if (signal?.aborted) break;
        const native = await document.getNativeLines(page);
        const ocrRow = recognized.get(bookId, page) as { lines_json: string } | undefined;
        const ocr = ocrRow ? recognizedLines(ocrRow.lines_json) : [];
        const nativeTextLength = native
          .filter((line) => !/^(?:第?\s*\d+\s*页|page\s+\d+(?:\s+of\s+\d+)?|\d+)$/i.test(normalizeLabel(line.text)))
          .reduce((total, line) => total + normalizeLabel(line.text).length, 0);
        const lines = nativeTextLength >= 16 || ocr.length === 0 ? native : ocr;
        const source = lines.length === 0 ? "empty" : lines === native ? "native" : "ocr";
        const candidates = detectHeadingCandidates(page, lines);
        upsert.run(bookId, page, JSON.stringify(candidates), source, new Date().toISOString());
        processedPages = page;
        onProgress?.(processedPages, document.pageCount);
      }
      if (processedPages < document.pageCount) {
        return { status: "partial" as const, nodes: get(bookId) ?? [], processedPages, totalPages: document.pageCount };
      }
      const rows = database.prepare(`
        SELECT page, candidates_json FROM book_outline_pages
        WHERE book_id = ? ORDER BY page ASC
      `).all(bookId) as CandidateRow[];
      const headings = rows.flatMap((row) => {
        try {
          const value = JSON.parse(row.candidates_json) as OutlineHeading[];
          return Array.isArray(value) ? value : [];
        } catch {
          return [];
        }
      });
      const nodes = buildOutlineTree(headings, document.pageCount);
      const timestamp = new Date().toISOString();
      database.prepare(`
        INSERT INTO book_outlines (book_id, version, nodes_json, total_pages, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(book_id) DO UPDATE SET
          version = excluded.version,
          nodes_json = excluded.nodes_json,
          total_pages = excluded.total_pages,
          updated_at = excluded.updated_at
      `).run(bookId, OUTLINE_VERSION, JSON.stringify(nodes), document.pageCount, timestamp);
      return { status: "generated" as const, nodes, processedPages, totalPages: document.pageCount };
    } finally {
      await document.close();
    }
  }

  return {
    get,
    invalidate,
    rebuild,
    close() { database.close(); },
  };
}

export type BookOutlineModule = ReturnType<typeof createBookOutlineModule>;
