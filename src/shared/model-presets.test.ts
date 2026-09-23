import { describe, expect, it } from "vitest";

import { isModelProtocol, MODEL_CONTEXT_WINDOW_OPTIONS } from "./contracts";
import { MODEL_PROVIDER_PRESETS } from "./model-presets";

describe("Model Provider Presets", () => {
  it("预设目录数据自洽：id 唯一、地址合法、协议与档位受支持", () => {
    const ids = MODEL_PROVIDER_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of MODEL_PROVIDER_PRESETS) {
      expect(() => new URL(preset.baseUrl)).not.toThrow();
      expect(new URL(preset.baseUrl).protocol).toMatch(/^https:$/);
      expect(isModelProtocol(preset.protocol)).toBe(true);
      expect(MODEL_CONTEXT_WINDOW_OPTIONS).toContain(preset.contextWindow);
      expect(["max_tokens", "max_completion_tokens"]).toContain(preset.maxTokensField);
      expect(preset.exampleModel.length).toBeGreaterThan(0);
    }
  });
});
