import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import {
  aiOutlineEntryKey,
  generateAiOutline,
  type AiOutlineComplete,
  type AiOutlineEntry,
  type PageTextSource,
  type TocPageText,
} from "./agent/outline-ai.js";
import type { BookOutlineNode, BookOutlineStrategy, MineruBlock } from "../shared/contracts.js";

const BOOK_ID_PATTERN = /^[a-f0-9]{64}$/;
const OUTLINE_VERSION = 7;
const MAX_HEADINGS = 240;
const MIN_OFFSET_VOTES = 2;
const REPEATED_LABEL_PAGES = 3;

export type OutlineTextLine = { text: string; size: number; y: number };
/** 正文标题候选：anchorTop 为该标题行的页内位置（PDF 用户空间 Y，原生行直收、OCR 块换算），
 *  沿锚点管线写进目录节点供跳转精确定位；拿不到时缺省（跳页顶）。 */
export type OutlineHeading = { label: string; page: number; level: number; explicit: boolean; anchorTop?: number };
export type TocRow = { label: string; level: 1 | 2 | 3; printedPage: number | undefined };
export type AssembledOutline = { nodes: BookOutlineNode[]; strategy: BookOutlineStrategy };
export type AiOutlineCache = { entries: AiOutlineEntry[]; tocPages: number[] };

export type OutlineDocument = {
  pageCount: number;
  getNativeLines(page: number): Promise<OutlineTextLine[]>;
  /** 页面用户空间高度（OCR 块的归一化 bbox 换算页内锚点用）；不可得时 OCR 标题不带锚点。 */
  getPageHeight?(page: number): Promise<number>;
  /** 内嵌书签节点树（已解析跳转目标与页内锚点，无书签为空数组）。主进程是唯一解析点，有效性由质量闸门从节点推导。 */
  getEmbeddedNodes(): Promise<BookOutlineNode[]>;
  close(): Promise<void>;
};

export type OpenOutlineDocument = (
  source: { bytes: Uint8Array; password?: string },
) => Promise<OutlineDocument>;

export type BookOutlineAiDeps = {
  renderPage(bookId: string, page: number, scale: number): Promise<{ imageData: string }>;
  complete: AiOutlineComplete;
};

type CandidateRow = { page: number; candidates_json: string };

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

/** 从标签前缀解析「第X章 / 第X节 / 第一组 / 第X单元 / Chapter N / 1.2」的类别与序数，
 *  用于跨 OCR 错认的稳定身份匹配。数字编号节（1.2）自带所属章 scope；三段编号（1.2.1）不算节身份。 */
export function parseOutlineOrdinal(label: string): OutlineOrdinal | undefined {
  const chinese = label.match(/^第\s*([一二三四五六七八九十百零〇两\d]+)\s*(部|篇|章|节|组|单元)/);
  if (chinese) {
    const ordinal = chineseNumeral(chinese[1]!);
    if (ordinal) return { type: chinese[2] === "节" ? "section" : "chapter", ordinal };
  }
  const english = label.match(/^(?:part|chapter|appendix|unit|section)\s+(\d+|[ivxlcdm]+)\b/i);
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
  if (/^(?:part|chapter|appendix|unit)\s+(?:\d+|[ivxlcdm]+|[a-z])\b/i.test(label)) return 1;
  if (/^section\s+(?:\d+|[ivxlcdm]+|[a-z])\b/i.test(label)) return 2;
  const chinese = label.match(/^第[一二三四五六七八九十百零〇两\d]+(部|篇|章|节|组|单元)/);
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
      // 拼音注音括号是教材课文标题的签名（「窃(qiè)读记」），数学碎片不会带它。
      if (countCjk(line.text) < 4 && latin < 6 && !PINYIN_ANNOTATION.test(line.text)) return [];
    }
    const level = explicit ?? (ratio >= 1.7 ? 1 : ratio >= 1.42 ? 2 : 3);
    return [{ label: line.text, page, level, explicit: explicit !== undefined, anchorTop: line.y }];
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

/**
 * 查找某页所在的顶层章节页码范围，供检索做章节范围加权。
 * 所在章 = 顶层节点中起点不晚于该页的最大起点；章尾取下一章起点前页，
 * 末章到 totalPages 截断；首页之前没有起点返回 undefined。
 */
export function findOutlineChapterRange(
  nodes: readonly BookOutlineNode[],
  page: number,
  totalPages: number,
): { from: number; to: number } | undefined {
  const starts: number[] = [];
  for (const node of nodes) {
    if (node.page === undefined || !Number.isSafeInteger(node.page) || node.page < 1) continue;
    if (!starts.includes(node.page)) starts.push(node.page);
  }
  const sorted = starts.sort((left, right) => left - right);
  let chapterStart: number | undefined;
  let nextStart: number | undefined;
  for (const start of sorted) {
    if (start <= page) chapterStart = start;
    else {
      nextStart = start;
      break;
    }
  }
  if (chapterStart === undefined) return undefined;
  return { from: chapterStart, to: Math.min(totalPages, (nextStart ?? totalPages + 1) - 1) };
}

/** 拼音注音括号（「窃(qiè)读记」）：教材课文标题的签名。test 用无 g 实例（避免 lastIndex 状态），replace 用全局实例。 */
const PINYIN_ANNOTATION_SOURCE = "\\([a-zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜü]{1,8}\\)";
const PINYIN_ANNOTATION = new RegExp(PINYIN_ANNOTATION_SOURCE);
const PINYIN_ANNOTATION_GLOBAL = new RegExp(PINYIN_ANNOTATION_SOURCE, "g");

