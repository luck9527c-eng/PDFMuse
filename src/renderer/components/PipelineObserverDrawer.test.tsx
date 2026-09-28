// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PipelineObserverDrawer } from "./PipelineObserverDrawer";
import type {
  BackgroundStateEvent,
  MineruBlock,
  PDFMuseApi,
  PipelineTraceRecord,
  TraceWindowSnapshot,
} from "../../shared/contracts";

const BOOK_ID = "a".repeat(64);

const GATE_RECORD: PipelineTraceRecord = {
  ts: "2026-09-28T10:00:01.000+08:00",
  kind: "embedded_gate",
  data: { accepted: false, entryCount: 0, resolvableCount: 0, distinctPages: 0 },
};
const YIELD_RECORD: PipelineTraceRecord = {
  ts: "2026-09-28T10:00:02.000+08:00",
  kind: "ocr_yield",
  data: {
    trigger: "run-end",
    windowEnd: 30,
    scannedCount: 7,
    probe: [{ page: 5, hasIndexBlock: true }],
  },
};
const AI_RECORD: PipelineTraceRecord = {
  ts: "2026-09-28T10:00:03.000+08:00",
  kind: "ai_call",
  data: {
    outcome: "ok",
    entriesCount: 2,
    tocPages: [2],
    exchanges: [{ prompt: "以下是这本书的目录候选页……请提取其中的目录。", response: '{"hasToc":true}', durationMs: 1200 }],
  },
};
const CACHE_RECORD: PipelineTraceRecord = {
  ts: "2026-09-28T10:00:04.000+08:00",
  kind: "ai_call",
  data: { outcome: "cache", exchanges: [], tocPages: [2], entriesCount: 2 },
};
const LOCATE_RECORD: PipelineTraceRecord = {
  ts: "2026-09-28T10:00:05.000+08:00",
  kind: "locate",
  data: { hits: [2], pages: [1, 2, 3], nativeMajority: false, tocRegionAdjudicated: true, windowEnd: 10 },
};

const SNAPSHOT: TraceWindowSnapshot = {
  windowEnd: 10,
  scannedCount: 4,
  windowCovered: false,
  pages: [
    { page: 1, hasIndexBlock: false, covered: true },
    { page: 2, hasIndexBlock: true, covered: true },
    { page: 3, hasIndexBlock: false, covered: true },
    { page: 4, hasIndexBlock: false, covered: true },
    { page: 5, hasIndexBlock: false, covered: false },
  ],
  lastIndexPage: 2,
  gapPages: [3, 4],
  gapObserved: true,
  yieldReady: true,
};

const JOBS = [
  {
    id: "job-1", bookId: BOOK_ID, kind: "ocr" as const, priority: 20, status: "failed" as const,
    progress: 12, total: 40, checkpoint: "ocr-linear:12", attempts: 3, maxAttempts: 3,
    errorMessage: "识别 worker 无响应。", createdAt: "2026-09-28T10:00:00.000+08:00", updatedAt: "2026-09-28T10:05:00.000+08:00",
  },
];

const BLOCKS: MineruBlock[] = [
  { type: "index", text: "第一章 起点……1", bbox: [0.1, 0.1, 0.9, 0.5] },
  { type: "text", text: "正文内容。", bbox: [0.1, 0.5, 0.9, 0.8] },
];

function fakeApi(options: { events?: PipelineTraceRecord[]; blocks?: MineruBlock[] } = {}) {
  const listeners = new Set<(event: BackgroundStateEvent) => void>();
  const fns = {
    getPipelineTraceEvents: vi.fn(async () => options.events ?? []),
    getTraceWindowSnapshot: vi.fn(async (): Promise<TraceWindowSnapshot> => SNAPSHOT),
    getTraceJobs: vi.fn(async () => JOBS),
    getTracePageBlocks: vi.fn(async () => options.blocks ?? []),
    onBackgroundEvent: vi.fn((listener: (event: BackgroundStateEvent) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }),
  };
  return {
    fns,
    api: fns as unknown as PDFMuseApi,
    emit: (event: BackgroundStateEvent) => { for (const listener of listeners) listener(event); },
  };
}

