import { Type, type Static, type TSchema } from "typebox";

import type { ReadingFocus } from "../../shared/contracts.js";
import type { RegionBbox } from "../../shared/region.js";
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
  /** 本问内实际渲染交付的图片数（整页或单幅插图裁剪各计 1；渲染失败与复用命中不扣；次数上限已删除）。 */
  pagesDelivered: number;
  /** 本问已交付图片 → 媒体相对路径（键 `${page}` 或 `${page}:${figure}`）：同问同键复用既有媒体文件，字节恒同、不重复渲染。 */
  deliveredMedia: Map<string, string>;
};

export type ToolExecutionContext = {
  bookId: string;
  focus?: ReadingFocus;
  signal?: AbortSignal;
  reportEvidence(evidence: PdfEvidence[]): void;
  bookIndex: BookIndex;
  /** 页面渲染模块：视觉工具经此取页面原图，检索模块不再承担渲染。 */
  renderPageImage(bookId: string, page: number, scale: number): Promise<RenderedPageImage>;
  /** 页面区域渲染（T53 插图级寻址）：按识别块归一化 bbox 裁剪，整页同倍率下有效 DPI 更高。 */
  renderRegionImage(bookId: string, page: number, bbox: RegionBbox, scale: number): Promise<RenderedPageImage>;
  /** 每问图片预算（agent-host 每问新建、跨调用共享）：页数额度钳制与同问复用在工具层执行。 */
  pageBudget: PageImageBudget;
  /** 原图转存 book 媒体目录（T44）：live 与回放共享同一份文件字节，会话库只存相对路径；figure 存在时为单幅裁剪。 */
  savePageImage(bookId: string, page: number, pngBase64: string, figure?: number): Promise<{ relativePath: string }>;
  /** 同问复用时按相对路径读回媒体文件字节；缺失返回 null（回退重新渲染）。 */
  loadPageImage?(relativePath: string): Promise<string | null>;
  webSearch?: WebSearchModule;
};

export type ToolExecutionOutcome = {
  displaySummary: string;
  contentText: string;
  evidence?: PdfEvidence[];
  /** 随结果发送给模型的页面原图（base64 PNG）；view_page 使用。 */
  images?: Array<{ page: number; mimeType: "image/png"; data: string }>;
  /** 已转存媒体目录的原图引用（T44）；随 details 到达 agent-host 的落库层。 */
  media?: Array<{ page: number; path: string }>;
  /**
   * 注解行（T50 三层管线的注解层）：额度回显等逐次变化的文本。不进指纹哈希，
   * 由 agent-host 在交付形态（全文 | Result Stub）确定后合成进最终文本——模型所见即所存。
   */
  annotations?: string[];
  /** 单次工具 420 秒软超时命中：软错误结果，模型可继续；不进指纹窗口。 */
  timeout?: boolean;
};

type RegisteredTool = {
  name: string;
  title: string;
  description: string;
  parameters: TSchema;
  execute(input: unknown, ctx: ToolExecutionContext): Promise<ToolExecutionOutcome>;
};

const QUERY_MAX_LENGTH = 200;
/** 每问联网搜索子额度（T50 Tool Quota，与 Run Budget 独立计数）：执行即扣，缓存命中也扣。 */
export const MAX_SEARCH_WEB_CALLS = 3;
/** 单次工具调用统一软超时（T50）：罩住建索引与实际检索；到点返回软错误结果，模型可继续。 */
const TOOL_EXECUTION_TIMEOUT_MS = 420_000;
const CONTENT_MAX_LENGTH = 8_000;
/** read_pages 的总文本上限：整页阅读需要比碎片检索更大的预算；超出按 offset 续读。 */
const READ_PAGES_MAX_CHARS = 20_000;

const searchBookSchema = Type.Object({
  query: Type.String({ minLength: 1, maxLength: QUERY_MAX_LENGTH, description: "要在当前 PDF 书籍中检索的关键词或短语" }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "返回的命中数量上限，默认 6" })),
});

