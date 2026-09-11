import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import type { BookOutlineNode, RecognizedTextLine } from "../shared/contracts.js";

const BOOK_ID_PATTERN = /^[a-f0-9]{64}$/;
const OUTLINE_VERSION = 2;
const MAX_HEADINGS = 240;
const MIN_TOC_NUMBERED_ROWS = 4;
const MIN_TOC_DISTINCT_PAGES = 3;
const MIN_TOC_EXPLICIT_LABELS = 2;
const MIN_TOC_ROWS = 3;
const MIN_OFFSET_VOTES = 2;
const REPEATED_LABEL_PAGES = 3;

export type OutlineTextLine = { text: string; size: number; y: number; x?: number };
export type OutlineHeading = { label: string; page: number; level: number; explicit: boolean };
export type TocRow = {
  label: string;
  printedPage: number | undefined;
  type: "chapter" | "section";
  ordinal: number;
  /** 所属章序号：数字编号节（1.2）自带；中文节序（第X节）由上下文补齐。 */
  scope?: number;
};
export type PageOutlineData = { page: number; headings: OutlineHeading[]; tocRows: TocRow[] };
export type AssembledOutline = { nodes: BookOutlineNode[]; strategy: "toc" | "heuristic" };

export type OutlineDocument = {
  pageCount: number;
  hasValidEmbeddedOutline: boolean;
  getNativeLines(page: number): Promise<OutlineTextLine[]>;
  close(): Promise<void>;
};

export type OpenOutlineDocument = (
  source: { bytes: Uint8Array; password?: string },
) => Promise<OutlineDocument>;

function isOutlineHeading(value: unknown): value is OutlineHeading {
  if (!value || typeof value !== "object") return false;
  const heading = value as Partial<OutlineHeading>;
  return typeof heading.label === "string"
    && typeof heading.page === "number"
    && typeof heading.level === "number"
    && typeof heading.explicit === "boolean";
}

function isTocRowValue(value: unknown): value is TocRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<TocRow>;
  return typeof row.label === "string"
    && (row.printedPage === undefined || typeof row.printedPage === "number")
    && (row.type === "chapter" || row.type === "section")
    && typeof row.ordinal === "number";
}

/** 页候选载荷以 v 字段自报版本；旧格式（数组或缺 v）一概视为过期，不复用。 */
function isStalePagePayload(json: string): boolean {
  try {
    const value: unknown = JSON.parse(json);
    if (Array.isArray(value)) return true;
    return !value || typeof value !== "object" || (value as { v?: unknown }).v !== OUTLINE_VERSION;
  } catch {
    return true;
  }
}

/** 页候选载荷解析：当前版本为 {v, headings, toc}，过期/损坏载荷按空页处理。 */
function parsePagePayload(page: number, json: string): PageOutlineData {
  if (isStalePagePayload(json)) return { page, headings: [], tocRows: [] };
  try {
    const payload = JSON.parse(json) as { headings?: unknown; toc?: unknown };
    return {
      page,
      headings: Array.isArray(payload.headings) ? payload.headings.filter(isOutlineHeading) : [],
      tocRows: Array.isArray(payload.toc) ? payload.toc.filter(isTocRowValue) : [],
    };
  } catch {
    // 损坏的载荷按空页处理，下一次 OCR/重建会覆盖。
  }
  return { page, headings: [], tocRows: [] };
}

type CandidateRow = { page: number; candidates_json: string };
type StoredOutlineRow = { nodes_json: string; updated_at: string };