function normalizeOutlineTitle(label: string) {
  return label
    .replace(PINYIN_ANNOTATION_GLOBAL, "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
}

/** 剥掉标签的序数/课文号前缀后的稳定标题键：正文「窃(qiè)读记」与目录「1 窃读记」同键。 */
function outlineTitleKey(label: string): string | undefined {
  const stripped = label
    .replace(/^第[一二三四五六七八九十百零〇两\d]+(?:部|篇|章|节|组|单元)\s*/, "")
    .replace(/^(?:part|chapter|appendix|unit|section)\s+(?:\d+|[ivxlcdm]+)\b\s*/i, "")
    .replace(/^[1-9]\d?\s*[.．]\s*[1-9]\d{0,2}(?![.\d])\s*/, "")
    .replace(/^[1-9]\d?\s*\*?\s*[\s.．]?\s*/, "");
  const key = normalizeOutlineTitle(stripped || label);
  return key.length >= 2 ? key : undefined;
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
 * 非序数标签在 ≥3 页重复出现同样视为页眉/页脚签名，只保留首现页——特名章（如「参考文献」
 * 兼作页眉）的真身就在首现页，后续重复才是页眉。
 */
function suppressRunningHeaders(headings: readonly OutlineHeading[]): OutlineHeading[] {
  const labelPages = countLabelPages(headings);
  const seenScoped = new Set<string>();
  const seenRepeated = new Set<string>();
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
    const labelKey = heading.label.toLocaleLowerCase();
    if ((labelPages.get(labelKey)?.size ?? 0) >= REPEATED_LABEL_PAGES) {
      if (seenRepeated.has(labelKey)) continue;
      seenRepeated.add(labelKey);
    }
    kept.push(heading);
  }
  return kept;
}

function ordinalKey(ordinal: OutlineOrdinal, contextualScope: number) {
  return ordinal.type === "chapter" ? `c${ordinal.ordinal}` : `s${ordinal.scope ?? contextualScope}.${ordinal.ordinal}`;
}

/** 锚点命中：正文标题的所在页 + 页内位置（top 为用户空间 Y，来源行拿不到时缺省）。 */
type OutlineAnchorHit = { page: number; top?: number };

type OutlineAnchors = {
  /** 序数身份（章/节 key）→ 正文首次出现锚点。 */
  byKey: Map<string, OutlineAnchorHit>;
  /** 剥前缀标题键 → 正文首次出现锚点（课文标题常带拼音注音，序数身份不可用时兜底）。 */
  byTitle: Map<string, OutlineAnchorHit>;
};

function collectAnchors(bodyHeadings: readonly OutlineHeading[]): OutlineAnchors {
  const byKey = new Map<string, OutlineAnchorHit>();
  const byTitle = new Map<string, OutlineAnchorHit>();
  let chapterScope = 0;
  for (const heading of bodyHeadings) {
    const ordinal = parseOutlineOrdinal(heading.label);
    if (ordinal) {
      if (ordinal.type === "chapter") chapterScope = ordinal.ordinal;
      const key = ordinalKey(ordinal, chapterScope);
      if (!byKey.has(key)) byKey.set(key, { page: heading.page, ...(heading.anchorTop !== undefined ? { top: heading.anchorTop } : {}) });
    }
    const title = outlineTitleKey(heading.label);
    if (title && !byTitle.has(title)) byTitle.set(title, { page: heading.page, ...(heading.anchorTop !== undefined ? { top: heading.anchorTop } : {}) });
  }
  return { byKey, byTitle };
}

export type PrintedPageVote = { page: number; printed: number };

/** 印刷页码 → PDF 页码偏移解算（锚点一致性择峰，T58-02）。票分三类：
 *  正文锚点票（真标题页 − 目录行印刷页码，地面真值——序数身份优先、剥前缀标题兜底、
 *  每行只投一票）、正文页脚票（page_number 块 / 原生孤立数字行）、目录页自身页脚票
 *  （独立编号序列，污染源）。裁定序：锚点多数簇（锚点与票簇冲突听锚点；锚点簇的
 *  平票与阈值都不引目录票——污染源不得反客为主）→ 正文页脚多数簇 → 目录页脚兜底
 *  （前两类全缺的老书场景，阈值计目录票）。多峰书（分部重启页码）与长前言序列由此吸收。 */
function resolvePageOffset(
  tocRows: readonly TocRow[],
  anchors: OutlineAnchors,
  printedVotes: readonly PrintedPageVote[] = [],
  tocPageSet: ReadonlySet<number> = new Set(),
): number | undefined {
  const support = new Map<number, { anchor: number; body: number; toc: number }>();
  const tally = (offset: number, kind: "anchor" | "body" | "toc") => {
    const entry = support.get(offset) ?? { anchor: 0, body: 0, toc: 0 };
    entry[kind] += 1;
    support.set(offset, entry);
  };
  for (const observed of printedVotes) {
    if (Number.isSafeInteger(observed.printed) && observed.printed >= 0 && observed.page >= 1) {
      tally(observed.page - observed.printed, tocPageSet.has(observed.page) ? "toc" : "body");
    }
  }
  let chapterScope = 0;
  for (const row of tocRows) {
    const ordinal = parseOutlineOrdinal(row.label);
    if (ordinal?.type === "chapter") chapterScope = ordinal.ordinal;
    if (row.printedPage === undefined) continue;
    const ordinalAnchor = ordinal ? anchors.byKey.get(ordinalKey(ordinal, chapterScope)) : undefined;
    const title = outlineTitleKey(row.label);
    const titleAnchor = title ? anchors.byTitle.get(title) : undefined;
    const anchorHit = ordinalAnchor ?? titleAnchor;
    if (anchorHit !== undefined) tally(anchorHit.page - row.printedPage, "anchor");
  }
  // 类内多数簇；平票以锚点票 + 正文票合计破平（锚点/正文裁定时），目录兜底时以目录票破平。
  const pluralityOf = (kind: "anchor" | "body" | "toc"): number | undefined => {
    let best: { offset: number; classVotes: number; total: number } | undefined;
    for (const [offset, entry] of support) {
      const classVotes = entry[kind];
      if (classVotes <= 0) continue;
      const total = kind === "toc" ? entry.toc : entry.anchor + entry.body;
      if (!best || classVotes > best.classVotes || (classVotes === best.classVotes && total > best.total)) {
        best = { offset, classVotes, total };
      }
    }
    return best?.offset;
  };
  const confirmed = (offset: number | undefined, kind: "anchor" | "body" | "toc"): number | undefined => {
    if (offset === undefined) return undefined;
    const entry = support.get(offset)!;
    const confirming = kind === "toc" ? entry.toc : entry.anchor + entry.body;
    return confirming >= MIN_OFFSET_VOTES ? offset : undefined;
  };
  return confirmed(pluralityOf("anchor"), "anchor")
    ?? confirmed(pluralityOf("body"), "body")
    ?? confirmed(pluralityOf("toc"), "toc");
}

/** 栈式聚树（两档装配共用）：按 level 弹栈挂父；首个章之前的次级条目（目录排版上
 *  组标/章标常落在其首批条目之后）待首个章落位后归入第一个章，无章时平铺保序。 */
function assembleLevelTree(
  entries: ReadonlyArray<{ label: string; page: number; level: number; anchor?: { top: number } }>,
  idPrefix: string,
): BookOutlineNode[] {
  const roots: BookOutlineNode[] = [];
  const orphans: BookOutlineNode[] = [];
  const stack: BookOutlineNode[] = [];
  let sequence = 0;
  for (const entry of entries) {
    const node: BookOutlineNode = {
      id: `${idPrefix}-${++sequence}`,
      label: entry.label,
      page: entry.page,
      children: [],
      ...(entry.anchor ? { anchor: entry.anchor } : {}),
    };
    while (stack.length >= entry.level) stack.pop();
    if (stack.length > 0) {
      stack[stack.length - 1]!.children.push(node);
      stack.push(node);
    } else if (entry.level === 1) {
      roots.push(node);
      stack.push(node);
    } else {
      orphans.push(node);
    }
  }
  if (orphans.length > 0 && roots.length > 0) {
    roots[0]!.children = [...orphans, ...roots[0]!.children];
    return roots;
  }
  return [...orphans, ...roots];
}

function buildTocNodes(
  tocRows: readonly TocRow[],
  offset: number,
  pageCount: number,
  anchors: OutlineAnchors,
): BookOutlineNode[] {
  const inRange = (page: number | undefined) => page !== undefined && page >= 1 && page <= pageCount;
  type Entry = { label: string; page: number | undefined; level: 1 | 2 | 3; anchor?: { top: number } };
  const entries: Entry[] = [];
  const seen = new Set<string>();
  let chapterScope = 0;
  for (const row of tocRows.slice(0, MAX_HEADINGS)) {
    const dedupeKey = aiOutlineEntryKey(row);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const ordinal = parseOutlineOrdinal(row.label);
    if (ordinal?.type === "chapter") chapterScope = ordinal.ordinal;
    // 正文锚点页是最直接的观测（组单元页等常没有印刷页码可换算），其次印刷页 + 偏移。
    // 序数身份更精确，优先于标题键——不同小节可能共用相同短标题。
    const title = outlineTitleKey(row.label);
    const anchorHit = (ordinal ? anchors.byKey.get(ordinalKey(ordinal, chapterScope)) : undefined)
      ?? (title ? anchors.byTitle.get(title) : undefined);
    const anchored = anchorHit !== undefined && inRange(anchorHit.page);
    const offsetPage = row.printedPage === undefined ? undefined : row.printedPage + offset;
    entries.push({
      label: row.label,
      page: anchored ? anchorHit!.page : offsetPage,
      level: row.level,
      ...(anchored && anchorHit!.top !== undefined ? { anchor: { top: anchorHit!.top } } : {}),
    });
  }
  const resolved = entries.map((entry, index) => {
    // 已解析但越界的条目直接裁剪（超出本 PDF 范围），继承只用于页码缺失的行。
    if (entry.page !== undefined) return entry;
    if (entry.level >= 2) {
      for (let prior = index - 1; prior >= 0; prior -= 1) if (inRange(entries[prior]!.page)) return { ...entry, page: entries[prior]!.page };
      for (let next = index + 1; next < entries.length; next += 1) if (inRange(entries[next]!.page)) return { ...entry, page: entries[next]!.page };
    } else {
      for (let next = index + 1; next < entries.length; next += 1) if (inRange(entries[next]!.page)) return { ...entry, page: entries[next]!.page };
      for (let prior = index - 1; prior >= 0; prior -= 1) if (inRange(entries[prior]!.page)) return { ...entry, page: entries[prior]!.page };
    }
    return entry;
  });
  return assembleLevelTree(
    resolved.flatMap((entry) => (
      inRange(entry.page) ? [{ label: entry.label, page: entry.page!, level: entry.level, ...(entry.anchor ? { anchor: entry.anchor } : {}) }] : []
    )),
    "toc",
  );
}

/** 目录页定位输入：一页的文本行（原生文本行或识别块拆行）、是否含布局模型标记的 index 块、
 *  该页是否可判定（有原生文本或已有识别结果——空白页的空识别结果也算已判定）。 */
export type TocLocatorPageInput = { page: number; lines: readonly string[]; hasIndexBlock: boolean; covered: boolean };

const TOC_PROBE_WINDOW_PAGES = 30;

/** 探测窗口末端（窗口常量与书页数的单一出口）：证据闸门与目录定位共用。 */
function tocWindowEnd(pageCount: number) {
  return Math.min(pageCount, TOC_PROBE_WINDOW_PAGES);
}
const TOC_TEXT_LINE_CAP = 80;
const TOC_DENSITY_MIN_LINES = 4;
const TOC_MIN_LEADER_LINES = 3;
const TOC_LEADER_PATTERN = /\.{2,}|…+|_{4,}/;
const TOC_TRAILING_NUMBER_PATTERN = /(\d{1,4})\s*$/;

/** 点线引导 + 行尾页码为主、行尾数字占比为辅的目录页密度判定。
 *  OCR 对点线常吞字，所以行尾数字是独立信号；参考文献页的行尾数字密度也可能触发，
 *  误报由 AI 侧的 hasToc=false 契约吸收，代价有界。 */
function isDenseTocPage(lines: readonly string[]): boolean {
  const usable = lines
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length >= 4 && line.length <= 120);
  if (usable.length < TOC_DENSITY_MIN_LINES) return false;
  let leader = 0;
  let trailing = 0;
  for (const line of usable) {
    const endsWithNumber = TOC_TRAILING_NUMBER_PATTERN.test(line);
    if (endsWithNumber) trailing += 1;
    if (endsWithNumber && TOC_LEADER_PATTERN.test(line)) leader += 1;
  }
  return leader >= TOC_MIN_LEADER_LINES || trailing >= Math.max(TOC_MIN_LEADER_LINES + 1, Math.ceil(usable.length * 0.5));
}

