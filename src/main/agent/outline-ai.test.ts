import { describe, expect, it } from "vitest";

import { AI_OUTLINE_BATCH_SIZE, AI_OUTLINE_PAGE_LIMIT, generateAiOutline, parseAiOutlineResponse, type TocPageText } from "./outline-ai.js";

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

  it("accepts three-level entries and drops invalid ones", () => {
    const parsed = parseAiOutlineResponse(
      '{"hasToc":true,"entries":['
      + '{"label":"x","level":1},'
      + '{"label":"好条目","level":1,"printedPage":5},'
      + '{"label":"1.1 主存储器","level":2,"printedPage":8},'
      + '{"label":"1.1.1 技术指标","level":3,"printedPage":9},'
      + '{"label":"坏级别","level":4},'
      + '{"label":"页码越界","level":2,"printedPage":99999},'
      + 'null],'
      + '"tocPages":[3,"x",0,5,3],'
      + '"continuesAt":13}',
    );
    expect(parsed?.entries).toEqual([
      { label: "好条目", level: 1, printedPage: 5 },
      { label: "1.1 主存储器", level: 2, printedPage: 8 },
      { label: "1.1.1 技术指标", level: 3, printedPage: 9 },
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
  const pageText = (page: number): TocPageText => ({ page, lines: [`第 ${page} 页的识别文字行`], source: "ocr" });

  it("batches located candidate pages and attaches per-page text to the call", async () => {
    const calls: Array<{ pages: number[]; texts: TocPageText[]; images: number }> = [];
    const result = await generateAiOutline({
      pageCount: 8,
      candidatePages: [2, 3, 5],
      readPageText: pageText,
      renderPage: render,
      complete: async (input) => {
        calls.push({ pages: input.pages, texts: input.texts, images: input.images.length });
        return '{"hasToc":true,"entries":[{"label":"第一章","level":1,"printedPage":1}],"continuesAt":null}';
      },
    });
    expect(result.hasToc).toBe(true);
    expect(result.entries).toEqual([{ label: "第一章", level: 1, printedPage: 1 }]);
    expect(calls).toEqual([
      {
        pages: [2, 3, 5],
        texts: [pageText(2), pageText(3), pageText(5)],
        images: 3,
      },
    ]);
    expect(calls[0]!.pages.length).toBeLessThanOrEqual(AI_OUTLINE_BATCH_SIZE);
  });

  it("extends to a continuation batch from continuesAt and dedupes entries", async () => {
    const calls: number[][] = [];
    let call = 0;
    const result = await generateAiOutline({
      pageCount: 30,
      candidatePages: [12, 13, 14],
      readPageText: pageText,
      renderPage: render,
      complete: async (input) => {
        calls.push(input.pages);
        call += 1;
        if (call === 1) {
          return '{"hasToc":true,"tocPages":[1],"entries":[{"label":"第一章","level":1,"printedPage":1}],"continuesAt":16}';
        }
        // 第二批把 tocPages 写成了批内图片序号（1、2），要按批起点换算成 16、17。
        return '{"hasToc":true,"tocPages":[1,2],"entries":[{"label":"第一章","level":1,"printedPage":1},{"label":"第二章","level":1,"printedPage":50}],"continuesAt":null}';
      },
    });
    expect(calls).toEqual([[12, 13, 14], [16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27]]);
    expect(result.entries.map((entry) => entry.label)).toEqual(["第一章", "第二章"]);
    expect(result.tocPages).toEqual([12, 16, 17]);
  });

  it("caps continuation pages at the page limit", async () => {
    const calls: number[][] = [];
    let call = 0;
    await generateAiOutline({
      pageCount: 100,
      candidatePages: [29, 30, 31],
      readPageText: pageText,
      renderPage: render,
      complete: async (input) => {
        calls.push(input.pages);
        call += 1;
        return call === 1
          ? '{"hasToc":true,"entries":[{"label":"A章","level":1,"printedPage":1}],"continuesAt":45}'
          : '{"hasToc":true,"entries":[{"label":"B章","level":1,"printedPage":40}],"continuesAt":null}';
      },
    });
    expect(calls[1]!.at(-1)).toBe(AI_OUTLINE_PAGE_LIMIT);
  });

  it("treats unparseable model output as failure instead of a no-toc verdict", async () => {
    await expect(generateAiOutline({
      pageCount: 5,
      candidatePages: [1, 2],
      readPageText: pageText,
      renderPage: render,
      complete: async () => "抱歉，我无法完成这个任务。",
    })).rejects.toThrow("目录 JSON");
  });

  it("stops after the first batch when no toc is found", async () => {
    let calls = 0;
    const result = await generateAiOutline({
      pageCount: 30,
      candidatePages: [3, 4],
      readPageText: pageText,
      renderPage: render,
      complete: async () => {
        calls += 1;
        return '{"hasToc":false,"entries":[],"continuesAt":null}';
      },
    });
    expect(result).toEqual({ hasToc: false, entries: [], tocPages: [], aborted: false });
    expect(calls).toBe(1);
  });

  it("returns partial entries when aborted mid-render", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await generateAiOutline({
      pageCount: 30,
      candidatePages: [1, 2, 3],
      readPageText: pageText,
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
