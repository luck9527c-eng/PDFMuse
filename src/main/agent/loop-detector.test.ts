import { describe, expect, it } from "vitest";

import {
  argsKeyOf,
  detectRepeat,
  hashPayload,
  makeFingerprintEntry,
  payloadChars,
  pushFingerprintEntry,
  resultStubText,
  FINGERPRINT_WINDOW_SIZE,
  type FingerprintEntry,
  type ToolPayload,
} from "./loop-detector.js";

const BIG = "x".repeat(600);
const SMALL = "没有找到相关内容。";

function entry(callId: string, toolName: string, params: unknown, payload: ToolPayload): FingerprintEntry {
  return makeFingerprintEntry({ callId, toolName, params, payload });
}

function payload(text: string, images: string[] = []): ToolPayload {
  return { text, images };
}

/** 模拟宿主的判定-入窗序列：返回逐次判定结果。 */
function runSequence(calls: Array<{ callId: string; toolName?: string; params?: unknown; payload: ToolPayload }>) {
  const verdicts = [];
  let window: FingerprintEntry[] = [];
  for (const call of calls) {
    const toolName = call.toolName ?? "book_search";
    const params = call.params ?? { query: "同一检索" };
    const verdict = detectRepeat({ window, toolName, callId: call.callId, params, payload: call.payload });
    window = pushFingerprintEntry(window, entry(call.callId, toolName, params, call.payload));
    verdicts.push(verdict);
  }
  return verdicts;
}

