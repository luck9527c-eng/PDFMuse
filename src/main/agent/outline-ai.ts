// AI 目录提取：把「任意排版目录的解析」从规则代码交给视觉模型。
// 书籍排版千差万别（章/节、组/课文、竖排组标、点线页码），词表枚举不完；
// 模型看目录页图片直接输出结构化 JSON，本模块只负责分批取图、提示词与输出校验。

import type { CompleteSimpleFn, TextContent, UserMessage } from "./openclaw-core.js";
import {
  type ResolvedModelConnection,
  createModelCompleteFn,
  toLlmModel,
} from "./model-runtime.js";

export type AiOutlineEntry = { label: string; level: 1 | 2; printedPage: number | undefined };

export type AiOutlineResult = {
  hasToc: boolean;
  entries: AiOutlineEntry[];
  /** 目录内容出现在哪些 PDF 页（1 基）：这些页不参与正文标题锚点，防止锚点全落在目录页上。 */
  tocPages: number[];
  /** 中途被中止：结果是半成品，调用方不得当结论缓存。 */
  aborted: boolean;
};

/** AI 目录条目的去重键（分批合并与装配期共用）。 */
export function aiOutlineEntryKey(entry: { level: number; label: string }) {
  return `${entry.level}|${entry.label.toLocaleLowerCase()}`;
}

export type AiOutlineCompleteInput = {
  pages: number[];
  images: Array<{ data: string; mimeType: string }>;
};

export type AiOutlineComplete = (input: AiOutlineCompleteInput) => Promise<string>;

export const AI_OUTLINE_BATCH_SIZE = 12;
export const AI_OUTLINE_MAX_PAGES = 24;
export const AI_OUTLINE_RENDER_SCALE = 1.5;
const MAX_ENTRIES = 400;

const SYSTEM_PROMPT = `你是 PDF 书籍的目录提取器。用户会提供一本书前若干页的截图，每页按顺序编号。

任务：找到其中的印刷目录页（逐条列出章节标题与页码的页面），把目录条目提取为 JSON。

规则：
1. 只提取目录页上的条目；封面、版权页、前言、正文不是目录。如果所有图片中都没有目录页，返回 {"hasToc": false, "entries": [], "tocPages": [], "continuesAt": null}。
2. 目录一般分两级：顶层（章/单元/部分）level=1，次级（节/小节/课文）level=2。目录只有一级时全部用 level=1。
3. label 保留条目的完整标题文字（含「第一章」「第1节」「1 窃读记」这类编号前缀与「2*」这类标记），去掉引导点线和行尾页码。
4. printedPage 是该条目行尾的印刷页码（整数）——这是书内印刷页码，不是截图序号；页码不可辨认时填 null。
5. tocPages 列出目录内容出现在哪些页，用上面文字里给出的书籍页码（如 16、17），不要用图片序号；哪怕某页只有目录的一小部分也要列出。
6. 如果目录在最后一张截图对应页之后还会延续，continuesAt 填目录延续到的下一个页码（按截图页码推算），否则填 null。
7. 只输出一个 JSON 对象，不要输出任何其他文字：
{"hasToc": true, "tocPages": [3, 4, 5], "entries": [{"label": "第一章 函数与极限", "level": 1, "printedPage": 1}, {"label": "第一节 映射与函数", "level": 2, "printedPage": 2}], "continuesAt": null}`;

function userPrompt(pages: readonly number[]) {
  const first = pages[0]!;
  const last = pages.at(-1)!;
  return `以下是这本书第 ${first} 到 ${last} 页的截图，按顺序对应各张图片（第 ${first} 页 = 第 1 张图，以此类推）。请提取其中的目录。`;
}

function extractJsonObject(text: string): string | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  return candidate.slice(start, end + 1);
}

function toEntry(value: unknown): AiOutlineEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as { label?: unknown; level?: unknown; printedPage?: unknown; page?: unknown };
  if (typeof raw.label !== "string") return undefined;
  const label = raw.label.replace(/\s+/g, " ").trim();
  if (label.length < 2 || label.length > 80) return undefined;
  const level = raw.level === 2 ? 2 : raw.level === 1 ? 1 : undefined;
  if (level === undefined) return undefined;
  const rawPage = raw.printedPage ?? raw.page;
  let printedPage: number | undefined;
  if (typeof rawPage === "number" && Number.isFinite(rawPage)) printedPage = Math.floor(rawPage);
  else if (typeof rawPage === "string" && /^\d{1,4}$/.test(rawPage.trim())) printedPage = Number(rawPage.trim());
  if (printedPage !== undefined && (printedPage < 0 || printedPage > 9999)) printedPage = undefined;
  return { label, level, printedPage };
}