/** 目录页定位：index 块命中 ∪ 文本密度命中；命中页扩 ±1 边距作为渲染候选（吸收布局模型
 *  漏标的相邻页），真实信号命中（hits）单独返回——tocPageSet 只信真实命中，不让边距吞掉
 *  紧邻目录页的正文标题。covered 表示窗口内每页都可判定（有原生文本或已有识别结果）。 */
export function locateTocPages(inputs: readonly TocLocatorPageInput[]): { hits: number[]; pages: number[]; covered: boolean } {
  const indexHits: number[] = [];
  const densityHits: number[] = [];
  for (const input of inputs) {
    if (input.hasIndexBlock) indexHits.push(input.page);
    else if (isDenseTocPage(input.lines)) densityHits.push(input.page);
  }
  // 密度是 index 无命中时的兜底（不并跑）：密集的非目录页（参考文献）不该借并选混进
  // tocPageSet，压制定位命中页之外的正文标题锚点。
  const hits = indexHits.length > 0 ? indexHits : densityHits;
  const candidates = new Set<number>();
  for (const hit of hits) {
    for (const page of [hit - 1, hit, hit + 1]) {
      if (page >= 1) candidates.add(page);
    }
  }
  return {
    hits,
    pages: [...candidates].sort((left, right) => left - right),
    covered: inputs.every((input) => input.covered),
  };
}