describe("loop detector", () => {
  it("classifies same-args same-result as param loop with silent stub at e=2 when payload >= 512", () => {
    const verdicts = runSequence([
      { callId: "c1", payload: payload(BIG) },
      { callId: "c2", payload: payload(BIG) },
    ]);
    expect(verdicts[0]).toMatchObject({ chainKind: "new-info", e: 1, delivery: "full" });
    expect(verdicts[1]).toMatchObject({ chainKind: "param-loop", e: 2, delivery: "stub" });
    expect(verdicts[1]!.stubText).toContain("tool_call_id c1");
    expect(verdicts[1]!.stubText).toContain("has not changed");
  });

  it("param loop e=3 appends the repeat warning and e=4 force-finalizes", () => {
    const verdicts = runSequence([
      { callId: "c1", payload: payload(BIG) },
      { callId: "c2", payload: payload(BIG) },
      { callId: "c3", payload: payload(BIG) },
      { callId: "c4", payload: payload(BIG) },
    ]);
    expect(verdicts[2]).toMatchObject({ chainKind: "param-loop", e: 3, delivery: "stub" });
    expect(verdicts[2]!.warningText).toContain("第 3 次一模一样的调用");
    expect(verdicts[2]!.stubText).toContain("tool_call_id c1");
    expect(verdicts[3]).toMatchObject({ chainKind: "param-loop", e: 4, delivery: "stub" });
    expect(verdicts[3]!.finalizeText).toContain("第 4 次重复同一调用");
  });

  it("param loop below 512 keeps full text at e=2 and only warns at e=3 (three empty searches are not killed)", () => {
    const verdicts = runSequence([
      { callId: "c1", payload: payload(SMALL) },
      { callId: "c2", payload: payload(SMALL) },
      { callId: "c3", payload: payload(SMALL) },
    ]);
    expect(verdicts[1]).toMatchObject({ chainKind: "param-loop", e: 2, delivery: "full" });
    expect(verdicts[2]).toMatchObject({ chainKind: "param-loop", e: 3, delivery: "stub" });
    expect(verdicts[2]!.warningText).toBeDefined();
    expect(verdicts[2]!.finalizeText).toBeUndefined();
  });

  it("classifies different-args same-result as result loop only when payload >= 512; e=3 force-finalizes", () => {
    const verdicts = runSequence([
      { callId: "c1", params: { query: "甲" }, payload: payload(BIG) },
      { callId: "c2", params: { query: "乙" }, payload: payload(BIG) },
      { callId: "c3", params: { query: "丙" }, payload: payload(BIG) },
    ]);
    expect(verdicts[1]).toMatchObject({ chainKind: "result-loop", e: 2, delivery: "stub" });
    expect(verdicts[1]!.stubText).toContain("even with different arguments");
    expect(verdicts[1]!.stubText).toContain("The tool has no more to give");
    expect(verdicts[2]).toMatchObject({ chainKind: "result-loop", e: 3 });
    expect(verdicts[2]!.finalizeText).toContain("拿不到新信息");
  });

  it("constant short results with different args never enter the result chain", () => {
    const verdicts = runSequence([
      { callId: "c1", params: { query: "甲" }, payload: payload(SMALL) },
      { callId: "c2", params: { query: "乙" }, payload: payload(SMALL) },
      { callId: "c3", params: { query: "丙" }, payload: payload(SMALL) },
    ]);
    for (const verdict of verdicts) {
      expect(verdict).toMatchObject({ chainKind: "new-info", delivery: "full" });
    }
  });

  it("same args with a different result opens a new chain at e=1", () => {
    const verdicts = runSequence([
      { callId: "c1", payload: payload(BIG) },
      { callId: "c2", payload: payload(BIG) },
      { callId: "c3", payload: payload(`${BIG}新信息`) },
    ]);
    expect(verdicts[1]).toMatchObject({ chainKind: "param-loop", e: 2 });
    expect(verdicts[2]).toMatchObject({ chainKind: "new-info", e: 1, delivery: "full" });
  });

  it("page order is preserved: [1,2] and [2,1] are different arguments", () => {
    const first = entry("c1", "read_pages", { pages: [1, 2] }, payload(BIG));
    const reordered = detectRepeat({
      window: [first],
      toolName: "read_pages",
      callId: "c2",
      params: { pages: [2, 1] },
      payload: payload(BIG),
    });
    // 参数不同 → 不构成参数循环；同果 ≥512 → 结果循环候选。
    expect(reordered.chainKind).toBe("result-loop");
    const sameOrder = detectRepeat({
      window: [first],
      toolName: "read_pages",
      callId: "c3",
      params: { pages: [1, 2] },
      payload: payload(BIG),
    });
    expect(sameOrder.chainKind).toBe("param-loop");
  });

  it("mixed chain keeps e counting and N wording separate", () => {
    // 窗口：同果异参一条 + 同果同参一条；再来同参同果 → e=3（链），N=2（同参）。
    const window = [
      entry("c1", "book_search", { query: "甲" }, payload(BIG)),
      entry("c2", "book_search", { query: "乙" }, payload(BIG)),
    ];
    const verdict = detectRepeat({ window, toolName: "book_search", callId: "c3", params: { query: "乙" }, payload: payload(BIG) });
    expect(verdict).toMatchObject({ chainKind: "param-loop", e: 3, repeatCount: 2 });
    expect(verdict.warningText).toContain("第 2 次一模一样的调用");
  });

  it("entries sliding out of the window reset the chain", () => {
    // 填满窗口使首条滑出；滑出后的同参同果按 e=1 全文重取。
    const calls: Array<{ callId: string; payload: ToolPayload }> = [
      { callId: "target", payload: payload(BIG) },
    ];
    for (let index = 0; index < FINGERPRINT_WINDOW_SIZE; index += 1) {
      calls.push({ callId: `filler-${index}`, payload: payload(`其他结果 ${index} ${BIG}`) });
    }
    calls.push({ callId: "again", payload: payload(BIG) });
    const verdicts = runSequence(calls);
    expect(verdicts.at(-1)).toMatchObject({ chainKind: "new-info", e: 1, delivery: "full" });
  });

  it("single-flight brothers take chain positions in arrival order (e=1 full then e=2 stub)", () => {
    // 并行批同（工具, 参数）：首个到达 e=1 全文，兄弟 e=2 stub——判定按到达次序串行化即得。
    const verdicts = runSequence([
      { callId: "brother-a", payload: payload(BIG) },
      { callId: "brother-b", payload: payload(BIG) },
    ]);
    expect(verdicts[0]).toMatchObject({ e: 1, delivery: "full" });
    expect(verdicts[1]).toMatchObject({ e: 2, delivery: "stub" });
    expect(verdicts[1]!.stubText).toContain("tool_call_id brother-a");
  });

  it("image payloads hash and compare over image bytes and stubs append the re-fetch line", () => {
    const imageA = "a".repeat(800); // ≥512 字节载荷，e=2 起满足 stub 门槛
    const first = entry("c1", "read_page_image", { pages: [3] }, payload("第 3 页原图说明", [imageA]));
    const sameBytes = detectRepeat({
      window: [first],
      toolName: "read_page_image",
      callId: "c2",
      params: { pages: [3] },
      payload: payload("第 3 页原图说明", [imageA]),
    });
    expect(sameBytes).toMatchObject({ chainKind: "param-loop", e: 2, delivery: "stub" });
    expect(sameBytes.stubText).toContain("...includes page images; re-call read_page_image with the same pages to fetch them.");
    // 图块字节不同 → 新链。
    const differentImage = detectRepeat({
      window: [first],
      toolName: "read_page_image",
      callId: "c3",
      params: { pages: [3] },
      payload: payload("第 3 页原图说明", ["b".repeat(800)]),
    });
    expect(differentImage).toMatchObject({ chainKind: "new-info", e: 1 });
    // 文本相同但图块数不同 → 新链。
    const missingImage = detectRepeat({
      window: [first],
      toolName: "read_page_image",
      callId: "c4",
      params: { pages: [3] },
      payload: payload("第 3 页原图说明", []),
    });
    expect(missingImage).toMatchObject({ chainKind: "new-info", e: 1 });
  });

  it("annotation-layer text never enters the payload hash (echo changes still detect repeats)", () => {
    // 注解（额度回显）在第一层之外：同载荷 + 不同注解 → 哈希与字节比对均不受影响。
    const base = payload("第 3 页原图说明");
    const hash = hashPayload(base);
    expect(hashPayload(payload(`${base.text}本问图片预算：已用 1/20 页。`))).not.toBe(hash);
    expect(hashPayload(base)).toBe(hash);
    // 宿主按「裸载荷入指纹、注解后置」执行——此处锁死：同裸载荷两次调用必同哈希。
    const first = entry("c1", "read_page_image", { pages: [3] }, base);
    const second = detectRepeat({
      window: [first],
      toolName: "read_page_image",
      callId: "c2",
      params: { pages: [3] },
      payload: base,
    });
    expect(second.chainKind).toBe("param-loop");
  });

  it("args preview collapses whitespace and truncates to 120 chars", () => {
    const argsKey = argsKeyOf({ query: `甲${"乙丙丁 ".repeat(60)}` });
    const stub = resultStubText({
      pointedTo: entry("c1", "book_search", argsKey, payload(BIG)),
      resultLoop: false,
      hasImages: false,
    });
    const preview = /Args: (.+)$/.exec(stub)?.[1] ?? "";
    expect(preview.length).toBeLessThanOrEqual(120);
    expect(preview).not.toMatch(/\s{2,}/);
  });

  it("payload chars count text plus image bytes", () => {
    expect(payloadChars(payload("abcd"))).toBe(4);
    // aGVsbG8= 为 8 字符 base64 → 6 字节。
    expect(payloadChars(payload("abcd", ["aGVsbG8="]))).toBe(10);
  });
});
