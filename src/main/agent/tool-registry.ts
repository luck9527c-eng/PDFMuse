import { Type, type Static, type TSchema } from "typebox";

import type { ReadingFocus } from "../../shared/contracts.js";
import type { BookIndex } from "./book-index.js";
import type { AgentTool, AgentToolResult } from "./openclaw-core.js";

/** PDF Evidence：来自当前 PDF Book 的可信检索结果。 */
export type PdfEvidence = {
  source: "pdf";
  page: number;
  snippet: string;
  trust: "trusted";
};

export type ToolExecutionContext = {
  bookId: string;
  focus?: ReadingFocus;
  signal?: AbortSignal;
  reportEvidence(evidence: PdfEvidence[]): void;
  bookIndex: BookIndex;
};

export type ToolExecutionOutcome = {
  displaySummary: string;
  contentText: string;
  evidence?: PdfEvidence[];
};

type RegisteredTool = {
  name: string;
  title: string;
  description: string;
  parameters: TSchema;
  availability: "always" | "embedding-configured";
  risk: "read-only";
  execute(input: unknown, ctx: ToolExecutionContext): Promise<ToolExecutionOutcome>;
};

const QUERY_MAX_LENGTH = 200;
const TOOL_TIMEOUT_MS = 60_000;
const CONTENT_MAX_LENGTH = 8_000;

const bookSearchSchema = Type.Object({
  query: Type.String({ description: "要在当前 PDF 书籍中检索的关键词或短语" }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "返回的命中数量上限，默认 6" })),
});

/** book_search：整本书混合检索，返回带来源的 PDF 摘录或较早会话候选。 */
function createBookSearchTool(): RegisteredTool {
  return {
    name: "book_search",
    title: "检索本书",
    description:
      "在 Reader 当前阅读的 PDF 书籍中进行关键词与语义混合检索；当问题可能涉及其他章节、需要原文页码，或需要找回较早对话时调用。返回带来源的原文摘录。",
    parameters: bookSearchSchema,
    availability: "always",
    risk: "read-only",
    async execute(input, ctx) {
      // 执行器内重新校验输入；模型参数不可信。
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new Error("检索参数无效。");
      }
      const { query, limit } = input as Static<typeof bookSearchSchema>;
      if (typeof query !== "string" || !query.trim() || query.length > QUERY_MAX_LENGTH) {
        throw new Error(`检索词必须为 1–${QUERY_MAX_LENGTH} 个字符。`);
      }
      const hitLimit = typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 1 && limit <= 10
        ? limit
        : 6;

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

      const outcome = await ctx.bookIndex.search(ctx.bookId, query.trim(), hitLimit, ctx.focus, ctx.signal);
      if (outcome.status === "unavailable") {
        return { displaySummary: `检索「${query.trim()}」不可用`, contentText: outcome.note };
      }
      const lines = outcome.hits.map((hit) => (
        hit.source === "conversation"
          ? `较早对话：${hit.snippet}`
          : `第 ${hit.page ?? "未知"} 页：${hit.snippet}`
      ));
      const evidence: PdfEvidence[] = outcome.hits.flatMap((hit) => (
        hit.source === "conversation" || hit.page === undefined
          ? []
          : [{ source: "pdf" as const, page: hit.page, snippet: hit.snippet, trust: "trusted" as const }]
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
        displaySummary: `已检索「${query.trim()}」，命中 ${outcome.hits.length} 处${outcome.retrievalMode === "hybrid" ? "（混合检索）" : ""}`,
        contentText,
        evidence,
      };
    },
  };
}

export function createToolRegistry(options: { embeddingConfigured?: boolean } = {}) {
  const tools: RegisteredTool[] = [createBookSearchTool()];

  /** 可见性规划：不可用工具不会进入模型工具列表。 */
  function plan() {
    return tools.filter((tool) => tool.availability === "always" || options.embeddingConfigured);
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
        const outcome = await tool.execute(params, withSignal);
        const result: AgentToolResult<ToolExecutionOutcome> = {
          content: [{ type: "text", text: outcome.contentText }],
          details: outcome,
        };
        if (outcome.evidence) ctx.reportEvidence(outcome.evidence);
        return result;
      },
    };
  }

  return {
    plan,
    toolNames: () => plan().map((tool) => tool.name),
    /** 构造 vendored Agent 可用的工具列表；工具结果里的 Evidence 经 ctx 回调上报。 */
    buildAgentTools(contextFactory: () => ToolExecutionContext): AgentTool[] {
      return plan().map((tool) => toAgentTool(tool, contextFactory));
    },
  };
}

export type ToolRegistry = ReturnType<typeof createToolRegistry>;