/** search_book：整本书混合检索，返回带页码的原文摘录。 */
function createSearchBookTool(): RegisteredTool {
  return {
    name: "search_book",
    title: "检索本书",
    description:
      "按关键词在整本书内定位相关页码，返回带来源的原文摘录（关键词与语义混合检索）。"
      + "页码为 PDF 页序号（从 1 开始），不是书内印刷页码。"
      + "不确定相关内容在哪几页时用它定位；检索摘录只是片段，作答和讲解等应基于 read_pages 的整页原文。",
    parameters: searchBookSchema,
    async execute(input, ctx) {
      // 参数已由 agent-loop 的 validateToolArguments 按 schema 校验；这里只做 schema 表达不了的语义收敛。
      const { query, limit } = input as Static<typeof searchBookSchema>;
      const keyword = query.trim();
      if (!keyword) throw new Error("检索词不能只包含空白字符。");
      const hitLimit = limit ?? 6;

      await ctx.bookIndex.ensureIndexed(ctx.bookId, () => ctx.bookIndex.loadBookByBookId(ctx.bookId), ctx.signal);

      const outcome = await ctx.bookIndex.search(ctx.bookId, keyword, hitLimit, ctx.focus, ctx.signal);
      if (outcome.status === "unavailable") {
        return { displaySummary: `检索「${keyword}」不可用`, contentText: outcome.note };
      }
      const lines = outcome.hits.map((hit) => `第 ${hit.page ?? "未知"} 页（相关度 ${(hit.score ?? 0).toFixed(2)}）：${hit.snippet}`);
      const evidence: PdfEvidence[] = outcome.hits.flatMap((hit) => (
        hit.page === undefined
          ? []
          : [{ source: "pdf" as const, page: hit.page, snippet: hit.snippet, trust: "trusted" as const, score: hit.score }]
      ));
      const header = [
        outcome.status === "partial" ? outcome.note : "",
        outcome.retrievalMode === "fts-only" ? "当前未完成向量检索，结果仅基于关键词匹配。" : "",
      ].filter(Boolean).join("\n\n");
      // 未命中本书页面时把下一步写进结果：模型常在空命中后
      // 空转续查或放弃整页阅读，这比只靠工具描述自觉更可靠。
      const currentPage = ctx.focus?.currentPage;
      const readPagesHint = currentPage !== undefined
        ? `如需讲解当前小节，请改用 read_pages 直接读取第 ${currentPage} 页附近的整页原文。`
        : "如需讲解，请改用 read_pages 读取相关章节的整页原文。";
      const body = lines.length === 0
        ? `没有在书中找到相关内容。请基于已有上下文回答，并明确说明书中未检索到。\n\n${readPagesHint}`
        : lines.join("\n\n");
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
    description: "要读取的 PDF 页码列表，最多 8 页，可传入不连续的页码",
  }),
  offset: Type.Optional(Type.Integer({
    minimum: 0,
    description: "续读起始字符偏移：上次结果被截断时，按其末尾提示的 offset 与相同页码继续读取被省略的部分",
  })),
});