/** 解析并校验模型输出的目录 JSON；坏条目丢弃，整体非法时返回 undefined。 */
export function parseAiOutlineResponse(text: string): {
  hasToc: boolean;
  entries: AiOutlineEntry[];
  tocPages: number[];
  continuesAt: number | undefined;
} | undefined {
  const jsonText = extractJsonObject(text);
  if (!jsonText) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const value = parsed as { hasToc?: unknown; entries?: unknown; tocPages?: unknown; continuesAt?: unknown };
  const hasToc = value.hasToc !== false;
  const entries = Array.isArray(value.entries)
    ? value.entries.flatMap((entry) => {
      const converted = toEntry(entry);
      return converted ? [converted] : [];
    }).slice(0, MAX_ENTRIES)
    : [];
  const tocPages = Array.isArray(value.tocPages)
    ? [...new Set(value.tocPages.flatMap((page) => (
      typeof page === "number" && Number.isInteger(page) && page >= 1 && page <= AI_OUTLINE_MAX_PAGES ? [page] : []
    )))].sort((left, right) => left - right)
    : [];
  let continuesAt: number | undefined;
  if (typeof value.continuesAt === "number" && Number.isInteger(value.continuesAt) && value.continuesAt > 0) {
    continuesAt = value.continuesAt;
  }
  return { hasToc, entries, tocPages, continuesAt };
}

export type AiOutlineDeps = {
  pageCount: number;
  renderPage(page: number, scale: number): Promise<{ imageData: string }>;
  complete: AiOutlineComplete;
  signal?: AbortSignal;
};

/** 分批渲染前 N 页并让视觉模型提取目录；最多两批（目录在前 24 页内）。 */
export async function generateAiOutline(deps: AiOutlineDeps): Promise<AiOutlineResult> {
  const limit = Math.min(deps.pageCount, AI_OUTLINE_MAX_PAGES);
  const collected: AiOutlineEntry[] = [];
  const tocPages = new Set<number>();
  const seen = new Set<string>();
  const aborted = () => deps.signal?.aborted === true;
  let nextStart = 1;
  for (let batch = 0; batch < 2 && nextStart <= limit; batch += 1) {
    const pages: number[] = [];
    for (let page = nextStart; page < nextStart + AI_OUTLINE_BATCH_SIZE && page <= limit; page += 1) pages.push(page);
    const images: Array<{ data: string; mimeType: string }> = [];
    let interrupted = false;
    for (const page of pages) {
      if (aborted()) { interrupted = true; break; }
      const rendered = await deps.renderPage(page, AI_OUTLINE_RENDER_SCALE);
      images.push({ data: rendered.imageData, mimeType: "image/png" });
    }
    if (interrupted) break;
    const text = await deps.complete({ pages, images });
    if (aborted()) break;
    // 解析失败等同模型故障（抛错、不缓存），不能固化成「无目录」结论。
    const parsed = parseAiOutlineResponse(text);
    if (!parsed) throw new Error("模型返回的目录 JSON 无法解析。");
    if (!parsed.hasToc && collected.length === 0) return { hasToc: false, entries: [], tocPages: [], aborted: false };
    for (const entry of parsed.entries) {
      const key = aiOutlineEntryKey(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(entry);
    }
    // 模型偶发把 tocPages 写成批内图片序号：全部落在批大小内且批次起点更晚时按批起点换算。
    const localIndices = parsed.tocPages.length > 0
      && parsed.tocPages.every((page) => page <= images.length)
      && pages[0]! > images.length;
    const pageBase = localIndices ? pages[0]! - 1 : 0;
    for (const page of parsed.tocPages) tocPages.add(page + pageBase);
    const lastPage = pages.at(-1)!;
    if (parsed.continuesAt === undefined || parsed.continuesAt <= lastPage || lastPage >= limit) break;
    nextStart = Math.min(parsed.continuesAt, limit);
  }
  if (aborted()) {
    return { hasToc: collected.length > 0, entries: collected, tocPages: [...tocPages], aborted: true };
  }
  return {
    hasToc: collected.length > 0,
    entries: collected,
    tocPages: [...tocPages].sort((left, right) => left - right),
    aborted: false,
  };
}

/** 把模型连接装配为目录提取的一次性视觉调用；未配置模型时抛错由调用方降级为空目录。 */
export function buildAiOutlineCompleter(options: {
  loadConnection(): Promise<ResolvedModelConnection | undefined>;
}): AiOutlineComplete {
  return async (input) => {
    const connection = await options.loadConnection();
    if (!connection || !connection.baseUrl || !connection.model) {
      throw new Error("尚未配置对话模型，无法生成 AI 目录。");
    }
    const complete: CompleteSimpleFn = createModelCompleteFn(connection);
    const message: UserMessage = {
      role: "user",
      timestamp: Date.now(),
      content: [
        { type: "text", text: userPrompt(input.pages) },
        ...input.images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
      ],
    };
    const assistant = await complete(toLlmModel(connection, true), {
      systemPrompt: SYSTEM_PROMPT,
      messages: [message],
    });
    const text = assistant.content
      .filter((block): block is TextContent => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (!text) throw new Error("模型没有返回目录内容。");
    return text;
  };
}
