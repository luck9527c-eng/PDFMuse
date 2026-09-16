import { Type, type Static, type TSchema } from "typebox";

import type { ReadingFocus } from "../../shared/contracts.js";
import type { RenderedPageImage } from "../page-render.js";
import type { BookIndex } from "./book-index.js";
import type { AgentTool, AgentToolResult } from "./openclaw-core.js";
import type { WebSearchModule } from "./web-search.js";

/** PDF Evidence：来自当前 PDF Book 的可信检索结果。 */
export type PdfEvidence = {
  source: "pdf";
  page: number;
  snippet: string;
  trust: "trusted";
  /** 检索相关度；证据聚合按页取最优。 */
  score?: number;
};

export type PageImageBudget = {
  /** 本问内已成功交付的原图页数（渲染失败不扣）。 */
  pagesDelivered: number;
  /** 本问内 read_page_image 的调用次数（含被拒的尝试）。 */
  calls: number;
};

export type ToolExecutionContext = {
  bookId: string;
  focus?: ReadingFocus;
  signal?: AbortSignal;
  reportEvidence(evidence: PdfEvidence[]): void;
  bookIndex: BookIndex;
  /** 页面渲染模块：视觉工具经此取页面原图，检索模块不再承担渲染。 */
  renderPageImage(bookId: string, page: number, scale: number): Promise<RenderedPageImage>;
  /** 每问图片预算（agent-host 每问新建、跨调用共享）：页数与次数钳制在工具层执行。 */
  pageBudget: PageImageBudget;
  webSearch?: WebSearchModule;
};

export type ToolExecutionOutcome = {
  displaySummary: string;
  contentText: string;
  evidence?: PdfEvidence[];
  /** 随结果发送给模型的页面原图（base64 PNG）；read_page_image 使用。 */
  images?: Array<{ page: number; mimeType: "image/png"; data: string }>;
};

type RegisteredTool = {
  name: string;
  title: string;
  description: string;
  parameters: TSchema;
  execute(input: unknown, ctx: ToolExecutionContext): Promise<ToolExecutionOutcome>;
};

const QUERY_MAX_LENGTH = 200;
const TOOL_TIMEOUT_MS = 60_000;
const CONTENT_MAX_LENGTH = 8_000;
/** read_pages 的总文本上限：整页阅读需要比碎片检索更大的预算。 */
const READ_PAGES_MAX_CHARS = 20_000;

const bookSearchSchema = Type.Object({
  query: Type.String({ minLength: 1, maxLength: QUERY_MAX_LENGTH, description: "要在当前 PDF 书籍中检索的关键词或短语" }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "返回的命中数量上限，默认 6" })),
});

/** book_search：整本书混合检索，返回带来源的 PDF 摘录或较早会话候选。 */
function createBookSearchTool(): RegisteredTool {
  return {
    name: "book_search",
    title: "检索本书",
    description:
      "在阅读者当前打开的 PDF 书籍中进行关键词与语义混合检索；当问题可能涉及其他章节、需要原文页码，或需要找回较早对话时调用。返回带来源的原文摘录。",
    parameters: bookSearchSchema,
    async execute(input, ctx) {
      // 参数已由 agent-loop 的 validateToolArguments 按 schema 校验；这里只做 schema 表达不了的语义收敛。
      const { query, limit } = input as Static<typeof bookSearchSchema>;
      const keyword = query.trim();
      if (!keyword) throw new Error("检索词不能只包含空白字符。");
      const hitLimit = limit ?? 6;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TOOL_TIMEOUT_MS);
      const onOuterAbort = () => controller.abort();
      ctx.signal?.addEventListener("abort", onOuterAbort);
      try {
        await ctx.bookIndex.ensureIndexed(ctx.bookId, () => ctx.bookIndex.loadBookByBookId(ctx.bookId), controller.signal);
      } finally {
        clearTimeout(timeout);
        ctx.signal?.removeEventListener("abort", onOuterAbort);
      }

      const outcome = await ctx.bookIndex.search(ctx.bookId, keyword, hitLimit, ctx.focus, ctx.signal);
      if (outcome.status === "unavailable") {
        return { displaySummary: `检索「${keyword}」不可用`, contentText: outcome.note };
      }
      const lines = outcome.hits.map((hit) => (
        hit.source === "conversation"
          ? `较早对话：${hit.snippet}`
          : `第 ${hit.page ?? "未知"} 页（相关度 ${(hit.score ?? 0).toFixed(2)}）：${hit.snippet}`
      ));
      const evidence: PdfEvidence[] = outcome.hits.flatMap((hit) => (
        hit.source === "conversation" || hit.page === undefined
          ? []
          : [{ source: "pdf" as const, page: hit.page, snippet: hit.snippet, trust: "trusted" as const, score: hit.score }]
      ));
      const header = [
        outcome.status === "partial" ? outcome.note : "",
        outcome.retrievalMode === "fts-only" ? "当前未完成向量检索，结果仅基于关键词匹配。" : "",
      ].filter(Boolean).join("\n\n");
      const body = lines.length > 0
        ? lines.join("\n\n")
        : "没有在书中找到相关内容。请基于已有上下文回答，并明确说明书中未检索到。";
      const contentText = `${header}${body}`.slice(0, CONTENT_MAX_LENGTH);
      return {
        displaySummary: `已检索「${keyword}」，命中 ${outcome.hits.length} 处${outcome.retrievalMode === "hybrid" ? "（混合检索）" : ""}`,
        contentText,
        evidence,
      };
    },
  };
}

