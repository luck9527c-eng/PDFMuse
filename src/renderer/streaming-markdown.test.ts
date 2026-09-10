import { describe, expect, it } from "vitest";
import { splitSettledMarkdown } from "./streaming-markdown";

describe("splitSettledMarkdown", () => {
  it("settles completed paragraphs and keeps the growing tail active", () => {
    const text = "第一段完成。\n\n第二段完成。\n\n第三段正在生";
    const { settled, active } = splitSettledMarkdown(text);
    expect(settled).toBe("第一段完成。\n\n第二段完成。\n\n");
    expect(active).toBe("第三段正在生");
  });

  it("never splits inside an open code fence", () => {
    const text = "说明：\n\n```ts\nconst a = 1;\n\nconst b = 2;\n正在输入";
    const { settled, active } = splitSettledMarkdown(text);
    expect(settled).toBe("说明：\n\n");
    expect(active).toContain("```ts");
    expect(active).toContain("const b = 2;");
  });

  it("splits again after a fence closes", () => {
    const text = "说明：\n\n```ts\nconst a = 1;\n```\n\n围栏后的段落正在生";
    const { settled, active } = splitSettledMarkdown(text);
    expect(settled).toContain("```ts");
    expect(settled).toContain("```".replace("```", "```")); // 围栏完整进入前缀
    expect(settled.endsWith("```\n\n")).toBe(true);
    expect(active).toBe("围栏后的段落正在生");
  });

  it("never splits inside an open display formula", () => {
    const text = "推导：\n\n$$\nE = mc^2\n\n\\frac{a}{b}\n正在输入";
    const { settled, active } = splitSettledMarkdown(text);
    expect(settled).toBe("推导：\n\n");
    expect(active).toContain("$$");
    expect(active).toContain("E = mc^2");
  });

  it("returns everything active when no safe boundary exists", () => {
    const { settled, active } = splitSettledMarkdown("一整段没有空行的长文本正在生成");
    expect(settled).toBe("");
    expect(active).toBe("一整段没有空行的长文本正在生成");
  });

  it("is deterministic for identical input so settled prefixes stay stable", () => {
    const text = "A。\n\nB。\n\nC 在长";
    expect(splitSettledMarkdown(text)).toEqual(splitSettledMarkdown(text));
    // 尾部继续增长不改变 settled 的取值
    const grown = `${text}出更多内容`;
    expect(splitSettledMarkdown(grown).settled).toBe(splitSettledMarkdown(text).settled);
  });
});
