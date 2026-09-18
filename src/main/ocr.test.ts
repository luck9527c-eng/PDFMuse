import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createOcrModule } from "./ocr.js";
import type { MineruEngine } from "./mineru.js";

const BOOK_ID = "b".repeat(64);
const OTHER_BOOK_ID = "c".repeat(64);

function fakeEngine(overrides: Partial<MineruEngine> = {}): MineruEngine {
  return {
    name: "MinerU Worker",
    model: "basic",
    version: "4.0.2",
    inputVersion: "MinerU:basic:4.0.2",
    async recognizePage(input) {
      expect(input.pdfPath).toBe("C:/book.pdf");
      return {
        blocks: [{ type: "equation", text: "y = \\left| x \\right|", bbox: [0.35, 0.1, 0.54, 0.15] }],
        markdown: "# 第 1 页",
      };
    },
    ...overrides,
  };
}

function fakeDeps(overrides: Partial<Parameters<typeof createOcrModule>[2]> = {}) {
  return {
    resolvePdfPath: (bookId: string) => (
      bookId === OTHER_BOOK_ID ? undefined : { path: "C:/book.pdf", encrypted: false }
    ),
    ...overrides,
  };
}

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

  it("validates, persists and reloads recognized page blocks", async () => {
    const module = createOcrModule(dataHome, fakeEngine(), fakeDeps());
    close = module.close;
    const result = await module.recognizePage({ bookId: BOOK_ID, page: 2 });
    expect(result).toMatchObject({ ok: true, page: { bookId: BOOK_ID, page: 2, engine: "MinerU Worker", engineVersion: "4.0.2" } });
    if (result.ok) expect(result.page.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(module.getPage(BOOK_ID, 2)?.blocks[0]?.text).toBe("y = \\left| x \\right|");
    expect(module.isPageCompatible(BOOK_ID, 2, "4.0.2", "basic")).toBe(true);
    expect(module.isPageCompatible(BOOK_ID, 2, "旧版本", "basic")).toBe(false);
    expect(await module.recognizePage({ bookId: "bad", page: 2 })).toMatchObject({ ok: false, code: "VALIDATION_ERROR" });
    expect(await module.recognizePage({ bookId: OTHER_BOOK_ID, page: 2 })).toMatchObject({ ok: false, code: "VALIDATION_ERROR" });
  });

  it("rejects encrypted books before invoking the engine", async () => {
    const recognizeCalls: number[] = [];
    const engine = fakeEngine({
      async recognizePage(input) {
        recognizeCalls.push(input.page);
        return { blocks: [], markdown: "" };
      },
    });
    const module = createOcrModule(dataHome, engine, {
      resolvePdfPath: (bookId) => (bookId === BOOK_ID ? { path: "C:/secret.pdf", encrypted: true } : undefined),
    });
    close = module.close;
    await expect(module.recognizePage({ bookId: BOOK_ID, page: 1 })).resolves.toMatchObject({ ok: false, code: "UNAVAILABLE" });
    expect(recognizeCalls).toEqual([]);
    expect(module.getPage(BOOK_ID, 1)).toBeUndefined();
  });

  it("returns cancellation without persisting a partial result", async () => {
    const engine = fakeEngine({
      async recognizePage() {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { blocks: [], markdown: "" };
      },
    });
    const module = createOcrModule(dataHome, engine, fakeDeps());
    close = module.close;
    const controller = new AbortController();
    controller.abort();
    await expect(module.recognizePage({ bookId: BOOK_ID, page: 1 }, controller.signal)).resolves.toMatchObject({ ok: false, code: "CANCELLED" });
    expect(module.getPage(BOOK_ID, 1)).toBeUndefined();
  });

  it("coalesces concurrent requests for the same page and reuses an identical cached input", async () => {
    let calls = 0;
    const engine = fakeEngine({
      async recognizePage(input) {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { blocks: [{ type: "text", text: `第${input.page}页`, bbox: [0, 0, 1, 1] }], markdown: "" };
      },
    });
    const module = createOcrModule(dataHome, engine, fakeDeps());
    close = module.close;
    const input = { bookId: BOOK_ID, page: 1 };
    const [first, second] = await Promise.all([module.recognizePage(input), module.recognizePage(input)]);
    expect(first).toEqual(second);
    await module.recognizePage(input);
    expect(calls).toBe(1);
  });

  it("treats rows from another input version as absent", async () => {
    const module = createOcrModule(dataHome, fakeEngine(), fakeDeps());
    close = module.close;
    await module.recognizePage({ bookId: BOOK_ID, page: 1 });
    const connection = new DatabaseSync(path.join(dataHome, "pdfmuse.db"));
    connection.prepare("UPDATE recognized_pages SET input_version = 'RapidOCR:PP-OCRv6-small:legacy' WHERE book_id = ? AND page = 1").run(BOOK_ID);
    connection.close();
    expect(module.getPage(BOOK_ID, 1)?.inputVersion).toBe("RapidOCR:PP-OCRv6-small:legacy");
    expect(module.isPageCompatible(BOOK_ID, 1, "4.0.2", "basic", "MinerU:basic:4.0.2")).toBe(false);
  });

  it("deleteBookData 在给定连接上清掉本书识别页且不影响他书", async () => {
    // 路径断言放宽为本测试的两个书源，第二本书走独立依赖。
    const lenientEngine = fakeEngine({
      async recognizePage(input) {
        expect([BOOK_ID, OTHER_BOOK_ID]).toContain(input.bookId);
        return { blocks: [{ type: "text", text: input.bookId === BOOK_ID ? "本书" : "他书", bbox: [0, 0, 1, 1] }], markdown: "" };
      },
    });
    const module = createOcrModule(dataHome, lenientEngine, fakeDeps());
    close = module.close;
    await module.recognizePage({ bookId: BOOK_ID, page: 1 });
    const otherModule = createOcrModule(dataHome, lenientEngine, {
      resolvePdfPath: (bookId) => (bookId === OTHER_BOOK_ID ? { path: "C:/other.pdf", encrypted: false } : undefined),
    });
    await otherModule.recognizePage({ bookId: OTHER_BOOK_ID, page: 1 });
    otherModule.close();

    const connection = new DatabaseSync(path.join(dataHome, "pdfmuse.db"));
    module.deleteBookData(BOOK_ID, connection);
    connection.close();

    expect(module.getPage(BOOK_ID, 1)).toBeUndefined();
    expect(module.getPage(OTHER_BOOK_ID, 1)).toBeDefined();
  });
});