const readPagesSchema = Type.Object({
  pages: Type.Array(Type.Integer({ minimum: 1 }), {
    minItems: 1,
    maxItems: 8,
    description: "要读取的 PDF 页码列表，最多 8 页；可传入不连续的页码（章节跨页或跳页时）",
  }),
});

/** read_pages：按页码列表整页读取已索引全文（含 OCR），小节讲解/总结/复习类问题的首选。 */
function createReadPagesTool(): RegisteredTool {
  return {
    name: "read_pages",
    title: "读取页面",
    description:
      "按页码列表整页读取文字（含 OCR 识别结果），一次可读多页、支持不连续页码。讲解、总结、复习某个小节或某几页内容时，优先用本工具从 Reader 当前阅读位置读取原文（章节跨页时把涉及的页码一并传入）；只有需要跨章节定位关键词或找回较早对话时才使用 book_search。",
    parameters: readPagesSchema,
    async execute(input, ctx) {
      const { pages } = input as Static<typeof readPagesSchema>;
      const requested = [...new Set(pages)].sort((left, right) => left - right);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TOOL_TIMEOUT_MS);
      const onOuterAbort = () => controller.abort();
      ctx.signal?.addEventListener("abort", onOuterAbort);
      try {
        await ctx.bookIndex.ensureIndexed(ctx.bookId, () => ctx.bookIndex.loadBookByBookId(ctx.bookId), controller.signal);
      } finally {
        clearTimeout(timeout);
        ctx.signal?.removeEventListener("abort", onOuterAbort);
      }

      const rows = ctx.bookIndex.readPages(ctx.bookId, requested[0]!, requested[requested.length - 1]!);
      const textByPage = new Map(rows.map((row) => [row.page, row.text]));
      const found = requested.filter((page) => textByPage.has(page));
      if (found.length === 0) {
        return {
          displaySummary: `第 ${requested[0]} 页附近没有可读文本`,
          contentText: "该页码范围尚未建立文字索引（可能仍在后台处理），请改用 book_search 检索。",
        };
      }
      const missing = requested.filter((page) => !textByPage.has(page));
      let body = found.map((page) => `【第 ${page} 页】\n${textByPage.get(page)}`).join("\n\n");
      if (body.length > READ_PAGES_MAX_CHARS) {
        body = `${body.slice(0, READ_PAGES_MAX_CHARS)}\n…（内容过长已截断，可缩小页码范围后分次读取）`;
      }
      if (missing.length > 0) {
        body += `\n\n（注意：第 ${missing.join("、")} 页不在索引中，未读取到文本。）`;
      }
      const evidence: PdfEvidence[] = found.map((page) => ({
        source: "pdf",
        page,
        snippet: (textByPage.get(page) ?? "").slice(0, 120).replace(/\s+/g, " "),
        trust: "trusted",
        score: 1,
      }));
      const label = found.length === 1 ? `第 ${found[0]} 页` : `第 ${found.join("、")} 页`;
      return {
        displaySummary: `已读取${label}全文`,
        contentText: `${body}${OCR_MODALITY_NOTE}`,
        evidence,
      };
    },
  };
}

