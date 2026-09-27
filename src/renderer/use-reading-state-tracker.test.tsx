// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useReadingStateTracker } from "./use-reading-state-tracker";
import type { OpenedPdfBook, ReadingState } from "../shared/contracts";
import type { ViewerState } from "./pdf/PdfViewer";

function makeBook(id: string, readingState: ReadingState): OpenedPdfBook {
  return {
    id,
    name: `书 ${id}`,
    path: `C:/${id}.pdf`,
    pageCount: 10,
    currentPage: readingState.page,
    readingState,
    bytes: new Uint8Array(),
  };
}

const BOOK_A = makeBook("a".repeat(64), {
  page: 3, scrollTop: 40, zoomMode: "custom", zoomScale: 130, leftSidebarOpen: false, rightSidebarOpen: true,
});
const BOOK_B = makeBook("b".repeat(64), {
  page: 7, scrollTop: 90, zoomMode: "page-width", zoomScale: 100, leftSidebarOpen: true, rightSidebarOpen: false,
});

function viewerState(overrides: Partial<ViewerState> = {}): ViewerState {
  return {
    page: 5, pages: 10, scale: 150, scrollTop: 99, zoomMode: "page-width",
    outline: [], renderRevision: 0,
    ...overrides,
  };
}

function makeWriter() {
  return { schedule: vi.fn(), flush: vi.fn(), dispose: vi.fn() };
}

type ProbeProps = {
  book: OpenedPdfBook | undefined;
  leftOpen: boolean;
  rightOpen: boolean;
};

let latest: ReturnType<typeof useReadingStateTracker>;
function Probe(props: ProbeProps) {
  const writer = (globalThis as { __trackerWriter?: ReturnType<typeof makeWriter> }).__trackerWriter;
  latest = useReadingStateTracker({ ...props, writer });
  return null;
}

describe("useReadingStateTracker", () => {
  let container: HTMLDivElement;
  let root: Root;
  let writer: ReturnType<typeof makeWriter>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    writer = makeWriter();
    (globalThis as { __trackerWriter?: ReturnType<typeof makeWriter> }).__trackerWriter = writer;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (globalThis as { __trackerWriter?: ReturnType<typeof makeWriter> }).__trackerWriter;
  });

  function renderProbe(props: ProbeProps) {
    act(() => root.render(<Probe {...props} />));
    return {
      rerender(next: ProbeProps) {
        act(() => root.render(<Probe {...next} />));
      },
    };
  }

  it("查看器状态连同当前侧栏开合组装成 ReadingState 提交", () => {
    renderProbe({ book: BOOK_A, leftOpen: false, rightOpen: true });
    writer.schedule.mockClear();
    act(() => latest.trackViewerState(viewerState()));
    expect(writer.schedule).toHaveBeenCalledTimes(1);
    expect(writer.schedule).toHaveBeenLastCalledWith({
      bookId: BOOK_A.id,
      state: {
        page: 5, scrollTop: 99, zoomMode: "page-width", zoomScale: 150,
        leftSidebarOpen: false, rightSidebarOpen: true,
      },
    });
  });

  it("侧栏切换做补丁式提交，不丢查看器字段", () => {
    const harness = renderProbe({ book: BOOK_A, leftOpen: false, rightOpen: true });
    act(() => latest.trackViewerState(viewerState()));
    harness.rerender({ book: BOOK_A, leftOpen: true, rightOpen: true });
    expect(writer.schedule).toHaveBeenLastCalledWith({
      bookId: BOOK_A.id,
      state: {
        page: 5, scrollTop: 99, zoomMode: "page-width", zoomScale: 150,
        leftSidebarOpen: true, rightSidebarOpen: true,
      },
    });
  });

  it("切书先 flush 旧书待写，并以新书的阅读状态为组装基线", () => {
    const harness = renderProbe({ book: BOOK_A, leftOpen: false, rightOpen: true });
    act(() => latest.trackViewerState(viewerState()));
    writer.flush.mockClear();
    harness.rerender({ book: BOOK_B, leftOpen: true, rightOpen: false });
    expect(writer.flush).toHaveBeenCalled();
    writer.schedule.mockClear();
    act(() => latest.trackViewerState(viewerState({ page: 8, scrollTop: 12, zoomMode: "custom", scale: 210 })));
    expect(writer.schedule).toHaveBeenLastCalledWith({
      bookId: BOOK_B.id,
      state: {
        page: 8, scrollTop: 12, zoomMode: "custom", zoomScale: 210,
        leftSidebarOpen: true, rightSidebarOpen: false,
      },
    });
  });

  it("卸载前 flush 待写状态", () => {
    renderProbe({ book: BOOK_A, leftOpen: false, rightOpen: true });
    act(() => latest.trackViewerState(viewerState()));
    writer.flush.mockClear();
    act(() => root.unmount());
    expect(writer.flush).toHaveBeenCalled();
  });

  it("没有打开的书时 trackViewerState 是 no-op", () => {
    renderProbe({ book: undefined, leftOpen: true, rightOpen: true });
    writer.schedule.mockClear();
    act(() => latest.trackViewerState(viewerState()));
    expect(writer.schedule).not.toHaveBeenCalled();
  });
});
