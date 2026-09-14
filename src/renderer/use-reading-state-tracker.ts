import { useCallback, useEffect, useRef } from "react";

import type { OpenedPdfBook, ReadingState } from "../shared/contracts";
import { createReadingStateWriter } from "./reading-state-persistence";
import type { ViewerState } from "./pdf/PdfViewer";

export type ReadingStateWriterLike = ReturnType<typeof createReadingStateWriter<{
  bookId: string;
  state: ReadingState;
}>>;

const INITIAL_STATE: ReadingState = {
  page: 1,
  scrollTop: 0,
  zoomMode: "page-width",
  zoomScale: 100,
  leftSidebarOpen: true,
  rightSidebarOpen: true,
};

/**
 * 阅读状态 tracker：独占 ReadingState 的组装、节流写入与切换时机。
 * 写节流器本身不动（已是测试过的深模块）；App 只传入打开的书与侧栏开合，
 * 换到的唯一职责是把查看器状态上报过来。
 */
export function useReadingStateTracker(options: {
  book: OpenedPdfBook | undefined;
  leftOpen: boolean;
  rightOpen: boolean;
  writer?: ReadingStateWriterLike;
}) {
  const writerRef = useRef<ReadingStateWriterLike | undefined>(undefined);
  if (!writerRef.current) {
    writerRef.current = options.writer ?? createReadingStateWriter(({ bookId, state }) => {
      void window.pdfMuse?.updateLibraryBookState(bookId, state).catch(() => undefined);
    });
  }
  const stateRef = useRef<ReadingState>(INITIAL_STATE);
  const bookIdRef = useRef<string | undefined>(undefined);

  // 切书（含回到书库）：先落盘上一本的待写条目（条目自带 bookId，晚写不串书），再以新书快照重置基线。
  useEffect(() => {
    writerRef.current?.flush();
    stateRef.current = options.book ? { ...options.book.readingState } : INITIAL_STATE;
    bookIdRef.current = options.book?.id;
  }, [options.book]);

  // 侧栏开合只补丁对应字段，查看器字段保持上次上报值。
  useEffect(() => {
    if (!bookIdRef.current) return;
    stateRef.current = {
      ...stateRef.current,
      leftSidebarOpen: options.leftOpen,
      rightSidebarOpen: options.rightOpen,
    };
    writerRef.current?.schedule({ bookId: bookIdRef.current, state: stateRef.current });
  }, [options.book, options.leftOpen, options.rightOpen]);

  useEffect(() => () => writerRef.current?.flush(), []);

  const trackViewerState = useCallback((state: ViewerState) => {
    if (!bookIdRef.current) return;
    stateRef.current = {
      page: state.page,
      scrollTop: state.scrollTop,
      zoomMode: state.zoomMode,
      zoomScale: state.scale,
      leftSidebarOpen: stateRef.current.leftSidebarOpen,
      rightSidebarOpen: stateRef.current.rightSidebarOpen,
    };
    writerRef.current?.schedule({ bookId: bookIdRef.current, state: stateRef.current });
  }, []);

  return { trackViewerState };
}