/** 单调性修复：目录条目页码沿阅读序应非递减，错锚/偏移漂移造成的倒挂按前值下限钳制。 */
export function repairOutlineMonotonicity(nodes: readonly BookOutlineNode[]): BookOutlineNode[] {
  let last = 0;
  const walk = (list: readonly BookOutlineNode[]): BookOutlineNode[] => list.map((node) => {
    let current = node;
    if (current.page !== undefined && current.page < last) current = { ...current, page: last };
    if (current.page !== undefined && current.page > last) last = current.page;
    return { ...current, children: walk(current.children) };
  });
  return walk(nodes);
}

/** 正文标题准入（第三档）：只收章节序数与公认特名——实测 paragraph_title 混有大量
 *  「（1）/N.」式列举项，无序数的裸标题也多为正文强调句，宁缺毋滥。 */
const KNOWN_SECTION_NAME = /^(附录|参考文献|索引|习题)/;
const RECOGNIZED_HEADING_TYPES = new Set(["title", "paragraph_title"]);

export function isAdmittedBodyHeading(label: string): boolean {
  return explicitLevel(label) !== undefined || KNOWN_SECTION_NAME.test(label);
}

/** OCR 页标题候选：布局模型标记的标题块直接判定（T57-06），替代「块高假装字号」的比值检测；
 *  header/footer/aside_text 等噪声块按类型整体排除。anchorTop 由块顶 bbox 按页高换算——
 *  MinerU bbox 为 y 向下的归一化坐标（y0 = 距页顶比例），用户空间 Y = (1 − y0) × 页高；
 *  页高未知时不猜（无锚点，跳页顶）。 */
export function detectRecognizedHeadings(
  page: number,
  blocks: ReadonlyArray<MineruBlock> | undefined,
  pageHeight?: number,
): OutlineHeading[] {
  if (!blocks || !Array.isArray(blocks)) return [];
  const height = typeof pageHeight === "number" && Number.isFinite(pageHeight) && pageHeight > 0 ? pageHeight : undefined;
  return blocks.flatMap((block) => {
    if (!block || typeof block.text !== "string" || !RECOGNIZED_HEADING_TYPES.has(block.type)) return [];
    const label = normalizeLabel(block.text);
    if (label.length < 2 || label.length > 100) return [];
    const level = explicitLevel(label) ?? (KNOWN_SECTION_NAME.test(label) ? 1 : undefined);
    if (level === undefined) return [];
    const blockTop = height !== undefined && Array.isArray(block.bbox) && typeof block.bbox[1] === "number" && Number.isFinite(block.bbox[1])
      ? (1 - block.bbox[1]) * height
      : undefined;
    return [{ label, page, level, explicit: true, ...(blockTop !== undefined ? { anchorTop: blockTop } : {}) }];
  });
}

const MIN_BODY_OUTLINE_ROOTS = 3;

/** 第三档：无印刷目录时用正文标题聚树——页码即标题所在页，不经偏移解算。
 *  序数身份沿页序形成脊柱且严格递增（幸存页眉的倒挂签名直接否决），特名落顶层；
 *  顶层序数章不足时宁缺毋滥输出空。 */
export function assembleBodyHeadingOutline(headings: readonly OutlineHeading[]): AssembledOutline {
  const usable = suppressRunningHeaders(headings).filter((heading) => isAdmittedBodyHeading(heading.label));
  const roots = assembleLevelTree(
    usable.map((heading) => ({
      label: heading.label,
      page: heading.page,
      level: explicitLevel(heading.label) ?? 1,
      ...(heading.anchorTop !== undefined ? { anchor: { top: heading.anchorTop } } : {}),
    })),
    "body",
  );
  const spine = roots
    .map((root) => parseOutlineOrdinal(root.label))
    .filter((ordinal): ordinal is NonNullable<typeof ordinal> => ordinal !== undefined)
    .map((ordinal) => (ordinal.type === "section" ? (ordinal.scope ?? 0) * 1000 + ordinal.ordinal : ordinal.ordinal));
  const monotonic = spine.every((value, index) => index === 0 || value > spine[index - 1]!);
  if (roots.length < MIN_BODY_OUTLINE_ROOTS || spine.length < MIN_BODY_OUTLINE_ROOTS || !monotonic) {
    return { nodes: [], strategy: "empty" };
  }
  return { nodes: repairOutlineMonotonicity(roots), strategy: "body_headings" };
}

/** 全书装配：AI 目录行 + 正文锚点投票解算偏移（tocPages 标出目录页——其页脚票降级）；
 *  偏移不可信（锚点不足）时输出空目录等 OCR 补全后重算。 */
export function assembleOutline(
  headings: readonly OutlineHeading[],
  tocRows: readonly TocRow[],
  pageCount: number,
  printedVotes: readonly PrintedPageVote[] = [],
  tocPages: ReadonlySet<number> = new Set(),
): AssembledOutline {
  const bodyHeadings = suppressRunningHeaders(headings);
  if (tocRows.length === 0) return { nodes: [], strategy: "empty" };
  const anchors = collectAnchors(bodyHeadings);
  const offset = resolvePageOffset(tocRows, anchors, printedVotes, tocPages);
  if (offset === undefined) return { nodes: [], strategy: "empty" };
  return { nodes: repairOutlineMonotonicity(buildTocNodes(tocRows, offset, pageCount, anchors)), strategy: "ai_toc" };
}

function recognizedLines(blocks: ReadonlyArray<MineruBlock> | undefined): OutlineTextLine[] {
  if (!blocks || !Array.isArray(blocks)) return [];
  // 块级 bbox 为 0-1 归一化坐标；size/y 只在块间作相对比较，同页共享同一坐标系即可。
  return blocks.flatMap((block) => {
    if (!block || typeof block.text !== "string" || !Array.isArray(block.bbox) || block.bbox.length !== 4) return [];
    const [x0, y0, x1, y1] = block.bbox;
    if (![x0, y0, x1, y1].every((value) => typeof value === "number" && Number.isFinite(value))) return [];
    return [{ text: block.text, size: y1 - y0, y: y0 }];
  });
}

