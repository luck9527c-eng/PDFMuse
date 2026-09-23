// PDFMuse 与 vendored OpenClaw Agent Core 之间的唯一导入边界。
// 业务代码只能从这里获取 Agent Core 的类型和实现，不得直接依赖
// vendor/openclaw-agent-core 路径（见 vendor/openclaw-agent-core/UPSTREAM.json）。

export {
  Agent,
  buildSessionContext,
  compact,
  DEFAULT_COMPACTION_SETTINGS,
  estimateTokens,
  findCutPoint,
  generateSummary,
  prepareCompaction,
  shouldCompact,
  type AgentEvent,
  type AgentMessage,
  type AgentOptions,
  type AgentState,
  type AgentTool,
  type AgentToolResult,
  type BeforeToolCallContext,
  type CompactionPreparation,
  type CompactionResult,
  type CompactionSettings,
  type SessionTreeEntry,
  type StreamFn,
} from "../../../vendor/openclaw-agent-core/packages/agent-core/src/index.js";

export {
  AssistantMessageEventStream,
  configureAiTransportHost,
  createLlmRuntime,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type CompleteSimpleFn,
  type Context,
  type ImageContent,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
  type TextContent,
  type ToolResultMessage,
  type Usage,
  type UserMessage,
} from "@openclaw/ai";

export { registerBuiltInApiProviders } from "@openclaw/ai/providers";

// 工具参数校验：agent-loop 执行前调用同一实现，测试与业务侧共用这一个事实来源。
export { validateToolArguments, validateToolCall } from "../../../vendor/openclaw-agent-core/packages/agent-core/src/validation.js";

export {
  estimateStringChars,
  estimateTokensFromChars,
  CHARS_PER_TOKEN_ESTIMATE,
} from "../../../vendor/openclaw-agent-core/packages/normalization-core/src/cjk-chars.js";
export { IMAGE_BLOCK_TOKENS } from "../../../vendor/openclaw-agent-core/packages/agent-core/src/index.js";
