import { describe, expect, it } from "vitest";

import { checkCitations } from "./citation-check.js";

function pageTextsBy(map: Record<number, string>) {
  return (page: number) => map[page];
}

/** 已索引书的默认入参形态（indexedPagesCount > 0）。 */
function input(overrides: {
  answerBody: string;
  evidencePages?: readonly number[];
  pageText: (page: number) => string | undefined;
  indexedPagesCount?: number;
}) {
  return {
    answerBody: overrides.answerBody,
    evidencePages: overrides.evidencePages ?? [],
    pageText: overrides.pageText,
    indexedPagesCount: overrides.indexedPagesCount ?? 10,
  };
}

describe("checkCitations（T64 回答引用落地校验，纯函数）", () => {
  it("页码声明：无证据且未索引的页记未落地；有证据或已索引的页放行", () => {
    const result = checkCitations(input({
      answerBody: "结论见第 3 页；另参见第 7 页与第 12 页。",
      evidencePages: [3],
      pageText: pageTextsBy({ 12: "第十二页正文" }),
    }));
    expect(result.pageClaims).toBe(3);
    expect(result.findings).toEqual([{ kind: "page_claim_unindexed", page: 7, excerpt: "第 7 页" }]);
  });

  it("引文命中：归一化（空白/标点/大小写差异）后能在声明页或证据页文本中找到", () => {
    const result = checkCitations(input({
      answerBody: "书中写道「能量守恒定律：孤立系统的总能量保持不变」。",
      evidencePages: [2],
      pageText: pageTextsBy({ 2: "能量守恒定律：孤立系统 的总能量保持不变！" }),
    }));
    expect(result.quotes).toBe(1);
    expect(result.findings).toEqual([]);
  });

  it("书名号《》同样参与引文比对（票面「引号/书名号」双形态）", () => {
    const hit = checkCitations(input({
      answerBody: "本章对应《线性代数与空间解析几何》一节，见第 2 页。",
      evidencePages: [2],
      pageText: pageTextsBy({ 2: "线性代数与空间解析几何（第二版）" }),
    }));
    expect(hit.quotes).toBe(1);
    expect(hit.findings).toEqual([]);

    const miss = checkCitations(input({
      answerBody: "作者在《一本并不存在的书名标题》中这样说，见第 2 页。",
      evidencePages: [2],
      pageText: pageTextsBy({ 2: "完全无关的正文" }),
    }));
    expect(miss.findings).toHaveLength(1);
    expect(miss.findings[0]!.kind).toBe("quote_not_found");
  });

  it("引文未找到：引号内容在语料中无归一化命中即记未落地（excerpt 截断 60 字符）", () => {
    const long = "编造的引文".repeat(20);
    const result = checkCitations(input({
      answerBody: `书中断言「${long}」，并见第 2 页。`,
      evidencePages: [2],
      pageText: pageTextsBy({ 2: "完全无关的正文" }),
    }));
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0]!;
    expect(finding.kind).toBe("quote_not_found");
    if (finding.kind === "quote_not_found") {
      expect(finding.excerpt.length).toBeLessThanOrEqual(61);
      expect(finding.excerpt.endsWith("…")).toBe(true);
    }
  });

  it("短片段跳过：少于 6 字符的引号内容不参与引文比对", () => {
    const result = checkCitations(input({
      answerBody: "术语「熵」与 \"F=ma\" 均为短片段，且正文提及第 2 页。",
      evidencePages: [2],
      pageText: pageTextsBy({ 2: "正文" }),
    }));
    expect(result.quotes).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it("语料全空时引文腿跳过（页码腿已兜住未索引声明）；空正文零检查", () => {
    const skipped = checkCitations(input({
      answerBody: "书中说「某段相当长的编造引文内容」（见第 9 页）。",
      pageText: () => undefined,
    }));
    expect(skipped.findings).toEqual([{ kind: "page_claim_unindexed", page: 9, excerpt: "第 9 页" }]);

    const empty = checkCitations(input({ answerBody: "   ", pageText: () => undefined }));
    expect(empty).toEqual({ pageClaims: 0, quotes: 0, findings: [] });
  });

  it("整书零索引：页码声明全是「索引未建」误报，整体跳过（双轴审查修复）", () => {
    const result = checkCitations(input({
      answerBody: "结论见第 3 页，书中断言「一段相当长的编造引文内容」。",
      pageText: () => undefined,
      indexedPagesCount: 0,
    }));
    expect(result).toEqual({ pageClaims: 0, quotes: 0, findings: [] });
  });
});