/** 识别块文本拆成可视行（块内以 \n 分行）：目录密度判定按行统计，不按块。 */
function blockTextLines(blocks: ReadonlyArray<MineruBlock> | undefined): string[] {
  if (!blocks || !Array.isArray(blocks)) return [];
  return blocks.flatMap((block) => {
    if (!block || typeof block.text !== "string") return [];
    return block.text.split("\n").map((line: string) => normalizeLabel(line)).filter(Boolean);
  });
}

const PAGE_NUMBER_LINE_PATTERN = /^(?:第?\s*\d+\s*页|page\s+\d+(?:\s+of\s+\d+)?|\d+)$/i;

/** 页文本行（定位与 AI 载荷共用）：OCR 页按块拆行，原生页用文本行。 */
function pageTextLines(
  source: PageTextSource,
  lines: readonly OutlineTextLine[],
  blocks: ReadonlyArray<MineruBlock> | undefined,
): string[] {
  return source === "ocr" ? blockTextLines(blocks) : lines.map((line) => normalizeLabel(line.text));
}

/** index 块判定（布局模型的目录页签名）：页文本快照的定位信号。 */
function hasIndexBlock(blocks: ReadonlyArray<MineruBlock> | undefined): boolean {
  return (blocks ?? []).some((block) => block?.type === "index");
}

/** 页文本选源：原生文本充足用原生，否则识别块补位——定位器与页候选循环共用同一裁决。 */
function selectPageText(
  native: OutlineTextLine[],
  blocks: ReadonlyArray<MineruBlock> | undefined,
): { lines: OutlineTextLine[]; source: PageTextSource } {
  const nativeTextLength = native
    .filter((line) => !PAGE_NUMBER_LINE_PATTERN.test(normalizeLabel(line.text)))
    .reduce((total, line) => total + normalizeLabel(line.text).length, 0);
  const lines = nativeTextLength >= 16 || !blocks || blocks.length === 0 ? native : recognizedLines(blocks);
  return { lines, source: lines.length === 0 ? "empty" : lines === native ? "native" : "ocr" };
}

/** 印刷页码观测（T57-05）：OCR 页的 page_number 块与原生页的孤立数字行——偏移投票的密集信号。 */
function printedObservations(
  source: PageTextSource,
  lines: readonly OutlineTextLine[],
  blocks: ReadonlyArray<MineruBlock> | undefined,
): number[] {
  if (source === "ocr") {
    const printed: number[] = [];
    for (const block of blocks ?? []) {
      if (block?.type !== "page_number") continue;
      const parsed = Number(String(block.text ?? "").match(/\d{1,4}/)?.[0]);
      if (Number.isSafeInteger(parsed)) printed.push(parsed);
    }
    return printed;
  }
  if (source === "native") {
    return lines.flatMap((line) => (/^\d{1,4}$/.test(normalizeLabel(line.text)) ? [Number(line.text)] : []));
  }
  return [];
}

type PdfDocument = Awaited<ReturnType<typeof getDocument>["promise"]>;
type PdfOutlineItem = NonNullable<Awaited<ReturnType<PdfDocument["getOutline"]>>>[number];

export type EmbeddedOutlineVerdict = {
  accepted: boolean;
  entryCount: number;
  resolvableCount: number;
  distinctPages: number;
};

const MIN_EMBEDDED_ENTRIES = 3;
const MIN_EMBEDDED_DISTINCT_PAGES = 2;
const MIN_EMBEDDED_RESOLVABLE_RATIO = 0.5;

function flattenOutlineNodes(nodes: readonly BookOutlineNode[]): BookOutlineNode[] {
  return nodes.flatMap((node) => [node, ...flattenOutlineNodes(node.children)]);
}

/** 内嵌书签质量闸门：「有书签」不等于「书签可用」。信号不足（条目太少、页码解析率低、
 *  全部指向同页）或垃圾模式（全部同题/未命名/纯数字、逐页连续书签）拒收，降第二档；
 *  被拒的书签树直接弃用，不留兜底。分节带来的重复页会打破「严格连续」，真实结构不受逐页判定误伤。 */
export function evaluateEmbeddedOutline(nodes: readonly BookOutlineNode[], pageCount: number): EmbeddedOutlineVerdict {
  const entries = flattenOutlineNodes(nodes);
  const resolvable = entries.filter((entry) => entry.page !== undefined && entry.page >= 1 && entry.page <= pageCount);
  const distinctPages = new Set(resolvable.map((entry) => entry.page)).size;
  const labels = entries.map((entry) => entry.label.trim()).filter(Boolean);
  const labelsGarbage = labels.length === 0
    || labels.every((label) => label === labels[0])
    || labels.every((label) => label.startsWith("未命名"))
    || labels.every((label) => /^\d+$/.test(label));
  const pages = resolvable.map((entry) => entry.page!);
  const perPageJunk = pages.length >= Math.max(3, pageCount)
    && pages.every((page, index) => index === 0 || page === pages[index - 1]! + 1);
  const accepted = entries.length >= MIN_EMBEDDED_ENTRIES
    && resolvable.length >= 2
    && resolvable.length / entries.length >= MIN_EMBEDDED_RESOLVABLE_RATIO
    && distinctPages >= MIN_EMBEDDED_DISTINCT_PAGES
    && !labelsGarbage
    && !perPageJunk;
  return { accepted, entryCount: entries.length, resolvableCount: resolvable.length, distinctPages };
}

/** PDF 大纲 → BookOutlineNode 树：主进程唯一解析点，一次遍历同时解析跳转目标与页内锚点；
 *  有效性由质量闸门从节点推导。 */
async function resolveEmbeddedNodes(
  document: PdfDocument,
  items: PdfOutlineItem[] | null,
  lineage = "embedded",
): Promise<BookOutlineNode[]> {
  if (!items) return [];
  const nodes: BookOutlineNode[] = [];
  for (const [index, item] of items.entries()) {
    let page: number | undefined;
    let destination: Awaited<ReturnType<PdfDocument["getDestination"]>> | undefined;
    if (item.dest) {
      try {
        destination = typeof item.dest === "string" ? await document.getDestination(item.dest) : item.dest;
        const target = destination?.[0];
        if (typeof target === "number") page = target + 1;
        else if (target) page = (await document.getPageIndex(target)) + 1;
      } catch {
        page = undefined;
      }
    }
    // 页内锚点只认 XYZ 的 top（用户空间 Y，原样保留交查看器换算）：同页多条目（手册条款）
    // 靠它区分落点；Fit/FitH 等类型无独立坐标或语义不同，不造锚点、跳页顶。
    const anchorTop = destination?.[1]?.name === "XYZ" && typeof destination[3] === "number" ? destination[3] : undefined;
    nodes.push({
      id: `${lineage}-${index}`,
      label: item.title.trim() || `未命名章节 ${index + 1}`,
      ...(page === undefined ? {} : { page }),
      ...(page !== undefined && anchorTop !== undefined ? { anchor: { top: anchorTop } } : {}),
      children: await resolveEmbeddedNodes(document, item.items, `${lineage}-${index}`),
    });
  }
  return nodes;
}

