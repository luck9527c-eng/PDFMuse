import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createOcrModule, type OcrEngine } from "./ocr.js";

const BOOK_ID = "b".repeat(64);

describe("OCR module", () => {
  let dataHome: string;
  let close: (() => void) | undefined;

  beforeEach(async () => {
    dataHome = await mkdtemp(path.join(os.tmpdir(), "pdfmuse-ocr-"));
  });

  afterEach(async () => {
    close?.();
    await rm(dataHome, { recursive: true, force: true });
  });

  it("validates, persists and reloads recognized page text", async () => {
    const engine: OcrEngine = {
      name: "测试引擎",
      model: "测试模型",
      version: "1.2.3",
      async recognize(input) {
        return {
          width: input.width,
          height: input.height,
          orientation: 0,
          lines: [{ text: "扫描页文字", confidence: 0.98, polygon: [{ x: 10, y: 10 }, { x: 110, y: 10 }, { x: 110, y: 30 }, { x: 10, y: 30 }] }],
        };
      },
    };
    const module = createOcrModule(dataHome, engine);
    close = module.close;
    const result = await module.recognizePage({ bookId: BOOK_ID, page: 2, imageData: "aGVsbG8=", width: 600, height: 800 });
    expect(result).toMatchObject({ ok: true, page: { bookId: BOOK_ID, page: 2, engine: "测试引擎", engineVersion: "1.2.3" } });
    if (result.ok) expect(result.page.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(module.getPage(BOOK_ID, 2)?.lines[0]?.text).toBe("扫描页文字");
    expect(module.isPageCompatible(BOOK_ID, 2, "1.2.3", "测试模型")).toBe(true);
    expect(module.isPageCompatible(BOOK_ID, 2, "旧版本", "测试模型")).toBe(false);
    expect(await module.recognizePage({ bookId: "bad", page: 2, imageData: "x", width: 1, height: 1 })).toMatchObject({ ok: false, code: "VALIDATION_ERROR" });
  });

  it("returns cancellation without persisting a partial result", async () => {
    const engine: OcrEngine = {
      name: "测试引擎",
      model: "测试模型",
      async recognize() {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { width: 1, height: 1, orientation: 0, lines: [] };
      },
    };
    const module = createOcrModule(dataHome, engine);
    close = module.close;
    const controller = new AbortController();
    controller.abort();
    await expect(module.recognizePage({ bookId: BOOK_ID, page: 1, imageData: "a", width: 1, height: 1 }, controller.signal)).resolves.toMatchObject({ ok: false, code: "CANCELLED" });
    expect(module.getPage(BOOK_ID, 1)).toBeUndefined();
  });

  it("coalesces concurrent requests for the same page and reuses an identical cached input", async () => {
    let calls = 0;
    const engine: OcrEngine = {
      name: "测试引擎",
      model: "测试模型",
      version: "1",
      inputVersion: "input-1",
      async recognize(input) {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { width: input.width, height: input.height, orientation: 0, lines: [] };
      },
    };
    const module = createOcrModule(dataHome, engine);
    close = module.close;
    const input = { bookId: BOOK_ID, page: 1, imageData: "aGVsbG8=", width: 10, height: 10 };
    const [first, second] = await Promise.all([module.recognizePage(input), module.recognizePage(input)]);
    expect(first).toEqual(second);
    await module.recognizePage(input);
    expect(calls).toBe(1);
  });
});