function normalizeLabel(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function countCjk(label: string) {
  return (label.match(/[\u4e00-\u9fff]/g) ?? []).length;
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function chineseNumeral(text: string): number | undefined {
  if (/^\d+$/.test(text)) return Number(text);
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (![...text].every((c) => c in digits || c === "十" || c === "百")) return undefined;
  let total = 0;
  let current = 0;
  for (const c of text) {
    if (c in digits) current = digits[c]!;
    else if (c === "十") { total += (current || 1) * 10; current = 0; }
    else { total += (current || 1) * 100; current = 0; }
  }
  return total + current || undefined;
}

function romanNumeral(text: string): number | undefined {
  const values: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
  const lower = text.toLowerCase();
  if (!/^[ivxlcdm]+$/.test(lower)) return undefined;
  let total = 0;
  for (let i = 0; i < lower.length; i += 1) {
    const value = values[lower[i]!]!;
    total += value < (values[lower[i + 1] ?? ""] ?? 0) ? -value : value;
  }
  return total || undefined;
}

export type OutlineOrdinal = { type: "chapter" | "section"; ordinal: number; scope?: number };

/** 从标签前缀解析「第X章 / 第X节 / Chapter N / 1.2」的类别与序数，用于跨 OCR 错认的稳定身份匹配。
 *  数字编号节（1.2）自带所属章 scope；三段编号（1.2.1）不算节身份。 */
export function parseOutlineOrdinal(label: string): OutlineOrdinal | undefined {
  const chinese = label.match(/^第\s*([一二三四五六七八九十百零〇两\d]+)\s*([部篇章节])/);
  if (chinese) {
    const ordinal = chineseNumeral(chinese[1]!);
    if (ordinal) return { type: chinese[2] === "节" ? "section" : "chapter", ordinal };
  }
  const english = label.match(/^(?:part|chapter|appendix|section)\s+(\d+|[ivxlcdm]+)\b/i);
  if (english) {
    const raw = english[1]!;
    const ordinal = /^\d+$/.test(raw) ? Number(raw) : romanNumeral(raw);
    if (ordinal) return { type: english[0]!.toLowerCase().startsWith("section") ? "section" : "chapter", ordinal };
  }
  const numbered = label.match(/^([1-9]\d?)\s*[.．]\s*([1-9]\d{0,2})(?![.\d])/);
  if (numbered) return { type: "section", ordinal: Number(numbered[2]!), scope: Number(numbered[1]!) };
  return undefined;
}

function explicitLevel(label: string) {
  if (/^(?:part|chapter|appendix)\s+(?:\d+|[ivxlcdm]+|[a-z])\b/i.test(label)) return 1;
  if (/^section\s+(?:\d+|[ivxlcdm]+|[a-z])\b/i.test(label)) return 2;
  const chinese = label.match(/^第[一二三四五六七八九十百零〇两\d]+([部篇章节节])/);
  if (chinese) return chinese[1] === "节" ? 2 : 1;
  const numbered = label.match(/^(\d+(?:\.\d+){0,3})(?=[\s、.．]+\S)/);
  if (numbered) {
    const segments = numbered[1]!.split(".").length;
    return segments >= 2 ? Math.min(3, segments) : undefined;
  }
  return undefined;
}

function usableLines(lines: readonly OutlineTextLine[]): OutlineTextLine[] {
  return lines
    .map((line) => ({ ...line, text: normalizeLabel(line.text) }))
    .filter((line) => line.text && Number.isFinite(line.size) && line.size > 0);
}

export function detectHeadingCandidates(page: number, lines: readonly OutlineTextLine[]): OutlineHeading[] {
  const usable = usableLines(lines);
  // 正文字号只从「长中文/长英文」行估计：数学碎片行（√2、y4 之类）会把页内中位数拉低，导致随机行通过比值阈值。
  const bodyLines = usable.filter((line) => countCjk(line.text) >= 4 || /[A-Za-z]{6,}/.test(line.text));
  const sizeSource = bodyLines.length >= 3 ? bodyLines : usable;
  const sizes = sizeSource.map((line) => line.size).sort((left, right) => left - right);
  const bodySize = median(sizes.slice(0, Math.max(1, Math.floor(sizes.length * 0.75)))) || 1;
  return usable.flatMap((line) => {
    if (line.text.length < 2 || line.text.length > 100) return [];
    if (/^(?:第?\s*\d+\s*页|page\s+\d+(?:\s+of\s+\d+)?)$/i.test(line.text)) return [];
    if (/^\d+$/.test(line.text) || /\.{3,}\s*\d+$/.test(line.text)) return [];
    const explicit = explicitLevel(line.text);
    const ratio = line.size / bodySize;
    if (!explicit && ratio < 1.32) return [];
    if (!explicit && /[。！？!?；;:]$/.test(line.text)) return [];
    if (!explicit) {
      const latin = (line.text.match(/[A-Za-z]/g) ?? []).length;
      if (countCjk(line.text) < 4 && latin < 6) return [];
    }
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

function cleanTocLabel(value: string) {
  return value.replace(/[\s.·…]+$/g, "").replace(/\s+/g, " ").trim();
}

const ORDINAL_SEGMENT = /(?:第[一二三四五六七八九十百零〇两\d]+[部篇章节]|(?:part|chapter|appendix|section)\s+(?:\d+|[ivxlcdm]+))/ig;

/** 无 x 坐标时聚行片段可能乱序（「极限运算法则 第五节」）：把序数段旋转到行首再解析身份。
 *  仅旋转空格分隔的序数段——正文里 glued 的「在第五节中……」不是独立标签。 */
function rotateOrdinalSegment(label: string): string {
  ORDINAL_SEGMENT.lastIndex = 0;
  const match = ORDINAL_SEGMENT.exec(label);
  if (!match?.index) return label;
  const before = match.index === 0 || label[match.index - 1] === " ";
  const after = match.index + match[0].length === label.length || label[match.index + match[0].length] === " ";
  if (!before || !after) return label;
  const segment = match[0]!;
  const rest = `${label.slice(0, match.index)} ${label.slice(match.index + segment.length)}`;
  return `${segment} ${rest}`.replace(/\s+/g, " ").trim();
}

/** 行尾印刷页码：优先 (n)/（n），其次点引导「……37」，最后是紧贴或单个空格跟在中文字后的数字。 */
function trailingPrintedPage(text: string): { label: string; page: number } | undefined {
  const paren = text.match(/^(.+?)[\s.·…]*[（(]\s*(\d{1,4})\s*[)）]\s*$/);
  if (paren?.[1]?.trim()) return { label: paren[1]!, page: Number(paren[2]) };
  const dotted = text.match(/^(.+?)[\s.·…]{2,}(\d{1,4})\s*$/);
  if (dotted?.[1]?.trim()) return { label: dotted[1]!, page: Number(dotted[2]) };
  const glued = text.match(/^(.+?[\u4e00-\u9fff])[ ]?(\d{1,3})\s*$/);
  if (glued?.[1]?.trim()) return { label: glued[1]!, page: Number(glued[2]) };
  return undefined;
}

/** 行内首个页码（一、/习题 行的 (n)）：给无页码的上一级目录行做下界提示。 */
function firstNumberIn(text: string): number | undefined {
  const paren = text.match(/[（(]\s*(\d{1,4})\s*[)）]/);
  if (paren) return Number(paren[1]);
  const dotted = text.match(/[\u4e00-\u9fff][\s.·…]{2,}(\d{1,4})(?:\s|$)/);
  if (dotted) return Number(dotted[1]);
  return undefined;
}

function clusterTocBands(lines: readonly OutlineTextLine[]): string[] {
  const sorted = [...lines].sort((left, right) => left.y - right.y || (left.x ?? 0) - (right.x ?? 0));
  const bands: Array<{ fragments: OutlineTextLine[]; top: number; bottom: number }> = [];
  for (const line of sorted) {
    const top = line.y;
    const bottom = line.y + line.size;
    const last = bands.at(-1);
    if (last && Math.min(last.bottom, bottom) - Math.max(last.top, top) > 0.5 * Math.min(last.bottom - last.top, line.size)) {
      last.fragments.push(line);
      last.top = Math.min(last.top, top);
      last.bottom = Math.max(last.bottom, bottom);
    } else {
      bands.push({ fragments: [line], top, bottom });
    }
  }
  return bands.map((band) => {
    const fragments = band.fragments.every((fragment) => fragment.x !== undefined)
      ? [...band.fragments].sort((left, right) => left.x! - right.x!)
      : band.fragments;
    return fragments.map((fragment) => fragment.text).join(" ").replace(/\s+/g, " ").trim();
  });
}

/** 目录行标签得像标题：条款句（以句读结尾或整句过长）不是目录行。 */
function plausibleTocLabel(label: string) {
  if (label.length > 40) return false;
  return !/[。！？!?；;：:，、,]$/.test(label);
}

/**
 * 收割印刷目录页：按 y 重叠聚成视觉行，解析「标题 + 印刷页码」。
 * 只保留章/节两级；无页码的行从同页后续的 一、/习题 行号取下界提示。
 */
export function harvestTocRows(lines: readonly OutlineTextLine[]): { tocPage: boolean; rows: TocRow[] } {
  const usable = usableLines(lines);
  const explicitLabels = usable.filter((line) => parseOutlineOrdinal(line.text)).length;
  const entries: Array<{ row: TocRow } | { hint: number }> = [];
  for (const text of clusterTocBands(usable)) {
    const trailing = trailingPrintedPage(text);
    const labelText = rotateOrdinalSegment(trailing?.label ?? text);
    const ordinal = parseOutlineOrdinal(labelText);
    if (ordinal) {
      const label = cleanTocLabel(labelText);
      if (plausibleTocLabel(label)) {
        entries.push({ row: { label, printedPage: trailing?.page, ...ordinal } });
        continue;
      }
    }
    const hint = firstNumberIn(text) ?? (/^\d{1,4}$/.test(text) ? Number(text) : undefined);
    if (hint !== undefined) entries.push({ hint });
  }
  const rows: TocRow[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (!("row" in entry)) continue;
    if (entry.row.printedPage !== undefined) {
      rows.push(entry.row);
      continue;
    }
    let resolved: number | undefined;
    for (let next = index + 1; next < entries.length; next += 1) {
      const candidate = entries[next]!;
      if ("hint" in candidate) { resolved = candidate.hint; break; }
    }
    rows.push({ ...entry.row, printedPage: resolved });
  }
  // 条款编号（9.2、10.1）会撞出零星「带页码序数行」，但页码来自句中 (1) 之类；
  // 真目录页的特征是带页码行成片出现且页码递增散布。
  const numberedRows = rows.filter((row) => row.printedPage !== undefined);
  const distinctPages = new Set(numberedRows.map((row) => row.printedPage)).size;
  if (numberedRows.length < MIN_TOC_NUMBERED_ROWS
    || distinctPages < MIN_TOC_DISTINCT_PAGES
    || explicitLabels < MIN_TOC_EXPLICIT_LABELS) {
    return { tocPage: false, rows: [] };
  }
  return { tocPage: true, rows };
}

/** 统计每个标签（小写归一）出现在哪些页，供重复页眉判定。 */
function countLabelPages(headings: readonly OutlineHeading[]): Map<string, Set<number>> {
  const labelPages = new Map<string, Set<number>>();
  for (const heading of headings) {
    const key = heading.label.toLocaleLowerCase();
    const pages = labelPages.get(key) ?? new Set<number>();
    pages.add(heading.page);
    labelPages.set(key, pages);
  }
  return labelPages;
}

/**
 * 页眉抑制：章/节序号身份在全书（页序）内只保留首次出现——真标题必然先于它的页眉出现；
 * 非序号标题在 ≥3 页重复出现视为页眉/页脚。
 */
function suppressRunningHeaders(headings: readonly OutlineHeading[]): OutlineHeading[] {
  const labelPages = countLabelPages(headings);
  const seenScoped = new Set<string>();
  let chapterScope = 0;
  const kept: OutlineHeading[] = [];
  for (const heading of headings) {
    const ordinal = parseOutlineOrdinal(heading.label);
    if (ordinal) {
      if (ordinal.type === "chapter") chapterScope = ordinal.ordinal;
      const key = ordinalKey(ordinal, chapterScope);
      if (seenScoped.has(key)) continue;
      seenScoped.add(key);
      kept.push(heading);
      continue;
    }
    if ((labelPages.get(heading.label.toLocaleLowerCase())?.size ?? 0) >= REPEATED_LABEL_PAGES) continue;
    kept.push(heading);
  }
  return kept;
}

function ordinalKey(ordinal: OutlineOrdinal, contextualScope: number) {
  return ordinal.type === "chapter" ? `c${ordinal.ordinal}` : `s${ordinal.scope ?? contextualScope}.${ordinal.ordinal}`;
}

/** 印刷页码 → PDF 页码偏移：正文锚点（真标题页）减去目录行印刷页码，按出现次数投票。 */
function resolvePageOffset(tocRows: readonly TocRow[], bodyHeadings: readonly OutlineHeading[]): number | undefined {
  const rowsByKey = new Map<string, number>();
  let scope = 0;
  for (const row of tocRows) {
    if (row.type === "chapter") scope = row.ordinal;
    const key = ordinalKey(row, scope);
    if (row.printedPage !== undefined && !rowsByKey.has(key)) rowsByKey.set(key, row.printedPage);
  }
  const votes = new Map<number, number>();
  let anchorScope = 0;
  for (const heading of bodyHeadings) {
    const ordinal = parseOutlineOrdinal(heading.label);
    if (!ordinal) continue;
    if (ordinal.type === "chapter") anchorScope = ordinal.ordinal;
    const printed = rowsByKey.get(ordinalKey(ordinal, anchorScope));
    if (printed === undefined) continue;
    const offset = heading.page - printed;
    votes.set(offset, (votes.get(offset) ?? 0) + 1);
  }
  let bestOffset: number | undefined;
  let bestVotes = 0;
  for (const [offset, count] of votes) {
    if (count > bestVotes) { bestVotes = count; bestOffset = offset; }
  }
  return bestVotes >= MIN_OFFSET_VOTES ? bestOffset : undefined;
}

function buildTocNodes(tocRows: readonly TocRow[], offset: number, pageCount: number): BookOutlineNode[] {
  type Entry = { label: string; page: number | undefined; type: "chapter" | "section" };
  const entries: Entry[] = [];
  const seen = new Set<string>();
  let scope = 0;
  for (const row of tocRows) {
    if (row.type === "chapter") scope = row.ordinal;
    const key = ordinalKey(row, scope);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      label: row.label,
      page: row.printedPage === undefined ? undefined : row.printedPage + offset,
      type: row.type,
    });
  }
  const inRange = (page: number | undefined) => page !== undefined && page >= 1 && page <= pageCount;
  const resolved = entries.map((entry, index) => {
    // 已解析但越界的条目直接裁剪（超出本 PDF 范围），继承只用于 OCR 丢失页码的行。
    if (entry.page !== undefined) return entry;
    if (entry.type === "section") {
      for (let prior = index - 1; prior >= 0; prior -= 1) if (inRange(entries[prior]!.page)) return { ...entry, page: entries[prior]!.page };
      for (let next = index + 1; next < entries.length; next += 1) if (inRange(entries[next]!.page)) return { ...entry, page: entries[next]!.page };
    } else {
      for (let next = index + 1; next < entries.length; next += 1) if (inRange(entries[next]!.page)) return { ...entry, page: entries[next]!.page };
      for (let prior = index - 1; prior >= 0; prior -= 1) if (inRange(entries[prior]!.page)) return { ...entry, page: entries[prior]!.page };
    }
    return entry;
  });
  const roots: BookOutlineNode[] = [];
  const orphans: BookOutlineNode[] = [];
  let currentChapter: BookOutlineNode | undefined;
  let sequence = 0;
  for (const entry of resolved) {
    if (!inRange(entry.page)) continue;
    const node: BookOutlineNode = { id: `toc-${++sequence}`, label: entry.label, page: entry.page, children: [] };
    if (entry.type === "chapter") {
      roots.push(node);
      currentChapter = node;
    } else if (currentChapter) {
      currentChapter.children.push(node);
    } else {
      orphans.push(node);
    }
  }
  return [...orphans, ...roots];
}

/** 全书装配：有可信印刷目录走 TOC 策略（偏移投票 + 越界裁剪），否则回退硬化启发式。 */
export function assembleOutline(pages: readonly PageOutlineData[], pageCount: number): AssembledOutline {
  const ordered = [...pages].sort((left, right) => left.page - right.page);
  const tocRows = ordered.flatMap((entry) => entry.tocRows);
  const bodyHeadings = suppressRunningHeaders(ordered.flatMap((entry) => entry.headings));
  const offset = tocRows.length >= MIN_TOC_ROWS ? resolvePageOffset(tocRows, bodyHeadings) : undefined;
  if (offset !== undefined) return { nodes: buildTocNodes(tocRows, offset, pageCount), strategy: "toc" };
  return { nodes: buildOutlineTree(bodyHeadings, pageCount), strategy: "heuristic" };
}

export function buildOutlineTree(headings: readonly OutlineHeading[], pageCount: number): BookOutlineNode[] {
  const labelPages = countLabelPages(headings);
  const roots: BookOutlineNode[] = [];
  const stack: Array<{ level: number; node: BookOutlineNode }> = [];
  const seen = new Set<string>();
  for (const heading of headings.slice(0, MAX_HEADINGS)) {
    const key = heading.label.toLocaleLowerCase();
    if (heading.page < 1 || heading.page > pageCount) continue;
    if (!heading.explicit && (labelPages.get(key)?.size ?? 0) >= REPEATED_LABEL_PAGES) continue;
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
      const xs = line.polygon.map((point) => point?.x).filter((x): x is number => typeof x === "number" && Number.isFinite(x));
      if (ys.length < 3) return [];
      return [{
        text: line.text,
        size: Math.max(...ys) - Math.min(...ys),
        y: Math.min(...ys),
        ...(xs.length >= 1 ? { x: Math.min(...xs) } : {}),
      }];
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
        return { text, size: Math.max(...sorted.map((item) => item.size)), y: sorted[0]!.y, x: sorted[0]!.x };
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
      // 检测逻辑随版本演进：载荷版本不一致（含 v1 中断留下的旧格式候选）时整体作废重算。
      const newestPayload = database.prepare(
        "SELECT candidates_json FROM book_outline_pages WHERE book_id = ? ORDER BY page DESC LIMIT 1",
      ).get(bookId) as { candidates_json: string } | undefined;
      if (newestPayload && isStalePagePayload(newestPayload.candidates_json)) {
        database.prepare("DELETE FROM book_outline_pages WHERE book_id = ?").run(bookId);
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
        const { tocPage, rows } = harvestTocRows(lines);
        // 目录页不再向正文候选贡献标题——否则整页目录条目会以「章/节」身份淹没真标题。
        const headings = tocPage ? [] : detectHeadingCandidates(page, lines);
        upsert.run(bookId, page, JSON.stringify({ v: OUTLINE_VERSION, headings, toc: rows }), source, new Date().toISOString());
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
      const assembled = assembleOutline(rows.flatMap((row) => parsePagePayload(row.page, row.candidates_json)), document.pageCount);
      const nodes = assembled.nodes;
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