const webSearchSchema = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 200, description: "联网搜索的关键词或问题" }),
});

/** web_search：书内信息不足或问题涉及书外事实时联网搜索；结果必须在回答中用链接标注来源。 */
function createWebSearchTool(): RegisteredTool {
  return {
    name: "web_search",
    title: "联网搜索",
    description:
      "联网搜索网络资料。当书内检索不足以回答、或问题涉及书外事实（作者生平、出版背景、外部概念对照、时事）时使用。回答中引用网络内容时必须附上来源链接，并明确说明这不是本书内容。",
    parameters: webSearchSchema,
    async execute(input, ctx) {
      if (!ctx.webSearch) {
        return { displaySummary: "联网搜索不可用", contentText: "当前没有可用的联网搜索模块。" };
      }
      const { query } = input as Static<typeof webSearchSchema>;
      const keyword = query.trim();
      if (!keyword) throw new Error("搜索词不能只包含空白字符。");
      const outcome = await ctx.webSearch.search(keyword, ctx.signal);
      if (outcome.status !== "ok" || outcome.results.length === 0) {
        return { displaySummary: `联网搜索「${keyword}」无结果`, contentText: outcome.note ?? "没有找到相关网络资料。" };
      }
      const providerNote = outcome.degraded ? `（${outcome.note ?? "已降级"}）` : "";
      const body = outcome.results
        .map((result) => `${result.title}\n${result.url}\n${result.snippet}`)
        .join("\n\n")
        .slice(0, CONTENT_MAX_LENGTH);
      return {
        displaySummary: `已联网搜索「${keyword}」（${outcome.provider}${providerNote ? "，降级" : ""}）`,
        contentText: `以下为网络搜索结果（来源：${outcome.provider}${providerNote}），属于书外资料：\n\n${body}`,
      };
    },
  };
}

/** read_pages 文本的模态声明：OCR/抽取无法保留二维结构，任何页都为真，无需检测公式。 */
const OCR_MODALITY_NOTE =
  "\n\n⚠ 本文本由 OCR/文本抽取生成：分数、根号、上下标等二维结构必然失真（如 ½ 会变成「1 2」），表格与图片内容常有缺失。凡需要精确复述、推导或计算公式，或发现文本明显断裂、缺失（如表格只剩零散数字），必须先用 read_page_image 查看原图。";

const readPageImageSchema = Type.Object({
  pages: Type.Array(Type.Integer({ minimum: 1 }), {
    minItems: 1,
    maxItems: 4,
    description: "要查看原图的 PDF 页码列表；请只列先经检索定位、确需核对的页",
  }),
});

/** 每问（run）图片预算：总页数与调用次数。成本天花板与旧「单请求 4 页」持平。 */
export const MAX_PAGE_IMAGE_CALLS = 2;
export const MAX_PAGE_IMAGE_PAGES = 4;

