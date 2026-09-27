// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OutlinePanel } from "./OutlinePanel";
import type { BookOutlineNode } from "../../shared/contracts";

function buildTree(): BookOutlineNode[] {
  return Array.from({ length: 12 }, (_, chapter) => ({
    id: `ch-${chapter + 1}`,
    label: `第${chapter + 1}章`,
    page: chapter * 10 + 1,
    children: Array.from({ length: 5 }, (_, section) => ({
      id: `sec-${chapter + 1}-${section + 1}`,
      label: `${chapter + 1}.${section + 1} 节`,
      page: chapter * 10 + section + 1,
      children: [],
    })),
  }));
}

type PanelProps = Parameters<typeof OutlinePanel>[0];

describe("OutlinePanel", () => {
  let container: HTMLDivElement;
  let root: Root | undefined;
  let scrollWrites: number;

  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    container = document.createElement("div");
    container.className = "left-sidebar-content";
    document.body.appendChild(container);
    scrollWrites = 0;
    Object.defineProperty(container, "scrollTop", {
      get: () => 0,
      set: () => { scrollWrites += 1; },
      configurable: true,
    });
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    container.remove();
    vi.unstubAllGlobals();
  });

  function render(props: PanelProps) {
    if (!root) root = createRoot(container);
    act(() => root!.render(<OutlinePanel {...props} />));
  }

  async function rerender(props: PanelProps) {
    await act(async () => {
      root!.render(<OutlinePanel {...props} />);
    });
  }

  function toggle(id: string) {
    const button = container.querySelector<HTMLElement>(`[data-outline-id="${id}"] .outline-toggle`);
    expect(button).toBeTruthy();
    act(() => button!.click());
  }

  function isExpanded(id: string) {
    return container.querySelector(`[data-outline-id="${id}"]`) !== null;
  }

  const baseProps = (nodes: BookOutlineNode[], page: number): PanelProps => ({
    nodes,
    strategy: "embedded",
    page,
    emptyMessage: "未检测到可用章节。",
    onGoToPage: () => undefined,
  });

  it("keeps user collapse across poll-driven identity churn", async () => {
    const tree = buildTree();
    render(baseProps(tree, 1));
    expect(isExpanded("sec-2-1")).toBe(true);
    toggle("ch-2");
    expect(isExpanded("sec-2-1")).toBe(false);

    // 后台任务 1.5s 轮询：IPC 返回同内容的新数组（身份全新）。
    await rerender(baseProps(structuredClone(tree), 1));

    expect(isExpanded("sec-2-1")).toBe(false);
    expect(isExpanded("sec-3-1")).toBe(true);
  });

  it("does not write scroll on poll-driven identity churn", async () => {
    const tree = buildTree();
    render(baseProps(tree, 1));
    scrollWrites = 0;

    for (let tick = 0; tick < 3; tick += 1) {
      await rerender(baseProps(structuredClone(tree), 1));
    }

    expect(scrollWrites).toBe(0);
  });

  it("expands the path of the newly active chapter on page change", async () => {
    const tree = buildTree();
    render(baseProps(tree, 1));
    toggle("ch-3");
    expect(isExpanded("sec-3-1")).toBe(false);

    await rerender(baseProps(structuredClone(tree), 23));

    expect(isExpanded("sec-3-1")).toBe(true);
    expect(container.querySelector(".outline-row.current")?.getAttribute("data-outline-id")).toBe("sec-3-3");
  });

  it("re-expands everything when the outline structure changes", async () => {
    const tree = buildTree();
    render(baseProps(tree, 1));
    toggle("ch-2");
    expect(isExpanded("sec-2-1")).toBe(false);

    const grown = [...buildTree(), { id: "ch-13", label: "第13章", page: 121, children: [] }];
    await rerender(baseProps(grown, 1));

    expect(isExpanded("sec-2-1")).toBe(true);
    expect(isExpanded("ch-13")).toBe(true);
  });
});
