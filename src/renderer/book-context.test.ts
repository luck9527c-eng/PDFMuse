import { describe, expect, it } from "vitest";

import type { BookOutlineNode } from "../shared/contracts";
import { findCurrentChapter } from "./book-context";

const outline: BookOutlineNode[] = [
  {
    id: "chapter-5",
    label: "第五章 存储系统",
    page: 120,
    children: [
      { id: "section-5-1", label: "5.1 概述", page: 120, children: [] },
      { id: "section-5-2", label: "5.2 主存储器的组织", page: 138, children: [] },
    ],
  },
  { id: "chapter-6", label: "第六章 总线", page: 160, children: [] },
];

describe("book context", () => {
  it("returns the most specific outline path for the current page", () => {
    expect(findCurrentChapter(outline, 141)).toBe("第五章 存储系统 > 5.2 主存储器的组织");
  });

  it("returns undefined before the first located heading", () => {
    expect(findCurrentChapter(outline, 1)).toBeUndefined();
  });
});
