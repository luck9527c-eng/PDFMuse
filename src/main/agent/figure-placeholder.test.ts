import { describe, expect, it } from "vitest";

import {
  assembleBlockText,
  figureBlocks,
  figurePlaceholderLine,
  isFigurePlaceholderLine,
  stripFigurePlaceholderLines,
} from "./figure-placeholder.js";

describe("figure placeholder", () => {
  it("占位行携带页码、页内编号与面积占比，并给出 view_page 插图级寻址方式", () => {
    // 0.5×0.7 = 35% 页面面积。
    expect(figurePlaceholderLine(35, 3, [0.1, 0.2, 0.6, 0.9]))
      .toBe("[插图 3·约占页面 35%：内容不可见，可用 view_page 查看第 35 页插图 3]");
  });

  it("极小插图至少显示 1%，越界坐标被钳制", () => {
    expect(figurePlaceholderLine(2, 1, [0.5, 0.5, 0.501, 0.502])).toContain("约占页面 1%");
    expect(figurePlaceholderLine(2, 1, [-0.2, -0.2, 1.4, 1.4])).toContain("约占页面 100%");
  });

  it("识别谓词只认占位形状；strip 保留其余行与换行结构", () => {
    const placeholder = figurePlaceholderLine(7, 1, [0, 0, 0.5, 0.5]);
    expect(isFigurePlaceholderLine(placeholder)).toBe(true);
    expect(isFigurePlaceholderLine("[插图x 无空格")).toBe(false);
    expect(isFigurePlaceholderLine("正文里提到 [插图 也不算")).toBe(false);
    const text = `第一段\n${placeholder}\n第二段`;
    expect(stripFigurePlaceholderLines(text)).toBe("第一段\n第二段");
    expect(stripFigurePlaceholderLines(placeholder)).toBe("");
  });

  it("装配：插图块按页内出现顺序编号出占位，文本块原文保留，两套文本逐行对应", () => {
    const assembled = assembleBlockText([
      { type: "text", text: "导言", bbox: [0, 0, 1, 0.1] },
      { type: "image", text: "", bbox: [0.1, 0.2, 0.6, 0.6] },
      { type: "equation", text: "E=mc^{2}", bbox: [0, 0.6, 1, 0.7] },
      { type: "image", text: "", bbox: [0.2, 0.75, 0.3, 0.85] },
    ], 12);
    expect(assembled.text).toBe(
      "导言\n"
      + "[插图 1·约占页面 20%：内容不可见，可用 view_page 查看第 12 页插图 1]\n"
      + "E=mc^{2}\n"
      + "[插图 2·约占页面 1%：内容不可见，可用 view_page 查看第 12 页插图 2]",
    );
    expect(assembled.indexableText).toBe("导言\nE=mc^{2}");
  });

  it("非有限 bbox 的插图块整体跳过：不占编号、不出占位（无法裁剪渲染)", () => {
    const assembled = assembleBlockText([
      { type: "image", text: "", bbox: [Number.NaN, 0.1, 0.9, 0.9] },
      { type: "image", text: "", bbox: [0.5, 0.5, 0.5, 0.9] },
      { type: "image", text: "", bbox: [0.1, 0.1, 0.4, 0.4] },
      { type: "text", text: "正文", bbox: [0, 0.9, 1, 1] },
    ], 3);
    // 只有第三个插图块有效：编号是 1（按有效插图序），不是 3。
    expect(assembled.text).toBe(
      "[插图 1·约占页面 9%：内容不可见，可用 view_page 查看第 3 页插图 1]\n正文",
    );
  });

  it("figureBlocks 只取有限 bbox 的插图块且保持出现顺序（寻址与占位同序）", () => {
    const blocks = [
      { type: "text", text: "a", bbox: [0, 0, 1, 1] as [number, number, number, number] },
      { type: "image", text: "", bbox: [0.1, 0.1, 0.2, 0.2] as [number, number, number, number] },
      { type: "image", text: "", bbox: [0.3, 0.3, 0.4, 0.4] as [number, number, number, number] },
    ];
    expect(figureBlocks(blocks).map((block) => block.bbox)).toEqual([[0.1, 0.1, 0.2, 0.2], [0.3, 0.3, 0.4, 0.4]]);
  });
});
