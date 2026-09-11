import { describe, expect, it } from "vitest";

import { AI_OUTLINE_BATCH_SIZE, AI_OUTLINE_MAX_PAGES, generateAiOutline, parseAiOutlineResponse } from "./outline-ai.js";

describe("parseAiOutlineResponse", () => {
  it("parses fenced json and normalizes printed pages", () => {
    const parsed = parseAiOutlineResponse(
      '```json\n{"hasToc":true,"tocPages":[3,4,5],"entries":['
      + '{"label":"第一章 函数与极限","level":1,"printedPage":1},'
      + '{"label":"1 窃读记","level":2,"printedPage":"3"},'
      + '{"label":"2* 小苗与大树的对话","level":2,"printedPage":null}'
      + '],"continuesAt":null}\n```',
    );
    expect(parsed).toEqual({
      hasToc: true,
      tocPages: [3, 4, 5],
      continuesAt: undefined,
      entries: [
        { label: "第一章 函数与极限", level: 1, printedPage: 1 },
        { label: "1 窃读记", level: 2, printedPage: 3 },
        { label: "2* 小苗与大树的对话", level: 2, printedPage: undefined },
      ],
    });
  });

  it("drops invalid entries but keeps the rest", () => {
    const parsed = parseAiOutlineResponse(
      '{"hasToc":true,"entries":['
      + '{"label":"x","level":1},'
      + '{"label":"好条目","level":1,"printedPage":5},'
      + '{"label":"坏级别","level":3},'
      + '{"label":"页码越界","level":2,"printedPage":99999},'
      + 'null],'
      + '"tocPages":[3,"x",0,5,3],'
      + '"continuesAt":13}',
    );
    expect(parsed?.entries).toEqual([
      { label: "好条目", level: 1, printedPage: 5 },
      // 页码越界的条目保留（标签仍有价值），页码置空交由装配期继承。
      { label: "页码越界", level: 2, printedPage: undefined },
    ]);
    expect(parsed?.tocPages).toEqual([3, 5]);
    expect(parsed?.continuesAt).toBe(13);
  });

  it("rejects responses without json and reports no toc", () => {
    expect(parseAiOutlineResponse("这本书没有目录页。")).toBeUndefined();
    expect(parseAiOutlineResponse('{"hasToc":false,"entries":[],"tocPages":[],"continuesAt":null}'))
      .toEqual({ hasToc: false, entries: [], tocPages: [], continuesAt: undefined });
  });
});

describe("generateAiOutline", () => {
  const render = async () => ({ imageData: "aW1n" });

  it("renders one batch capped by page count", async () => {
    const calls: number[][] = [];
    const result = await generateAiOutline({
      pageCount: 8,
      renderPage: render,
      complete: async (input) => {
        calls.push(input.pages);
        return '{"hasToc":true,"entries":[{"label":"第一章","level":1,"printedPage":1}],"continuesAt":null}';
      },
    });
    expect(result.hasToc).toBe(true);
    expect(result.entries).toEqual([{ label: "第一章", level: 1, printedPage: 1 }]);
    expect(result.tocPages).toEqual([]);
    expect(calls).toEqual([[1, 2, 3, 4, 5, 6, 7, 8]]);
    expect(calls[0]!.length).toBeLessThanOrEqual(AI_OUTLINE_BATCH_SIZE);
  });

  it("extends to a second batch from continuesAt and dedupes entries", async () => {
    const calls: number[][] = [];
    let call = 0;
    const result = await generateAiOutline({
      pageCount: 30,
      renderPage: render,
      complete: async (input) => {
        calls.push(input.pages);
        call += 1;
        if (call === 1) {
          return '{"hasToc":true,"tocPages":[12],"entries":[{"label":"第一章","level":1,"printedPage":1}],"continuesAt":16}';
        }
        // 第二批把 tocPages 写成了批内图片序号（1、2），要按批起点换算成 16、17。
        return '{"hasToc":true,"tocPages":[1,2],"entries":[{"label":"第一章","level":1,"printedPage":1},{"label":"第二章","level":1,"printedPage":50}],"continuesAt":null}';
      },
    });
    expect(calls).toEqual([
      Array.from({ length: 12 }, (_, index) => index + 1),
      // 页数上限 24：第二批从 continuesAt=16 渲染到 24 为止。
      Array.from({ length: 9 }, (_, index) => index + 16),
    ]);
    expect(result.entries.map((entry) => entry.label)).toEqual(["第一章", "第二章"]);
    expect(result.tocPages).toEqual([12, 16, 17]);
  });

  it("treats unparseable model output as failure instead of a no-toc verdict", async () => {
    await expect(generateAiOutline({
      pageCount: 5,
      renderPage: render,
      complete: async () => "抱歉，我无法完成这个任务。",
    })).rejects.toThrow("目录 JSON");
  });

  it("stops after the first batch when no toc is found", async () => {
    let calls = 0;
    const result = await generateAiOutline({
      pageCount: 30,
      renderPage: render,
      complete: async () => {
        calls += 1;
        return '{"hasToc":false,"entries":[],"continuesAt":null}';
      },
    });
    expect(result).toEqual({ hasToc: false, entries: [], tocPages: [], aborted: false });
    expect(calls).toBe(1);
  });

  it("never renders beyond the page cap", async () => {
    const calls: number[][] = [];
    let call = 0;
    const result = await generateAiOutline({
      pageCount: 100,
      renderPage: render,
      complete: async (input) => {
        calls.push(input.pages);
        call += 1;
        return call === 1
          ? '{"hasToc":true,"entries":[{"label":"A章","level":1,"printedPage":1}],"continuesAt":20}'
          : '{"hasToc":true,"entries":[{"label":"B章","level":1,"printedPage":40}],"continuesAt":30}';
      },
    });
    expect(calls[1]!.at(-1)).toBe(AI_OUTLINE_MAX_PAGES);
    expect(result.entries.map((entry) => entry.label)).toEqual(["A章", "B章"]);
  });

  it("returns partial entries when aborted mid-render", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await generateAiOutline({
      pageCount: 30,
      renderPage: async () => {
        throw new Error("不应该渲染");
      },
      complete: async () => '{"hasToc":true,"entries":[],"continuesAt":null}',
      signal: controller.signal,
    });
    // 中止的半成品必须带 aborted 标记，调用方不得当结论缓存。
    expect(result).toEqual({ hasToc: false, entries: [], tocPages: [], aborted: true });
  });
});