/** read_pages：按页码列表整页读取已索引全文（含 OCR），小节讲解/总结/复习类问题的首选。 */
function createReadPagesTool(): RegisteredTool {
  return {
    name: "read_pages",
    title: "读取页面",
    description:
      "按 PDF 页码列表整页读取文字（页码为页序号，从 1 开始，与书内印刷页码不同；扫描页读取 OCR 识别文本），一次可读多页、支持不连续页码。"
      + "讲解、总结、复习某小节或某几页时用它读原文；不知道页码时先用 search_book 定位。"
      + `单次只返回本次请求各页拼接全文的前 ${READ_PAGES_MAX_CHARS.toLocaleString("en-US")} 字符，末尾附续读 offset——offset 是该拼接全文中的字符偏移（不是页码偏移），用相同页码带上它继续读取省略的部分。`,
    parameters: readPagesSchema,
    async execute(input, ctx) {
      const { pages, offset } = input as Static<typeof readPagesSchema>;
      const requested = [...new Set(pages)].sort((left, right) => left - right);
      const start = Math.max(0, offset ?? 0);

      await ctx.bookIndex.ensureIndexed(ctx.bookId, () => ctx.bookIndex.loadBookByBookId(ctx.bookId), ctx.signal);

      const rows = ctx.bookIndex.readPages(ctx.bookId, requested[0]!, requested[requested.length - 1]!);
      const textByPage = new Map(rows.map((row) => [row.page, row.text]));
      const found = requested.filter((page) => textByPage.has(page));
      if (found.length === 0) {
        return {
          displaySummary: `第 ${requested[0]} 页附近没有可读文本`,
          contentText: "该页码范围尚未建立文字索引（可能仍在后台处理），请改用 search_book 检索。",
        };
      }
      const missing = requested.filter((page) => !textByPage.has(page));
      const fullText = found.map((page) => `【第 ${page} 页】\n${textByPage.get(page)}`).join("\n\n");
      let body = start > 0 ? fullText.slice(start) : fullText;
      if (body.length > READ_PAGES_MAX_CHARS) {
        const nextOffset = start + READ_PAGES_MAX_CHARS;
        const readThrough = start > 0
          ? `本次从 offset ${start} 读到 ${nextOffset}，尚有 ${fullText.length - nextOffset} 字符未读；如需继续，用相同页码并以 offset=${nextOffset} 续读。`
          : `本次读取第 0–${nextOffset} 字符，尚有 ${fullText.length - nextOffset} 字符未读；如需继续，用相同页码并以 offset=${nextOffset} 续读。`;
        body = `${body.slice(0, READ_PAGES_MAX_CHARS)}\n…（内容过长已截断。${readThrough}）`;
      } else if (start >= fullText.length) {
        body = `（offset ${start} 已达到或超过本批页码全文长度（${fullText.length} 字符），没有更多内容。）`;
      } else if (start > 0) {
        body = `${body}\n（本批页码全文已读完整，共 ${fullText.length} 字符。）`;
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
      // 插图不可见信号由页文本内的自描述占位行承载（T53）：升级方式落在图所在的位置，不再整批附注记。
      return {
        displaySummary: `已读取${label}全文`,
        contentText: body,
        evidence,
      };
    },
  };
}

const searchWebSchema = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 200, description: "联网搜索的关键词或问题" }),
});

