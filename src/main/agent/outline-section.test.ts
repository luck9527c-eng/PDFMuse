import { describe, expect, it } from "vitest";

import type { BookOutlineNode } from "../../shared/contracts.js";
import { resolveSectionRange } from "./outline-section.js";

function node(id: string, label: string, page: number | undefined, children: BookOutlineNode[] = []): BookOutlineNode {
  return { id, label, ...(page !== undefined ? { page } : {}), children };
}

// 三章 + 附录结构：第二章的子节跨页，第三章起始页紧接第二章末节；附录无页码。
const TREE: BookOutlineNode[] = [
  node("c1", "第1章", 10, [node("c1-1", "1.1", 10), node("c1-2", "1.2", 15)]),
  node("c2", "第2章", 20, [node("c2-1", "2.1", 20), node("c2-2", "2.2", 28)]),
  node("c3", "第3章", 35),
  node("app", "附录", undefined),
];

describe("resolveSectionRange（T63 章节页码范围解析）", () => {
  it("根章节范围 = 自身起始页到下一章节起始页 − 1（含全部子节）", () => {
    expect(resolveSectionRange(TREE, "c2", 100)).toEqual({ label: "第2章", from: 20, to: 34 });
    expect(resolveSectionRange(TREE, "c3", 100)).toEqual({ label: "第3章", from: 35, to: 100 });
    expect(resolveSectionRange(TREE, "c1", 100)).toEqual({ label: "第1章", from: 10, to: 19 });
  });

  it("子节范围 = 自身起始页到下一同级（或更浅）章节起始页 − 1", () => {
    expect(resolveSectionRange(TREE, "c2-1", 100)).toEqual({ label: "2.1", from: 20, to: 27 });
    expect(resolveSectionRange(TREE, "c2-2", 100)).toEqual({ label: "2.2", from: 28, to: 34 });
    // 末节后面是下一章：以第 3 章起始页为界。
    expect(resolveSectionRange(TREE, "c1-2", 100)).toEqual({ label: "1.2", from: 15, to: 19 });
  });

  it("无页码章节沿用子树第一个页码；整段无页码时 from/to 为 undefined", () => {
    const tree: BookOutlineNode[] = [
      node("front", "前言", undefined, [node("f-1", "序", 3)]),
      node("back", "无页码尾章", undefined),
    ];
    expect(resolveSectionRange(tree, "front", 50)).toEqual({ label: "前言", from: 3, to: 50 });
    const noPages = resolveSectionRange(tree, "back", 50);
    expect(noPages).toEqual({ label: "无页码尾章", from: undefined, to: undefined });
  });

  it("同级无页码节点不构成边界：跳过它继续找下一个有效章节起始", () => {
    const tree: BookOutlineNode[] = [
      node("a", "第1章", 10),
      node("gap", "无页码插章", undefined),
      node("b", "第2章", 30),
    ];
    expect(resolveSectionRange(tree, "a", 99)).toEqual({ label: "第1章", from: 10, to: 29 });
  });

  it("末章无边界时落到 totalPages；起始页不会晚于结束页", () => {
    expect(resolveSectionRange(TREE, "c3", 41)).toEqual({ label: "第3章", from: 35, to: 41 });
  });

  it("未知 id 返回 undefined", () => {
    expect(resolveSectionRange(TREE, "nope", 100)).toBeUndefined();
    expect(resolveSectionRange([], "c1", 100)).toBeUndefined();
  });
});
