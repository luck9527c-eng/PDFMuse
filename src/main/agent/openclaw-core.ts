// PDFMuse 与 vendored OpenClaw Agent Core 之间的唯一导入边界。
// 业务代码只能从这里获取 Agent Core 的类型和实现，不得直接依赖
// vendor/openclaw-agent-core 路径（见 vendor/openclaw-agent-core/UPSTREAM.json）。

export {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentOptions,
  type AgentState,
  type AgentTool,
  type AgentToolResult,
  type StreamFn,
} from "../../../vendor/openclaw-agent-core/packages/agent-core/src/index.js";

export {
  AssistantMessageEventStream,
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
