// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useBookText } from "./use-book-text";
import type { OpenedPdfBook, PDFMuseApi, RecognizedPageText } from "../shared/contracts";
import { MINERU_INPUT_VERSION } from "../shared/mineru-config";
import type { PdfViewerHandle } from "./pdf/PdfViewer";

const BOOK: OpenedPdfBook = {
  id: "b".repeat(64),
  name: "测试书",
  path: "C:/book.pdf",
  pageCount: 5,
  currentPage: 2,
  readingState: { page: 2, scrollTop: 0, zoomMode: "page-width", zoomScale: 100, leftSidebarOpen: true, rightSidebarOpen: true },
  bytes: new Uint8Array(),
};

function recognized(page: number): RecognizedPageText {
  return {
    bookId: BOOK.id,
    page,
    blocks: [{ type: "text", text: `第${page}页文字`, bbox: [0.1, 0.1, 0.9, 0.2] }],
    engine: "e",
    model: "m",
    inputHash: "h",
    inputVersion: MINERU_INPUT_VERSION,
    engineVersion: "1",
    createdAt: "2026-09-14T00:00:00.000Z",
  };
}

type ProbeProps = {
  book: OpenedPdfBook | undefined;
  page: number;
  renderRevision: number;
  viewer: { current: PdfViewerHandle | null };
};

let latest: ReturnType<typeof useBookText>;
function Probe(props: ProbeProps) {
  latest = useBookText(props);
  return null;
}

function makeViewer(hasNativeText: (page: number) => Promise<boolean>): PdfViewerHandle {
  return {
    hasNativeText,
  } as unknown as PdfViewerHandle;
}

function installApi(overrides: { preflightWarnings?: string[]; embedding?: { baseUrl: string; model: string; hasApiKey: boolean } } = {}) {
  const scheduled: Array<Record<string, unknown> & { kind: string; priority: number }> = [];
  const recognizeCalls: number[] = [];
  let cached: RecognizedPageText | undefined;
  let holdNext = false;
  let releaseHeld: (() => void) | undefined;
  const api = {
    getStartupPreflight: async () => ({ ok: true, dataHome: "test", warnings: overrides.preflightWarnings ?? [] }),
    scheduleBackgroundJob: async (input: Record<string, unknown> & { kind: string; priority: number }) => {
      scheduled.push(input);
      return { ok: true, job: { id: `job-${scheduled.length}` } };
    },
    getEmbeddingConnection: async () => overrides.embedding ?? { baseUrl: "", model: "", hasApiKey: false },
    getRecognizedPage: async (_bookId: string, page: number) => (cached?.page === page ? cached : undefined),
    recognizePage: async (input: { page: number }) => {
      recognizeCalls.push(input.page);
      const page = recognized(input.page);
      if (!holdNext) {
        cached = page;
        return { ok: true, page };
      }
      holdNext = false;
      return new Promise<{ ok: true; page: RecognizedPageText }>((resolve) => {
        releaseHeld = () => {
          cached = page;
          resolve({ ok: true, page });
        };
      });
    },
  } as unknown as PDFMuseApi;
  vi.stubGlobal("pdfMuse", api);
  return {
    scheduled,
    recognizeCalls,
    setCached: (page: RecognizedPageText) => { cached = page; },
    holdNextRecognition: () => { holdNext = true; },
    releasePending: () => releaseHeld?.(),
  };
}

describe("useBookText", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function renderProbe(props: ProbeProps) {
    act(() => root.render(<Probe {...props} />));
    return {
      rerender(next: ProbeProps) {
        act(() => root.render(<Probe {...next} />));
      },
    };
  }

  it("自动识别无原生文本的当前页并按下一页、上一页预取邻页", async () => {
    const env = installApi();
    const viewer = { current: makeViewer(async () => false) };
    renderProbe({ book: BOOK, page: 2, renderRevision: 0, viewer });
    await vi.waitFor(() => expect(latest.recognizedPage?.page).toBe(2));
    await vi.waitFor(() => expect(env.recognizeCalls).toEqual([2, 3, 1]));
  });

  it("缓存命中的页面不重复识别，重渲染修订后复查仍走缓存", async () => {
    const env = installApi();
    env.setCached(recognized(2));
    // 只有第 2 页缺原生文本：邻页有原生文本，不触发预取识别。
    const viewer = { current: makeViewer(async (page) => page !== 2) };
    const harness = renderProbe({ book: BOOK, page: 2, renderRevision: 0, viewer });
    await vi.waitFor(() => expect(latest.recognizedPage?.page).toBe(2));
    harness.rerender({ book: BOOK, page: 2, renderRevision: 1, viewer });
    await vi.waitFor(() => expect(latest.recognizedPage?.page).toBe(2));
    expect(env.recognizeCalls).toEqual([]);
  });

  it("有原生文本的页面不触发识别", async () => {
    const env = installApi();
    const viewer = { current: makeViewer(async () => true) };
    renderProbe({ book: BOOK, page: 2, renderRevision: 0, viewer });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(env.recognizeCalls).toEqual([]);
    expect(latest.recognizedPage).toBeUndefined();
  });

  it("同一页的并发请求只识别一次", async () => {
    const env = installApi();
    const viewer = { current: makeViewer(async () => false) };
    env.holdNextRecognition();
    renderProbe({ book: BOOK, page: 2, renderRevision: 0, viewer });
    await vi.waitFor(() => expect(env.recognizeCalls).toEqual([2]));
    // 自动识别仍在挂起时手动触发：应复用同一请求而不是二次识别。
    await act(async () => { void latest.recognizeCurrentPage(); });
    expect(env.recognizeCalls).toEqual([2]);
    env.releasePending();
    await vi.waitFor(() => expect(latest.recognizedPage?.page).toBe(2));
  });

  it("开书调度按门控排任务：OCR 未安装且嵌入未配置时只排索引与目录", async () => {
    const env = installApi({ preflightWarnings: ["尚未安装 OCR 工作进程资源"] });
    renderProbe({ book: BOOK, page: 2, renderRevision: 0, viewer: { current: makeViewer(async () => true) } });
    await vi.waitFor(() => expect(env.scheduled).toHaveLength(2));
    expect(env.scheduled.map((job) => [job.kind, job.priority])).toEqual([["index", 10], ["outline", 5]]);
  });

  it("OCR 可用且嵌入已配置时四类任务全排，OCR 以当前页为起点", async () => {
    const env = installApi({ embedding: { baseUrl: "http://127.0.0.1:9", model: "e", hasApiKey: false } });
    renderProbe({ book: BOOK, page: 2, renderRevision: 0, viewer: { current: makeViewer(async () => true) } });
    await vi.waitFor(() => expect(env.scheduled).toHaveLength(4));
    expect(env.scheduled.map((job) => [job.kind, job.priority])).toEqual([
      ["index", 10],
      ["outline", 5],
      ["ocr", 20],
      ["embedding", 0],
    ]);
    const ocrJob = env.scheduled.find((job) => job.kind === "ocr");
    expect(ocrJob).toMatchObject({ maxAttempts: 3, inputVersion: MINERU_INPUT_VERSION });
  });
});
