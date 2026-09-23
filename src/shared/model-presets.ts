import type { MaxTokensField, ModelProtocol } from "./contracts.js";

export type ModelProviderPreset = {
  id: string;
  label: string;
  protocol: ModelProtocol;
  baseUrl: string;
  exampleModel: string;
  contextWindow: number;
  maxTokensField: MaxTokensField;
};

/**
 * 常用模型商预设：规范地址、默认模型与上下文档位抄自 openclaw 的厂商目录
 * （extensions/<provider>/openclaw.plugin.json，2026-09 快照）。
 * 预设只负责填表，Reader 仍可改地址与模型；未列出的厂商走"自定义"手工输入。
 */
export const MODEL_PROVIDER_PRESETS: readonly ModelProviderPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    protocol: "openai",
    baseUrl: "https://api.deepseek.com",
    exampleModel: "deepseek-v4-pro",
    contextWindow: 1_048_576,
    maxTokensField: "max_tokens",
  },
  {
    id: "moonshot",
    label: "Moonshot Kimi",
    protocol: "openai",
    baseUrl: "https://api.moonshot.ai/v1",
    exampleModel: "kimi-k3",
    contextWindow: 1_048_576,
    maxTokensField: "max_tokens",
  },
  {
    id: "zai",
    label: "智谱 GLM",
    protocol: "openai",
    baseUrl: "https://api.z.ai/api/paas/v4",
    exampleModel: "glm-5.2",
    contextWindow: 1_048_576,
    maxTokensField: "max_tokens",
  },
  {
    id: "openai",
    label: "OpenAI",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    exampleModel: "gpt-5.6-sol",
    contextWindow: 1_048_576,
    maxTokensField: "max_completion_tokens",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    exampleModel: "claude-opus-5",
    contextWindow: 262_144,
    maxTokensField: "max_tokens",
  },
];

export function findModelProviderPreset(id: string): ModelProviderPreset | undefined {
  return MODEL_PROVIDER_PRESETS.find((preset) => preset.id === id);
}