/** search_web：书内信息不足或问题涉及书外事实时联网搜索；结果必须在回答中用链接标注来源。 */
function createSearchWebTool(): RegisteredTool {
  return {
    name: "search_web",
    title: "联网搜索",
    description:
      "联网搜索网络资料。优先使用书内工具获取本书内容，本书不足或问题涉及书外事实（作者生平、出版背景、外部概念对照、时事等）时才用本工具。"
      + "回答中引用网络内容必须附来源链接并说明这不是本书内容；书中观点与网络信息冲突时，分别说明双方及各自出处。",
    parameters: searchWebSchema,
    async execute(input, ctx) {
      if (!ctx.webSearch) {
        return { displaySummary: "联网搜索不可用", contentText: "当前没有可用的联网搜索模块。" };
      }
      const { query } = input as Static<typeof searchWebSchema>;
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

const viewPageSchema = Type.Object({
  pages: Type.Array(Type.Integer({ minimum: 1 }), {
    minItems: 1,
    maxItems: 4,
    description: "要查看原图的 PDF 页码列表",
  }),
  figure: Type.Optional(Type.Integer({
    minimum: 1,
    description: "插图编号：只查看某页的第 N 幅插图（read_pages 文本中 [插图 N·…] 占位行给出编号）；传入时 pages 只能含该插图所在的一页",
  })),
});

/** 每问（run）图片页额度：次数上限已删除（T50），只留页数用量。 */
export const MAX_PAGE_IMAGE_PAGES = 20;

/** 插图裁剪渲染倍率（T53）：高于整页默认倍率，小图不被 provider 降采样、有效 DPI 更高。 */
const FIGURE_RENDER_SCALE = 4;

/** provider 图片硬限制（T44）：仅超限时降采样重渲，常规尺寸不重编码（公式清晰度优先）。 */
const IMAGE_HARD_LIMIT_EDGE_PX = 8_000;
const IMAGE_HARD_LIMIT_BYTES = 5 * 1024 * 1024;

/** 预算与复用键：整页与单幅插图裁剪各占一键，同问同键命中复用。 */
function imageBudgetKey(page: number, figure?: number): string {
  return figure === undefined ? `${page}` : `${page}:${figure}`;
}

/** 额度用尽的软拒绝（整页与插图共用同一文案）。 */
function quotaExhaustedOutcome(): ToolExecutionOutcome {
  return {
    displaySummary: "图片额度已用完",
    contentText: `图片额度已用完（${MAX_PAGE_IMAGE_PAGES} 页），不要再调用 view_page，用文字工具继续。`,
  };
}

/** 同问复用：按键读回既有媒体字节（不重复渲染、不扣额度）；文件缺失删键返回 null（调用方回退新渲染）。 */
async function reuseDeliveredMedia(
  ctx: ToolExecutionContext,
  budget: PageImageBudget,
  key: string,
): Promise<{ data: string; path: string } | null> {
  const existing = budget.deliveredMedia.get(key);
  if (!existing) return null;
  const data = (await ctx.loadPageImage?.(existing)) ?? null;
  if (!data) {
    budget.deliveredMedia.delete(key);
    return null;
  }
  return { data, path: existing };
}

/** 渲染整页或其归一化 bbox 裁剪，并在超出 provider 硬限制时按比例降采样重渲。 */
async function renderWithinHardLimits(
  ctx: ToolExecutionContext,
  page: number,
  region?: RegionBbox,
): Promise<RenderedPageImage> {
  let scale = region === undefined ? 2 : FIGURE_RENDER_SCALE;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rendered = region === undefined
      ? await ctx.renderPageImage(ctx.bookId, page, scale)
      : await ctx.renderRegionImage(ctx.bookId, page, region, scale);
    const bytes = Math.floor(rendered.imageData.length * 3 / 4);
    const maxEdge = Math.max(rendered.width, rendered.height);
    if (maxEdge <= IMAGE_HARD_LIMIT_EDGE_PX && bytes <= IMAGE_HARD_LIMIT_BYTES) return rendered;
    const edgeFactor = maxEdge > IMAGE_HARD_LIMIT_EDGE_PX ? IMAGE_HARD_LIMIT_EDGE_PX / maxEdge : 1;
    const byteFactor = bytes > IMAGE_HARD_LIMIT_BYTES ? Math.sqrt(IMAGE_HARD_LIMIT_BYTES / bytes) : 1;
    scale = Math.max(0.5, scale * Math.min(edgeFactor, byteFactor) * 0.99);
  }
  throw new Error("页面原图超出尺寸硬限制，降采样后仍超限。");
}

/** view_page：渲染页面原图（整页或单幅插图裁剪）发给模型，查看文本层没有的内容。 */
function createViewPageTool(): RegisteredTool {
  return {
    name: "view_page",
    title: "查看页面原图",
    description:
      "渲染指定页或其中一幅插图的原图并随结果发送，用于查看文本层没有的内容：识别页的图片、照片、图表在文本中只有 [插图 N·…] 占位。"
      + "读者要求查看或解释某个图、表时直接调用；此外，公式与表格通常已完整转为文本，仅当答案依赖关键公式或数字、且文本形式可疑（符号异常、等式不成立、上下文矛盾等）时才看原图核对——原生文本页的复杂表格与公式在纯文本中同样可能失真。"
      + "占位行标明各页插图编号（页内编号，从 1 开始）：读图优先只传该页页码并带 figure=N 取单幅裁剪（更清晰）；核对公式或对照整页版式才看整页。",
    parameters: viewPageSchema,
    async execute(input, ctx) {
      const { pages, figure } = input as Static<typeof viewPageSchema>;
      const budget = ctx.pageBudget;
      const requested = [...new Set(pages)].sort((left, right) => left - right);
      return figure === undefined
        ? await executeWholePageView(ctx, budget, requested)
        : await executeFigureView(ctx, budget, requested, figure);
    },
  };
}

/** 整页查看：复用优先、按剩余页额度钳制渲染、逐页落媒体。 */
async function executeWholePageView(
  ctx: ToolExecutionContext,
  budget: PageImageBudget,
  requested: number[],
): Promise<ToolExecutionOutcome> {
  const images: NonNullable<ToolExecutionOutcome["images"]> = [];
  const media: NonNullable<ToolExecutionOutcome["media"]> = [];
  const failed: number[] = [];
  const overBudget: number[] = [];
  // 复用优先：本问已交付图读回既有媒体字节（不重复渲染、不扣额度）；文件缺失回退新渲染。
  for (const page of requested) {
    const reused = await reuseDeliveredMedia(ctx, budget, imageBudgetKey(page));
    if (!reused) continue;
    images.push({ page, mimeType: "image/png", data: reused.data });
    media.push({ page, path: reused.path });
  }
  // 新页渲染：按剩余页数额度钳制，超出的页不渲染并附注。
  const remainingAtRequest = Math.max(0, MAX_PAGE_IMAGE_PAGES - budget.pagesDelivered);
  const freshRequested = requested.filter((page) => !budget.deliveredMedia.has(imageBudgetKey(page)) && !images.some((image) => image.page === page));
  const allowed = freshRequested.slice(0, remainingAtRequest);
  overBudget.push(...freshRequested.slice(allowed.length));
  for (const page of allowed) {
    try {
      const rendered = await renderWithinHardLimits(ctx, page);
      // 原图落盘后以同一份字节发给模型：live 与回放字节天然一致（T44）。
      const saved = await ctx.savePageImage(ctx.bookId, page, rendered.imageData);
      images.push({ page, mimeType: "image/png", data: rendered.imageData });
      media.push({ page, path: saved.relativePath });
      budget.deliveredMedia.set(imageBudgetKey(page), saved.relativePath);
      budget.pagesDelivered += 1;
    } catch {
      // 单页渲染或落盘失败继续其余页，失败页不扣预算、在结果中说明。
      failed.push(page);
    }
  }
  if (images.length === 0) {
    const quotaLeft = MAX_PAGE_IMAGE_PAGES - budget.pagesDelivered;
    return quotaLeft <= 0
      ? quotaExhaustedOutcome()
      : failed.length > 0
        ? { displaySummary: "原图渲染失败", contentText: "无法渲染所选页面，请检查页码是否在本书范围内。" }
        : { displaySummary: "没有可交付的页面", contentText: "请求的页面均未能查看，请检查页码后重试。" };
  }
  const label = images.map((image) => image.page).join("、");
  const evidence: PdfEvidence[] = images.map((image) => ({
    source: "pdf",
    page: image.page,
    snippet: "（已查看页面原图）",
    trust: "trusted",
    score: 1,
  }));
  const quotaNote = overBudget.length > 0
    ? `（本问图片额度只剩 ${remainingAtRequest} 页：第 ${overBudget.join("、")} 页未附上。）`
    : "";
  return {
    displaySummary: `已附上第 ${label} 页原图${overBudget.length > 0 ? "（额度已满）" : ""}`,
    contentText: `以下是第 ${label} 页的原图，请以此为准阅读公式与结构。${failed.length > 0 ? `（第 ${failed.join("、")} 页渲染失败未附上。）` : ""}${quotaNote}`,
    evidence,
    images,
    media,
    // 额度回显走注解层（T50）：逐次变化的文本不进指纹哈希，由 agent-host 后置合成。
    annotations: [`本问图片预算：已用 ${budget.pagesDelivered}/${MAX_PAGE_IMAGE_PAGES} 页。`],
  };
}

/** 单幅插图查看（T53 插图级寻址）：按识别块 bbox 裁剪渲染，token 更省、有效 DPI 更高。 */
async function executeFigureView(
  ctx: ToolExecutionContext,
  budget: PageImageBudget,
  requested: number[],
  figure: number,
): Promise<ToolExecutionOutcome> {
  if (requested.length !== 1) {
    return {
      displaySummary: "插图查看需要单页",
      contentText: "查看插图时 pages 只传该插图所在的一页，并用 figure 指明 read_pages 占位行中的插图编号。",
    };
  }
  const page = requested[0]!;
  const key = imageBudgetKey(page, figure);
  // 复用优先：同问同幅插图读回既有媒体字节。
  const reused = await reuseDeliveredMedia(ctx, budget, key);
  if (reused) return figureOutcome(page, figure, reused.data, reused.path, budget);
  if (budget.pagesDelivered >= MAX_PAGE_IMAGE_PAGES) return quotaExhaustedOutcome();
  const bbox = ctx.bookIndex.recognizedFigureBbox(ctx.bookId, page, figure);
  if (!bbox) {
    return {
      displaySummary: "未找到该插图",
      contentText: `第 ${page} 页没有第 ${figure} 号插图（该页可能未识别，或编号超出占位行所列范围）；可先用 read_pages 核对该页占位行中的插图编号。`,
    };
  }
  try {
    const rendered = await renderWithinHardLimits(ctx, page, bbox);
    const saved = await ctx.savePageImage(ctx.bookId, page, rendered.imageData, figure);
    budget.deliveredMedia.set(key, saved.relativePath);
    budget.pagesDelivered += 1;
    return figureOutcome(page, figure, rendered.imageData, saved.relativePath, budget);
  } catch {
    return {
      displaySummary: "插图渲染失败",
      contentText: `第 ${page} 页插图 ${figure} 渲染失败，可去掉 figure 参数改看该页整页原图。`,
    };
  }
}

function figureOutcome(
  page: number,
  figure: number,
  data: string,
  mediaPath: string,
  budget: PageImageBudget,
): ToolExecutionOutcome {
  return {
    displaySummary: `已附上第 ${page} 页插图 ${figure} 原图`,
    contentText: `以下是第 ${page} 页插图 ${figure} 的原图裁剪，请以此为准阅读图中内容。`,
    evidence: [{ source: "pdf", page, snippet: `（已查看第 ${page} 页插图 ${figure} 原图）`, trust: "trusted", score: 1 }],
    images: [{ page, mimeType: "image/png", data }],
    media: [{ page, path: mediaPath }],
    annotations: [`本问图片预算：已用 ${budget.pagesDelivered}/${MAX_PAGE_IMAGE_PAGES} 页。`],
  };
}

export function createToolRegistry(options: { toolTimeoutMs?: number } = {}) {
  const toolTimeoutMs = options.toolTimeoutMs ?? TOOL_EXECUTION_TIMEOUT_MS;
  const tools: RegisteredTool[] = [createSearchBookTool(), createReadPagesTool(), createViewPageTool(), createSearchWebTool()];

  /**
   * 单次工具 420 秒软超时（T50）：到点不抛错，返回软错误结果让模型换路继续；
   * 底层执行仍在跑，其迟到结果被丢弃、迟到异常被吞掉（调用方已拿到超时结果）。
   */
  function withSoftTimeout(tool: RegisteredTool, promise: Promise<ToolExecutionOutcome>): Promise<ToolExecutionOutcome> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve({
          displaySummary: `${tool.title}超时`,
          contentText: `工具调用超时（${Math.round(toolTimeoutMs / 1000)} 秒无结果），本次调用已中断。换参数缩小范围、换工具，或用手头的结果作答。`,
          timeout: true,
        });
      }, toolTimeoutMs);
      promise.then(
        (outcome) => {
          clearTimeout(timer);
          resolve(outcome);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
      // 超时结果已交付后，底层执行的迟到失败不再是本调用的错误。
      promise.catch(() => undefined);
    });
  }

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
        const outcome = await withSoftTimeout(tool, tool.execute(params, withSignal));
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