async function openPdfOutlineDocument(source: { bytes: Uint8Array; password?: string }): Promise<OutlineDocument> {
  const loadingTask = getDocument({ data: source.bytes.slice(), ...(source.password ? { password: source.password } : {}) });
  const document = await loadingTask.promise;
  return {
    pageCount: document.numPages,
    async getEmbeddedNodes() {
      return resolveEmbeddedNodes(document, await document.getOutline());
    },
    async getPageHeight(pageNumber) {
      const view = (await document.getPage(pageNumber)).view;
      return (view[3] ?? 0) - (view[1] ?? 0);
    },
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

function isOutlineHeading(value: unknown): value is OutlineHeading {
  if (!value || typeof value !== "object") return false;
  const heading = value as Partial<OutlineHeading>;
  return typeof heading.label === "string"
    && typeof heading.page === "number"
    && typeof heading.level === "number"
    && typeof heading.explicit === "boolean"
    && (heading.anchorTop === undefined || (typeof heading.anchorTop === "number" && Number.isFinite(heading.anchorTop)));
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

/** 页候选载荷解析：当前版本为 {v, headings, printed}，过期/损坏载荷按空处理。
 *  printed 是该页的印刷页码观测（page_number 块 / 原生孤立数字行），偏移投票的密集信号。 */
function parsePagePayload(json: string): { headings: OutlineHeading[]; printed: number[] } {
  if (isStalePagePayload(json)) return { headings: [], printed: [] };
  try {
    const payload = JSON.parse(json) as { headings?: unknown; printed?: unknown };
    return {
      headings: Array.isArray(payload.headings) ? payload.headings.filter(isOutlineHeading) : [],
      printed: Array.isArray(payload.printed)
        ? payload.printed.filter((value): value is number => Number.isSafeInteger(value) && value >= 0 && value <= 9999)
        : [],
    };
  } catch {
    return { headings: [], printed: [] };
  }
}

function isAiEntry(value: unknown): value is AiOutlineEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<AiOutlineEntry>;
  return typeof entry.label === "string"
    && (entry.level === 1 || entry.level === 2 || entry.level === 3)
    && (entry.printedPage === undefined || typeof entry.printedPage === "number");
}

export function createBookOutlineModule(
  dataHome: string,
  options: {
    openDocument?: OpenOutlineDocument;
    aiOutline?: BookOutlineAiDeps;
    onOutlineChange?: (bookId: string) => void;
    /** Recognized Text 块最小读接口（recognized_pages 表属 OCR 模块）：原生文本不足时取识别块。 */
    readRecognizedBlocks?(bookId: string, page: number): ReadonlyArray<MineruBlock> | undefined;
  } = {},
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
      strategy TEXT NOT NULL DEFAULT 'empty',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS book_outline_ai (
      book_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      entries_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS book_outline_gate (
      book_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  // 既有库补列：目录来源（T57-05）。
  const outlineColumns = database.prepare("PRAGMA table_info(book_outlines)").all() as Array<{ name: string }>;
  if (!outlineColumns.some((column) => column.name === "strategy")) {
    database.exec("ALTER TABLE book_outlines ADD COLUMN strategy TEXT NOT NULL DEFAULT 'empty'");
  }
  const openDocument = options.openDocument ?? openPdfOutlineDocument;

  function get(bookId: string): BookOutlineNode[] | undefined {
    if (!BOOK_ID_PATTERN.test(bookId)) return undefined;
    const row = database.prepare("SELECT nodes_json, updated_at FROM book_outlines WHERE book_id = ? AND version = ?")
      .get(bookId, OUTLINE_VERSION) as { nodes_json: string } | undefined;
    if (!row) return undefined;
    try {
      const nodes = JSON.parse(row.nodes_json) as BookOutlineNode[];
      return Array.isArray(nodes) ? nodes : undefined;
    } catch {
      return undefined;
    }
  }

  function readAiEntries(bookId: string): AiOutlineCache | undefined {
    const row = database.prepare("SELECT entries_json FROM book_outline_ai WHERE book_id = ? AND version = ?")
      .get(bookId, OUTLINE_VERSION) as { entries_json: string } | undefined;
    if (!row) return undefined;
    try {
      const parsed = JSON.parse(row.entries_json) as { entries?: unknown; tocPages?: unknown };
      if (!Array.isArray(parsed.entries)) return undefined;
      return {
        entries: parsed.entries.filter(isAiEntry),
        tocPages: Array.isArray(parsed.tocPages)
          ? parsed.tocPages.filter((page): page is number => Number.isInteger(page) && page >= 1)
          : [],
      };
    } catch {
      return undefined;
    }
  }

  function writeAiEntries(bookId: string, cache: AiOutlineCache) {
    database.prepare(`
      INSERT INTO book_outline_ai (book_id, version, entries_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(book_id) DO UPDATE SET
      version = excluded.version,
      entries_json = excluded.entries_json,
      updated_at = excluded.updated_at
    `).run(bookId, OUTLINE_VERSION, JSON.stringify(cache), new Date().toISOString());
  }

  function persistOutline(bookId: string, nodes: BookOutlineNode[], totalPages: number, strategy: BookOutlineStrategy) {
    database.prepare(`
      INSERT INTO book_outlines (book_id, version, nodes_json, total_pages, strategy, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(book_id) DO UPDATE SET
      version = excluded.version,
      nodes_json = excluded.nodes_json,
      total_pages = excluded.total_pages,
      strategy = excluded.strategy,
      updated_at = excluded.updated_at
    `).run(bookId, OUTLINE_VERSION, JSON.stringify(nodes), totalPages, strategy, new Date().toISOString());
  }

  /** 目录来源（落库元信息，面板可见）：无记录或版本不符返回 "empty"。 */
  function outlineStrategy(bookId: string): BookOutlineStrategy {
    if (!BOOK_ID_PATTERN.test(bookId)) return "empty";
    const row = database.prepare("SELECT strategy FROM book_outlines WHERE book_id = ? AND version = ?")
      .get(bookId, OUTLINE_VERSION) as { strategy: string } | undefined;
    const value = row?.strategy;
    return value === "embedded" || value === "ai_toc" || value === "body_headings" ? value : "empty";
  }

  /** 第一档已裁决标记（无内嵌或垃圾书签）：让开书快检不必每次重复解析书签开 PDF。
   *  证据闸门拦下的重建也落此标记——扫描书在整书完成前不写候选，标记是「管线已看过
   *  第一档」的唯一痕迹。版本不符视为未裁决。 */
  function markTierOneAdjudicated(bookId: string) {
    if (!BOOK_ID_PATTERN.test(bookId)) return;
    database.prepare(`
      INSERT INTO book_outline_gate (book_id, version, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(book_id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at
    `).run(bookId, OUTLINE_VERSION, new Date().toISOString());
  }

  function tierOneAdjudicated(bookId: string): boolean {
    if (!BOOK_ID_PATTERN.test(bookId)) return false;
    return database.prepare("SELECT 1 FROM book_outline_gate WHERE book_id = ? AND version = ?").get(bookId, OUTLINE_VERSION) !== undefined;
  }

  /** 目录失效：页级失效只清该页候选——已落库目录保留到下一次重建整体替换（早出的
   *  目录不因后续页识别被清空，渐进改善而非清空重现）；整表失效才连目录与 AI 结论一起清。 */
  function invalidate(bookId: string, page?: number) {
    if (!BOOK_ID_PATTERN.test(bookId)) return;
    if (page !== undefined && Number.isSafeInteger(page) && page > 0) {
      database.prepare("DELETE FROM book_outline_pages WHERE book_id = ? AND page = ?").run(bookId, page);
      return;
    }
    database.prepare("DELETE FROM book_outlines WHERE book_id = ?").run(bookId);
    database.prepare("DELETE FROM book_outline_pages WHERE book_id = ?").run(bookId);
    database.prepare("DELETE FROM book_outline_ai WHERE book_id = ?").run(bookId);
    options.onOutlineChange?.(bookId);
  }

  /** 页文本快照：一页的选源结果与派生信号（拆行文本、index 有无、印刷页码观测、可判定性）。
   *  定位器、AI 载荷与页候选循环共用同一份取数，「原生 → 识别块 → 选源」只此一处。 */
  async function readPageTextSnapshot(
    bookId: string,
    document: OutlineDocument,
    page: number,
  ): Promise<{
    source: PageTextSource;
    lines: OutlineTextLine[];
    blocks: ReadonlyArray<MineruBlock> | undefined;
    textLines: string[];
    hasIndex: boolean;
    printedPages: number[];
    covered: boolean;
  }> {
    const native = await document.getNativeLines(page);
    const blocks = options.readRecognizedBlocks?.(bookId, page);
    const { lines, source } = selectPageText(native, blocks);
    return {
      source,
      lines,
      blocks,
      textLines: pageTextLines(source, lines, blocks),
      hasIndex: hasIndexBlock(blocks),
      printedPages: printedObservations(source, lines, blocks),
      // 空白页的空识别结果也算已判定（有原生文本或已有识别结果）。
      covered: native.length > 0 || blocks !== undefined,
    };
  }

  /** 探测窗口内的目录信号定位：index 块命中，无命中时密度兜底；候选页裁到已覆盖前缀内。
   *  windowCovered 是证据闸门（T58）：窗口内每页都可判定（有原生文本或已有识别结果）——
   *  未覆盖即证据不足，调用方不得下任何结论。原生书例外放宽：窗口过半页有原生文本时，
   *  无文本页视为原生书的空白分页页（无信号可言），整窗即刻可判——否则没装 OCR 资源的
   *  原生书会被一页空白卡死（spec 故事 18）。 */
  async function locateTocCandidates(
    bookId: string,
    document: OutlineDocument,
    signal?: AbortSignal,
  ): Promise<{ hits: number[]; pages: number[]; windowCovered: boolean }> {
    const windowEnd = tocWindowEnd(document.pageCount);
    const inputs: TocLocatorPageInput[] = [];
    let nativePages = 0;
    for (let page = 1; page <= windowEnd; page += 1) {
      if (signal?.aborted) break;
      const snapshot = await readPageTextSnapshot(bookId, document, page);
      if (snapshot.covered && snapshot.source === "native") nativePages += 1;
      inputs.push({ page, lines: snapshot.textLines, hasIndexBlock: snapshot.hasIndex, covered: snapshot.covered });
    }
    const located = locateTocPages(inputs);
    let coveredPrefix = 0;
    for (const input of inputs) {
      if (!input.covered) break;
      coveredPrefix += 1;
    }
    const windowCovered = coveredPrefix >= windowEnd || nativePages >= Math.ceil(windowEnd / 2);
    return {
      hits: located.hits,
      // 窗口可判时候选页取全集（空白分页页之后的命中不再被前缀裁掉）；不可判时按前缀裁剪。
      pages: windowCovered ? located.pages : located.pages.filter((page) => page <= coveredPrefix),
      windowCovered,
    };
  }

  /** 目录候选页的逐页识别文字（随图附给模型）；行数上限防载荷失控。 */
  async function readTocPageText(bookId: string, document: OutlineDocument, page: number): Promise<TocPageText> {
    const snapshot = await readPageTextSnapshot(bookId, document, page);
    const textLines = snapshot.textLines.slice(0, TOC_TEXT_LINE_CAP);
    return { page, lines: textLines, source: textLines.length === 0 || snapshot.source === "empty" ? "empty" : snapshot.source };
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
      const embeddedNodes = await document.getEmbeddedNodes();
      if (evaluateEmbeddedOutline(embeddedNodes, document.pageCount).accepted) {
        invalidate(bookId);
        // 内嵌书签落库为可读目录：检索的所在章加权只读 book_outlines，
        // 不落库的书对「先验」是隐身书，恰是最该吃到加权的结构良好的书。
        persistOutline(bookId, embeddedNodes, document.pageCount, "embedded");
        options.onOutlineChange?.(bookId);
        return { status: "embedded" as const, nodes: embeddedNodes, processedPages: 0, totalPages: document.pageCount };
      }
      // 闸门拒收（无书签或垃圾书签）的书签树直接弃用不留兜底，降第二档。
      // 证据闸门（T58）：探测窗口未覆盖（有页既无原生文本也无识别结果）时不下结论——
      // 零 AI 调用、不写页候选、不落库，静默返回未完成，等整书识别后的收尾重排。原生书
      // 窗口即刻覆盖（开书秒级结论）；扫描书开书空转一次即退，OCR 独占跑到完成。
      const incomplete = () => (
        { status: "partial" as const, nodes: get(bookId) ?? [], processedPages: 0, totalPages: document.pageCount }
      );
      const located = await locateTocCandidates(bookId, document, signal);
      if (signal?.aborted || !located.windowCovered) {
        markTierOneAdjudicated(bookId);
        return incomplete();
      }
      // AI 目录：成功结论（含「无目录」）入库缓存；失败（无模型/网络）不缓存，下次打开自动重试。
      let aiCache = readAiEntries(bookId);
      const tocSignalPages = located.hits;
      if (!aiCache && options.aiOutline && located.pages.length > 0) {
        try {
          const result = await generateAiOutline({
            pageCount: document.pageCount,
            candidatePages: located.pages,
            readPageText: (page) => readTocPageText(bookId, document, page),
            renderPage: (page, scale) => options.aiOutline!.renderPage(bookId, page, scale),
            complete: options.aiOutline.complete,
            signal,
          });
          // 中止的半成品不当结论缓存——否则「无目录」会被永久固化。
          if (result.aborted) return incomplete();
          aiCache = { entries: result.hasToc ? result.entries : [], tocPages: result.tocPages };
          writeAiEntries(bookId, aiCache);
        } catch (error) {
          // 失败≠判无：模型调不起来（无模型/网络/解析失败）不下任何结论——不缓存、
          // 不降第三档，保留现有目录，下次重建自动重试（spec 故事 22）。
          console.warn("AI 目录提取失败，保留现有目录，下次重建自动重试。", error);
          return incomplete();
        }
      }
      const tocPageSet = new Set([...tocSignalPages, ...(aiCache?.tocPages ?? [])]);
      if (signal?.aborted) return incomplete();
      // 投票分类集用候选页全集（含 ±1 边距）：边距页的页脚更可能是目录序列的延续，
      // 按目录票降级；标题排除仍只信真实命中——边距页的正文标题不被吞（T57-03 语义）。
      const voteTocPages = new Set([...located.pages, ...(aiCache?.tocPages ?? [])]);
      // 检测逻辑随版本演进：载荷版本不一致（含旧版中断残留）时整体作废重算。
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
        const snapshot = await readPageTextSnapshot(bookId, document, page);
        // 目录页不参与正文标题锚点——否则章/节锚点会全落在目录页本身。
        // OCR 页标题候选走布局模型判定（T57-06），原生页维持字号检测；
        // OCR 块的页内位置需按页高换算（缺页高则该页标题不带锚点）。
        let headings: OutlineHeading[] = [];
        if (!tocPageSet.has(page)) {
          if (snapshot.source === "ocr") {
            const pageHeight = await document.getPageHeight?.(page);
            headings = detectRecognizedHeadings(page, snapshot.blocks, pageHeight);
          } else {
            headings = detectHeadingCandidates(page, snapshot.lines);
          }
        }
        upsert.run(bookId, page, JSON.stringify({ v: OUTLINE_VERSION, headings, printed: snapshot.printedPages }), snapshot.source, new Date().toISOString());
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
      const headings: OutlineHeading[] = [];
      const printedVotes: PrintedPageVote[] = [];
      for (const row of rows) {
        const payload = parsePagePayload(row.candidates_json);
        headings.push(...payload.headings);
        for (const printed of payload.printed) printedVotes.push({ page: row.page, printed });
      }
      const assembled = assembleOutline(headings, aiCache?.entries ?? [], document.pageCount, printedVotes, voteTocPages);
      let nodes = assembled.nodes;
      let strategy: BookOutlineStrategy = assembled.strategy;
      if (strategy === "empty") {
        // 第三档（T57-06）：第二档无产出（无目录信号、模型判无目录、偏移不可信）时，
        // 用正文标题聚树兜底；质量闸门不过宁缺毋滥，维持空目录。
        const fallback = assembleBodyHeadingOutline(headings);
        if (fallback.strategy === "body_headings") {
          nodes = fallback.nodes;
          strategy = "body_headings";
        }
      }
      persistOutline(bookId, nodes, document.pageCount, strategy);
      options.onOutlineChange?.(bookId);
      return { status: "generated" as const, nodes, processedPages, totalPages: document.pageCount };
    } finally {
      await document.close();
    }
  }

  /** 读路径快检（第一档开书即得）：缓存未命中时同步解析内嵌书签（不渲染页面），
   *  过质量闸门即落库返回；无内嵌或垃圾书签落「已裁决」标记后返回 undefined。
   *  目录管线已越过第一档（AI 缓存、页候选或裁决标记在库）时不再重复开书。 */
  async function ensureEmbedded(
    bookId: string,
    loadBook: () => Promise<{ bytes: Uint8Array; password?: string }>,
  ): Promise<BookOutlineNode[] | undefined> {
    if (!BOOK_ID_PATTERN.test(bookId)) return undefined;
    const cached = get(bookId);
    if (cached !== undefined) return cached;
    const pipelinePastTierOne = readAiEntries(bookId) !== undefined
      || tierOneAdjudicated(bookId)
      || ((database.prepare("SELECT COUNT(*) AS count FROM book_outline_pages WHERE book_id = ?").get(bookId) as { count: number }).count > 0);
    if (pipelinePastTierOne) return undefined;
    const document = await openDocument(await loadBook());
    try {
      const nodes = await document.getEmbeddedNodes();
      if (!evaluateEmbeddedOutline(nodes, document.pageCount).accepted) {
        markTierOneAdjudicated(bookId);
        return undefined;
      }
      persistOutline(bookId, nodes, document.pageCount, "embedded");
      options.onOutlineChange?.(bookId);
      return nodes;
    } finally {
      await document.close();
    }
  }

  return {
    get,
    strategy: outlineStrategy,
    invalidate,
    rebuild,
    ensureEmbedded,

    /** 每书数据清理钩子：在调用方提供的连接上删除本书生成目录、页候选、AI 目录缓存与裁决标记。 */
    deleteBookData(bookId: string, connection: DatabaseSync) {
      connection.prepare("DELETE FROM book_outlines WHERE book_id = ?").run(bookId);
      connection.prepare("DELETE FROM book_outline_pages WHERE book_id = ?").run(bookId);
      connection.prepare("DELETE FROM book_outline_ai WHERE book_id = ?").run(bookId);
      connection.prepare("DELETE FROM book_outline_gate WHERE book_id = ?").run(bookId);
    },

    close() { database.close(); },
  };
}

export type BookOutlineModule = ReturnType<typeof createBookOutlineModule>;