describe("PipelineObserverDrawer", () => {
  let container: HTMLDivElement;
  let root: Root | undefined;
  const onClose = vi.fn();

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    await act(async () => { root?.unmount(); });
    root = undefined;
    container.remove();
    vi.unstubAllEnvs();
    delete (window as { pdfMuse?: unknown }).pdfMuse;
    onClose.mockReset();
  });

  function render(props: { bookId?: string; page?: number; api?: PDFMuseApi } = {}) {
    window.pdfMuse = props.api ?? fakeApi().api;
    if (!root) root = createRoot(container);
    return act(async () => {
      root!.render(
        <PipelineObserverDrawer
          bookId={props.bookId ?? BOOK_ID}
          page={props.page ?? 1}
          onClose={onClose}
        />,
      );
    });
  }

  it("renders nothing outside dev builds", async () => {
    vi.stubEnv("DEV", false);
    const harness = fakeApi();
    await render({ api: harness.api });
    expect(container.querySelector(".observer-drawer")).toBeNull();
    expect(harness.fns.getPipelineTraceEvents).not.toHaveBeenCalled();
  });

  it("pulls the full dataset on open and renders the timeline with the snapshot pinned on top", async () => {
    vi.stubEnv("DEV", true);
    const harness = fakeApi({ events: [GATE_RECORD, YIELD_RECORD, AI_RECORD] });
    await render({ api: harness.api });
    expect(harness.fns.getPipelineTraceEvents).toHaveBeenCalledWith(BOOK_ID);
    expect(harness.fns.getTraceWindowSnapshot).toHaveBeenCalledWith(BOOK_ID);
    expect(harness.fns.getTraceJobs).toHaveBeenCalledWith(BOOK_ID);
    // 快照固定在时间线顶部：窗口状态、index 页、交棒结论。
    expect(container.querySelector(".observer-snapshot")?.textContent).toContain("探测窗口 1–10");
    expect(container.querySelector(".observer-snapshot")?.textContent).toContain("交棒就绪 是");
    expect(container.querySelector(".observer-page.index")?.textContent).toBe("2");
    // 事件列表正序逐条渲染。
    const rows = [...container.querySelectorAll(".observer-event")];
    expect(rows).toHaveLength(3);
    expect(rows[0]!.getAttribute("data-kind")).toBe("embedded_gate");
    expect(rows[1]!.textContent).toContain("run-end");
    // 点开看完整 JSON。
    (rows[0] as HTMLDetailsElement).open = true;
    expect(rows[0]!.querySelector(".observer-json")?.textContent).toContain("embedded_gate");
  });

  it("filters timeline rows by kind chips", async () => {
    vi.stubEnv("DEV", true);
    const harness = fakeApi({ events: [GATE_RECORD, YIELD_RECORD, LOCATE_RECORD] });
    await render({ api: harness.api });
    expect(container.querySelectorAll(".observer-event")).toHaveLength(3);
    const chip = [...container.querySelectorAll<HTMLButtonElement>(".observer-filter")]
      .find((button) => button.textContent?.includes("OCR 让位"));
    expect(chip).toBeDefined();
    await act(async () => { chip!.click(); });
    const kinds = [...container.querySelectorAll(".observer-event")].map((row) => row.getAttribute("data-kind"));
    expect(kinds).toEqual(["embedded_gate", "locate"]);
    await act(async () => { chip!.click(); });
    expect(container.querySelectorAll(".observer-event")).toHaveLength(3);
  });

  it("shows the empty timeline message when there are no events", async () => {
    vi.stubEnv("DEV", true);
    await render({ api: fakeApi({ events: [] }).api });
    expect(container.querySelector(".observer-timeline .observer-empty")?.textContent).toContain("暂无管线事件");
  });

  it("refetches when a background event for the current book arrives, and stops after unmount", async () => {
    vi.stubEnv("DEV", true);
    const harness = fakeApi({ events: [GATE_RECORD] });
    await render({ api: harness.api });
    expect(harness.fns.getPipelineTraceEvents).toHaveBeenCalledTimes(1);
    await act(async () => {
      harness.emit({ revision: 1, kind: "jobs", bookId: BOOK_ID, jobs: [] });
    });
    expect(harness.fns.getPipelineTraceEvents).toHaveBeenCalledTimes(2);
    // 他书事件不重拉。
    await act(async () => {
      harness.emit({ revision: 2, kind: "jobs", bookId: "b".repeat(64), jobs: [] });
    });
    expect(harness.fns.getPipelineTraceEvents).toHaveBeenCalledTimes(2);
    // 卸载即退订：关闭抽屉后通知不再触发刷新。
    await act(async () => { root!.unmount(); });
    root = undefined;
    await act(async () => {
      harness.emit({ revision: 3, kind: "jobs", bookId: BOOK_ID, jobs: [] });
    });
    expect(harness.fns.getPipelineTraceEvents).toHaveBeenCalledTimes(2);
  });

  it("closes on Escape", async () => {
    vi.stubEnv("DEV", true);
    await render();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders the ai payload tab with the full prompt, raw response and de-emphasized cache entries", async () => {
    vi.stubEnv("DEV", true);
    const harness = fakeApi({ events: [AI_RECORD, CACHE_RECORD] });
    await render({ api: harness.api });
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>(".observer-tabs button")]
        .find((button) => button.textContent === "AI 载荷")!.click();
    });
    const sections = [...container.querySelectorAll(".observer-ai")];
    expect(sections).toHaveLength(2);
    expect(sections[0]!.textContent).toContain("以下是这本书的目录候选页");
    expect(sections[0]!.textContent).toContain('{"hasToc":true}');
    expect(sections[0]!.querySelector(".observer-outcome")?.textContent).toBe("成功");
    expect(sections[0]!.textContent).toContain("1200ms");
    // 缓存命中轻量条目弱化显示。
    expect(sections[1]!.classList.contains("cache")).toBe(true);
    expect(sections[1]!.querySelector(".observer-outcome")?.textContent).toBe("缓存命中");
    expect(sections[1]!.textContent).not.toContain("Prompt 全文");
  });

  it("renders the jobs tab table with expandable failure details", async () => {
    vi.stubEnv("DEV", true);
    await render({ api: fakeApi().api });
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>(".observer-tabs button")]
        .find((button) => button.textContent === "任务流水")!.click();
    });
    const rows = [...container.querySelectorAll(".observer-jobs tbody tr")];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("文字识别");
    expect(rows[0]!.textContent).toContain("12/40");
    expect(rows[0]!.getAttribute("data-status")).toBe("failed");
    expect(rows[0]!.querySelector("details summary")?.textContent).toContain("识别 worker 无响应");
    expect(rows[0]!.querySelector("details pre")?.textContent).toContain("识别 worker 无响应。");
  });

  it("renders the blocks tab with index highlighting and an empty state for unrecognized pages", async () => {
    vi.stubEnv("DEV", true);
    const harness = fakeApi({ blocks: BLOCKS });
    await render({ api: harness.api, page: 2 });
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>(".observer-tabs button")]
        .find((button) => button.textContent === "MinerU 块")!.click();
    });
    expect(harness.fns.getTracePageBlocks).toHaveBeenCalledWith(BOOK_ID, 2);
    const blocks = [...container.querySelectorAll(".observer-block")];
    expect(blocks).toHaveLength(2);
    // index 块高亮。
    expect(blocks[0]!.classList.contains("index")).toBe(true);
    expect(blocks[0]!.querySelector(".observer-block-type")?.textContent).toBe("index");
    expect(blocks[1]!.classList.contains("index")).toBe(false);

    const empty = fakeApi({ blocks: [] });
    await act(async () => { root!.unmount(); });
    root = undefined;
    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);
    await render({ api: empty.api, page: 9 });
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>(".observer-tabs button")]
        .find((button) => button.textContent === "MinerU 块")!.click();
    });
    expect(container.querySelector(".observer-blocks .observer-empty")?.textContent).toContain("第 9 页尚未识别");
  });

  it("follows the reader page while the toggle is on and pins the manual page when off", async () => {
    vi.stubEnv("DEV", true);
    const harness = fakeApi({ blocks: BLOCKS });
    await render({ api: harness.api, page: 2 });
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>(".observer-tabs button")]
        .find((button) => button.textContent === "MinerU 块")!.click();
    });
    expect(harness.fns.getTracePageBlocks).toHaveBeenLastCalledWith(BOOK_ID, 2);
    const followInput = container.querySelector<HTMLInputElement>(".observer-follow input")!;
    expect(followInput.checked).toBe(true);
    // 跟随中：Reader 翻页 → 拉新页。
    await act(async () => {
      root!.render(<PipelineObserverDrawer bookId={BOOK_ID} page={8} onClose={onClose} />);
    });
    expect(harness.fns.getTracePageBlocks).toHaveBeenLastCalledWith(BOOK_ID, 8);
    // 关闭跟随：翻页不再改页码，页码输入框解锁。
    await act(async () => { followInput.click(); });
    expect(followInput.checked).toBe(false);
    expect(container.querySelector<HTMLInputElement>('.observer-blocks-controls input[type="number"]')!.disabled).toBe(false);
    const callsAfterToggle = harness.fns.getTracePageBlocks.mock.calls.length;
    await act(async () => {
      root!.render(<PipelineObserverDrawer bookId={BOOK_ID} page={12} onClose={onClose} />);
    });
    expect(harness.fns.getTracePageBlocks).toHaveBeenLastCalledWith(BOOK_ID, 8);
    expect(harness.fns.getTracePageBlocks.mock.calls.length).toBe(callsAfterToggle);
  });
});
