// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { renderFormula, renderMarkdownHtml, renderMarkdownWithFormulaSlots, splitFormulas } from "./markdown";

describe("renderMarkdownHtml", () => {
  it("renders GFM basics", () => {
    const html = renderMarkdownHtml("**加粗** 与 `代码`\n\n- 要点一\n- 要点二\n\n```js\nconst x = 1;\n```");
    expect(html).toContain("<strong>加粗</strong>");
    expect(html).toContain("<code>代码</code>");
    expect(html).toContain("<li>要点一</li>");
    expect(html).toContain("<pre><code class=\"language-js\">");
  });

  it("strips scripts and event handlers", () => {
    const html = renderMarkdownHtml('你好<script>alert(1)</script><img src="x" onerror="alert(1)">');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    expect(html).toContain("你好");
  });

  it("neutralizes dangerous link protocols", () => {
    const html = renderMarkdownHtml("[点我](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
  });

  it("forces safe link targets", () => {
    const html = renderMarkdownHtml("[官网](https://example.com)");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer noopener"');
  });

  it("drops form and iframe elements", () => {
    const html = renderMarkdownHtml('<iframe src="https://evil.example"></iframe><form><input></form>');
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<form");
  });
});

describe("splitFormulas", () => {
  it("separates display and inline formulas from text", () => {
    const segments = splitFormulas("质能方程 $$E=mc^2$$ 成立，其中 $c$ 是光速。");
    expect(segments).toEqual([
      { kind: "text", value: "质能方程 " },
      { kind: "formula", value: "E=mc^2", display: true },
      { kind: "text", value: " 成立，其中 " },
      { kind: "formula", value: "c", display: false },
      { kind: "text", value: " 是光速。" },
    ]);
  });

  it("keeps lone dollar signs as text", () => {
    expect(splitFormulas("价格是 $5 和 6 美元")).toEqual([
      { kind: "text", value: "价格是 $5 和 6 美元" },
    ]);
  });
});

describe("renderMarkdownWithFormulaSlots", () => {
  it("keeps bold spans containing inline formulas intact instead of tearing them apart", () => {
    const html = renderMarkdownWithFormulaSlots("**第一道门——根号（来自 $\\sqrt{3-x}$）**");
    expect(html).toContain("<strong>第一道门——根号（来自 <span class=\"formula-slot formula-inline\"");
    expect(html).not.toContain("**");
  });

  it("renders a single continuous paragraph around inline formulas (no per-segment blocks)", () => {
    const html = renderMarkdownWithFormulaSlots("这里 $a$ 和 $b$ 同一段");
    const blocks = html.match(/<p>[\s\S]*?<\/p>/g) ?? [];
    expect(blocks).toHaveLength(1);
    expect(html.match(/class="markdown-body"/g)?.length ?? 0).toBe(0);
    expect((html.match(/formula-slot/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("marks display formulas and puts the LaTeX source in attributes", () => {
    const html = renderMarkdownWithFormulaSlots("推论 $$E=mc^2$$ 成立");
    expect(html).toContain('data-display="1"');
    expect(html).toContain('data-formula="E=mc^2"');
  });

  it("keeps lone dollar signs as plain text", () => {
    const html = renderMarkdownWithFormulaSlots("价格是 $5 和 6 美元");
    expect(html).not.toContain("formula-slot");
    expect(html).toContain("价格是 $5 和 6 美元");
  });

  it("does not treat dollars inside fenced code or inline code as formulas", () => {
    const html = renderMarkdownWithFormulaSlots("代码 `$x$` 与围栏：\n\n```js\nconst s = '$y$';\n```");
    expect(html).not.toContain("formula-slot");
    expect(html).toContain("$y$");
  });
});

describe("renderFormula", () => {
  it("renders LaTeX into katex markup", async () => {
    const katex = await import("katex");
    const html = renderFormula(katex, "\\frac{a}{b}", false);
    expect(html).toContain("katex");
  });

  it("falls back instead of throwing on broken LaTeX", async () => {
    const katex = await import("katex");
    const html = renderFormula(katex, "\\frac{", false);
    expect(typeof html).toBe("string");
  });
});