/** read_page_image：渲染页面原图发给模型，精确查看公式、表格与结构。每问受页预算与次数钳制。 */
function createReadPageImageTool(): RegisteredTool {
  return {
    name: "read_page_image",
    title: "查看页面原图",
    description:
      "渲染指定页的原图并随结果直接发送，用于精确查看 OCR 文本无法保留的内容：数学公式（分数、根号、上下标）、表格结构、图表。"
      + "先用 book_search、read_pages 或上一轮回答引用的原文把范围定位到具体页码后再调用本工具；默认只查看 1 页，确需相邻页对照或跨页内容时才增加。"
      + `本问内图片查看受预算约束（共 ${MAX_PAGE_IMAGE_PAGES} 页、最多 ${MAX_PAGE_IMAGE_CALLS} 次），超出部分会被拒绝，请把预算花在最需要的页上。`,
    parameters: readPageImageSchema,
    async execute(input, ctx) {
      const { pages } = input as Static<typeof readPageImageSchema>;
      const budget = ctx.pageBudget;
      budget.calls += 1;
      if (budget.calls > MAX_PAGE_IMAGE_CALLS) {
        return {
          displaySummary: "图片查看次数已达上限",
          contentText: `本问内查看原图的次数已达上限（${MAX_PAGE_IMAGE_CALLS} 次）。请基于已查看的页面作答；若确有关键页未核对，请向 Reader 说明。`,
        };
      }
      const remaining = Math.max(0, MAX_PAGE_IMAGE_PAGES - budget.pagesDelivered);
      const requested = [...new Set(pages)].sort((left, right) => left - right);
      const allowed = requested.slice(0, remaining);
      const overBudget = requested.slice(remaining);
      const images: NonNullable<ToolExecutionOutcome["images"]> = [];
      const failed: number[] = [];
      for (const page of allowed) {
        try {
          const rendered = await ctx.renderPageImage(ctx.bookId, page, 2);
          images.push({ page, mimeType: "image/png", data: rendered.imageData });
        } catch {
          // 单页渲染失败继续其余页，失败页不扣预算、在结果中说明。
          failed.push(page);
        }
      }
      budget.pagesDelivered += images.length;
      if (images.length === 0) {
        return failed.length > 0
          ? { displaySummary: "原图渲染失败", contentText: "无法渲染所选页面，请检查页码是否在本书范围内。" }
          : {
              displaySummary: "图片预算已用完",
              contentText: `本问图片预算已用完（${MAX_PAGE_IMAGE_PAGES} 页）。请基于已查看的页面作答。`,
            };
      }
      const label = images.map((image) => image.page).join("、");
      const evidence: PdfEvidence[] = images.map((image) => ({
        source: "pdf",
        page: image.page,
        snippet: "（已查看页面原图）",
        trust: "trusted",
        score: 1,
      }));
      const budgetNote = overBudget.length > 0
        ? `（本问预算只剩 ${remaining} 页：第 ${overBudget.join("、")} 页未附上。）`
        : "";
      const echo = `本问图片预算：已用 ${budget.pagesDelivered}/${MAX_PAGE_IMAGE_PAGES} 页。`;
      return {
        displaySummary: `已附上第 ${label} 页原图${overBudget.length > 0 ? "（预算已满）" : ""}`,
        contentText: `${echo}\n以下是第 ${label} 页的原图，请以此为准阅读公式与结构。${failed.length > 0 ? `（第 ${failed.join("、")} 页渲染失败未附上。）` : ""}${budgetNote}`,
        evidence,
        images,
      };
    },
  };
}

export function createToolRegistry() {
  const tools: RegisteredTool[] = [createBookSearchTool(), createReadPagesTool(), createReadPageImageTool(), createWebSearchTool()];

  function toAgentTool(tool: RegisteredTool, contextFactory: () => ToolExecutionContext): AgentTool {
    return {
      name: tool.name,
      label: tool.title,
      description: tool.description,
      parameters: tool.parameters,
      async execute(toolCallId, params, signal, onUpdate) {
        const ctx = contextFactory();
        const withSignal: ToolExecutionContext = {
          ...ctx,
          signal,
          reportEvidence: (evidence) => ctx.reportEvidence(evidence),
        };
        onUpdate?.({
          content: [{ type: "text", text: `${tool.title}执行中...` }],
          progress: { text: `${tool.title}执行中...`, visibility: "channel", privacy: "public" },
          details: undefined,
        });
        const outcome = await tool.execute(params, withSignal);
        const result: AgentToolResult<ToolExecutionOutcome> = {
          content: [
            { type: "text", text: outcome.contentText },
            ...(outcome.images ?? []).map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
          ],
          details: outcome,
        };
        if (outcome.evidence) ctx.reportEvidence(outcome.evidence);
        return result;
      },
    };
  }

  return {
    toolNames: () => tools.map((tool) => tool.name),
    /** 构造 vendored Agent 可用的工具列表；工具结果里的 Evidence 经 ctx 回调上报。 */
    buildAgentTools(contextFactory: () => ToolExecutionContext): AgentTool[] {
      return tools.map((tool) => toAgentTool(tool, contextFactory));
    },
  };
}

export type ToolRegistry = ReturnType<typeof createToolRegistry>;
