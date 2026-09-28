import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import * as pdfjs from "pdfjs-dist";
import {
  EventBus,
  PDFLinkService,
  PDFViewer,
} from "pdfjs-dist/web/pdf_viewer.mjs";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import type { BookOutlineNode, NormalizedPageRect, OpenedPdfBook, ReadingZoomMode, RecognizedPageText, SelectedPassage } from "../../shared/contracts";
import { evaluatePageSelection, normalizePageRects, ocrAnchorRect, toRectangle, type Rectangle } from "./selection-geometry";
import { collectOcrLayerBlocks, isWholeBlockClickSelection, mountRecognizedTextLayer } from "./ocr-text-layer";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type OutlineNode = BookOutlineNode;

export type ViewerState = {
  page: number;
  pages: number;
  scale: number;
  scrollTop: number;
  zoomMode: ReadingZoomMode;
  /** pdfjs 页面重渲染修订：单一事实源在查看器内，页面重绘后递增，消费方据此复查文字层。 */
  renderRevision: number;
};

export interface PdfViewerHandle {
  goToPage(page: number, anchorTop?: number): void;
  previousPage(): void;
  nextPage(): void;
  zoomIn(): void;
  zoomOut(): void;
  fitWidth(): void;
  hasNativeText(page: number): Promise<boolean>;
  getThumbnail(page: number): Promise<string | undefined>;
  getPageImage(page: number, scale?: number): Promise<{ data: string; width: number; height: number } | undefined>;
}

export type ViewerSelection =
  | {
      kind: "selected";
      passage: SelectedPassage;
      popover: { x: number; y: number };
    }
  | {
      kind: "rejected";
      message: string;
    };

type Props = {
  book: OpenedPdfBook;
  panMode: boolean;
  onStateChange(state: ViewerState): void;
  onSelectionChange(selection?: ViewerSelection): void;
  onError(message: string): void;
  recognizedPage?: RecognizedPageText;
};

// 目录由主进程唯一解析（质量闸门 + 读路径快检），查看器不再自解析 PDF 大纲。

export const PdfViewer = forwardRef<PdfViewerHandle, Props>(function PdfViewer(
  { book, panMode, onStateChange, onSelectionChange, onError, recognizedPage },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerElementRef = useRef<HTMLDivElement>(null);
  const adapterRef = useRef<{
    eventBus: EventBus;
    linkService: PDFLinkService;
    viewer: PDFViewer;
    fitMode: Exclude<ReadingZoomMode, "custom"> | null;
    currentPage: number;
    document?: pdfjs.PDFDocumentProxy;
    thumbnailCache: Map<number, Promise<string | undefined>>;
  } | null>(null);
  const panModeRef = useRef(panMode);
  const [loading, setLoading] = useState(true);
  // ref 供 reportState 闭包读取最新值，state 驱动内部文字层重挂载。
  const renderRevisionRef = useRef(0);
  const [renderRevision, setRenderRevision] = useState(0);

  useEffect(() => {
    panModeRef.current = panMode;
  }, [panMode]);

  useImperativeHandle(ref, () => ({
    goToPage(page, anchorTop) {
      const adapter = adapterRef.current;
      if (!adapter) return;
      const targetPage = Math.max(1, Math.min(adapter.viewer.pagesCount, page));
      adapter.currentPage = targetPage;
      // 页内锚点（内嵌档书签 dest 的用户空间 Y）：走原生 XYZ 滚动，缩放不动；x=0 即左缘。
      if (anchorTop !== undefined && Number.isFinite(anchorTop)) {
        adapter.linkService.goToXY(targetPage, 0, anchorTop);
        return;
      }
      adapter.viewer.currentPageNumber = targetPage;
    },
    previousPage() {
      const adapter = adapterRef.current;
      if (!adapter) return;
      const page = Math.max(1, adapter.currentPage - 1);
      adapter.currentPage = page;
      adapter.viewer.currentPageNumber = page;
    },
    nextPage() {
      const adapter = adapterRef.current;
      if (!adapter) return;
      const page = Math.min(adapter.viewer.pagesCount, adapter.currentPage + 1);
      adapter.currentPage = page;
      adapter.viewer.currentPageNumber = page;
    },
    zoomIn() {
      if (adapterRef.current) {
        adapterRef.current.fitMode = null;
        adapterRef.current.viewer.increaseScale();
      }
    },
    zoomOut() {
      if (adapterRef.current) {
        adapterRef.current.fitMode = null;
        adapterRef.current.viewer.decreaseScale();
      }
    },
    fitWidth() {
      if (adapterRef.current) {
        adapterRef.current.fitMode = "page-width";
        adapterRef.current.viewer.currentScaleValue = "page-width";
      }
    },
    hasNativeText(pageNumber) {
      const adapter = adapterRef.current;
      if (!adapter?.document || pageNumber < 1 || pageNumber > adapter.document.numPages) return Promise.resolve(false);
      return adapter.document.getPage(pageNumber)
        .then((page) => page.getTextContent())
        .then((content) => content.items.some((item) => "str" in item && item.str.trim().length > 0))
        .catch(() => false);
    },
    getThumbnail(pageNumber) {
      const adapter = adapterRef.current;
      if (!adapter?.document || pageNumber < 1 || pageNumber > adapter.document.numPages) {
        return Promise.resolve(undefined);
      }
      const cached = adapter.thumbnailCache.get(pageNumber);
      if (cached) return cached;
      const rendering = adapter.document.getPage(pageNumber).then(async (page) => {
        const baseViewport = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: 132 / baseViewport.width });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) return undefined;
        await page.render({ canvas, canvasContext: context, viewport }).promise;
        return canvas.toDataURL("image/jpeg", 0.82);
      }).catch(() => undefined);
      adapter.thumbnailCache.set(pageNumber, rendering);
      return rendering;
    },
    getPageImage(pageNumber, scale = 1.5) {
      const adapter = adapterRef.current;
      if (!adapter?.document || pageNumber < 1 || pageNumber > adapter.document.numPages) return Promise.resolve(undefined);
      return adapter.document.getPage(pageNumber).then(async (page) => {
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) return undefined;
        await page.render({ canvas, canvasContext: context, viewport }).promise;
        return { data: canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, ""), width: canvas.width, height: canvas.height };
      }).catch(() => undefined);
    },
  }));

  useEffect(() => {
    const container = containerRef.current;
    const viewerElement = viewerElementRef.current;
    if (!container || !viewerElement) return;

    let disposed = false;
    const eventBus = new EventBus();
    const linkService = new PDFLinkService({ eventBus });
    const viewer = new PDFViewer({
      container,
      viewer: viewerElement,
      eventBus,
      linkService,
      textLayerMode: 1,
    });
    linkService.setViewer(viewer);
    const restoredZoomMode = book.readingState.zoomMode;
    const adapter: NonNullable<typeof adapterRef.current> = {
      eventBus,
      linkService,
      viewer,
      fitMode: restoredZoomMode === "custom" ? null : restoredZoomMode,
      currentPage: book.currentPage,
      thumbnailCache: new Map<number, Promise<string | undefined>>(),
    };
    adapterRef.current = adapter;

    const reportState = (page = adapter.currentPage) => {
      onStateChange({
        page,
        pages: viewer.pagesCount || 0,
        scale: Math.round((viewer.currentScale || 1) * 100),
        scrollTop: container.scrollTop,
        zoomMode: adapter.fitMode ?? "custom",
        renderRevision: renderRevisionRef.current,
      });
    };
    eventBus.on("pagechanging", (event: { pageNumber: number }) => {
      adapter.currentPage = event.pageNumber;
      reportState();
    });
    const reportPageRendered = (event: { pageNumber: number }) => {
      renderRevisionRef.current += 1;
      setRenderRevision((revision) => revision + 1);
      reportState();
    };
    eventBus.on("pagerendered", reportPageRendered);
    eventBus.on("scalechanging", () => reportState());
    eventBus.on("pagesinit", () => {
      if (adapter.fitMode) viewer.currentScaleValue = adapter.fitMode;
      else viewer.currentScale = book.readingState.zoomScale / 100;
      adapter.currentPage = Math.max(1, Math.min(viewer.pagesCount, book.currentPage));
      viewer.currentPageNumber = adapter.currentPage;
      setLoading(false);
      requestAnimationFrame(() => {
        container.scrollTop = book.readingState.scrollTop;
        reportState();
      });
    });

    let scrollFrame = 0;
    let selectionVisible = false;
    // 扫描页选区高亮：单块实心 bbox 框（MinerU 可视化样式）；T56 量化多块描边——
    // MinerU 块 bbox 彼此重叠，实心叠加会糊成整页色块，描边保持每块边界可见。
    const clearOcrBlockHighlight = () => {
      viewerElement.querySelectorAll("[data-pdfmuse-block-highlight]").forEach((node) => node.remove());
    };
    const showOcrBlockHighlight = (pageEl: HTMLElement, rects: Rectangle[]) => {
      clearOcrBlockHighlight();
      const pageRect = pageEl.getBoundingClientRect();
      if (pageRect.width <= 0 || pageRect.height <= 0) return;
      const clampPct = (value: number) => Math.max(0, Math.min(100, value));
      for (const rect of rects) {
        const div = document.createElement("div");
        div.dataset.pdfmuseBlockHighlight = "true";
        div.className = rects.length >= 2 ? "ocr-block-highlight ocr-block-outline" : "ocr-block-highlight";
        div.style.left = `${clampPct(((rect.left - pageRect.left) / pageRect.width) * 100)}%`;
        div.style.top = `${clampPct(((rect.top - pageRect.top) / pageRect.height) * 100)}%`;
        div.style.width = `${clampPct((rect.width / pageRect.width) * 100)}%`;
        div.style.height = `${clampPct((rect.height / pageRect.height) * 100)}%`;
        pageEl.appendChild(div);
      }
    };
    const clearSelectionPopover = () => {
      clearOcrBlockHighlight();
      if (!selectionVisible) return;
      selectionVisible = false;
      onSelectionChange();
    };
    const reportScroll = () => {
      cancelAnimationFrame(scrollFrame);
      scrollFrame = requestAnimationFrame(() => {
        reportState();
        // Reader 实测反馈（问题二）：滚动不清除选中——原生选区滚动后仍存活，
        // 重算一次让块高亮与 popover 跟随新视口位置；选区已消失时 reportSelection 自行清场。
        if (selectionVisible) scheduleSelectionReport();
      });
    };
    container.addEventListener("scroll", reportScroll, { passive: true });

    let selectionFrame = 0;
    const pageForNode = (node: Node | null) => {
      const element = node instanceof Element ? node : node?.parentElement;
      const page = element?.closest<HTMLElement>(".page");
      return page && viewerElement.contains(page) ? page : undefined;
    };
    const reportSelection = () => {
      selectionFrame = 0;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        clearSelectionPopover();
        return;
      }
      const range = selection.getRangeAt(0);
      const startPage = pageForNode(range.startContainer);
      const endPage = pageForNode(range.endContainer);
      if (!startPage || !endPage) {
        clearSelectionPopover();
        return;
      }
      if (startPage !== endPage) {
        selectionVisible = false;
        onSelectionChange({ kind: "rejected", message: "暂不支持跨页选择，请在同一页内重新选择。" });
        selection.removeAllRanges();
        return;
      }
      const page = Number(startPage.dataset.pageNumber);
      const pageRect = startPage.getBoundingClientRect();
      // T56 选中链路三分支收敛为一次纯函数求值：量化（块全文拼接+描边+并集锚）、
      // 纯噪声抑制（null）、单块/原生路径（起点块实心 + 字符级文本，块内精细选择不动）。
      const evaluation = evaluatePageSelection({
        selectionRects: Array.from(range.getClientRects()).map(toRectangle),
        ocrBlocks: collectOcrLayerBlocks(startPage),
        startBlockRect: ocrAnchorRect(startPage, range),
        nativeText: selection.toString().trim(),
        nativeSelectionRect: toRectangle(range.getBoundingClientRect()),
        // R1-Q6 守卫：点击合成的整块选区不参与量化——被点块 bbox 与邻块重叠时防止点击升级成多块。
        wholeBlockClick: isWholeBlockClickSelection(range, startPage),
      });
      if (!evaluation) {
        clearSelectionPopover();
        return;
      }
      if (evaluation.highlightRects.length > 0) showOcrBlockHighlight(startPage, evaluation.highlightRects);
      else clearOcrBlockHighlight();
      const rects = normalizePageRects(pageRect, [...evaluation.passageRects]);
      if (!evaluation.text || !Number.isSafeInteger(page) || page < 1 || rects.length === 0
        || evaluation.popoverRect.width <= 0 || evaluation.popoverRect.height <= 0) {
        clearSelectionPopover();
        return;
      }
      selectionVisible = true;
      onSelectionChange({
        kind: "selected",
        passage: { bookId: book.id, page, text: evaluation.text, rects },
        popover: {
          x: evaluation.popoverRect.left + evaluation.popoverRect.width / 2,
          y: evaluation.popoverRect.top,
        },
      });
    };
    const scheduleSelectionReport = () => {
      cancelAnimationFrame(selectionFrame);
      selectionFrame = requestAnimationFrame(reportSelection);
    };
    document.addEventListener("selectionchange", scheduleSelectionReport);

    let wheelFrame = 0;
    let wheelDelta = 0;
    let wheelAnchor = { clientX: 0, clientY: 0 };
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      wheelDelta += event.deltaY;
      wheelAnchor = { clientX: event.clientX, clientY: event.clientY };
      if (wheelFrame) return;
      wheelFrame = requestAnimationFrame(() => {
        wheelFrame = 0;
        const oldScale = viewer.currentScale || 1;
        const scaleFactor = Math.exp(-wheelDelta * 0.002);
        wheelDelta = 0;
        const nextScale = Math.min(5, Math.max(0.25, oldScale * scaleFactor));
        if (Math.abs(nextScale - oldScale) < 0.001) return;
        const pages = Array.from(viewerElement.querySelectorAll<HTMLElement>(".page"));
        const anchorPage = pages.find((page) => {
          const rect = page.getBoundingClientRect();
          return wheelAnchor.clientX >= rect.left && wheelAnchor.clientX <= rect.right
            && wheelAnchor.clientY >= rect.top && wheelAnchor.clientY <= rect.bottom;
        });
        const anchorRect = anchorPage?.getBoundingClientRect();
        const pageAnchor = anchorPage && anchorRect ? {
          page: anchorPage,
          x: (wheelAnchor.clientX - anchorRect.left) / anchorRect.width,
          y: (wheelAnchor.clientY - anchorRect.top) / anchorRect.height,
        } : undefined;
        const containerRect = container.getBoundingClientRect();
        const fallbackAnchor = {
          x: wheelAnchor.clientX - containerRect.left,
          y: wheelAnchor.clientY - containerRect.top,
          scrollLeft: container.scrollLeft,
          scrollTop: container.scrollTop,
        };
        adapter.fitMode = null;
        viewer.currentScale = nextScale;
        requestAnimationFrame(() => {
          if (pageAnchor) {
            const scaledRect = pageAnchor.page.getBoundingClientRect();
            container.scrollLeft += scaledRect.left + scaledRect.width * pageAnchor.x - wheelAnchor.clientX;
            container.scrollTop += scaledRect.top + scaledRect.height * pageAnchor.y - wheelAnchor.clientY;
          } else {
            const ratio = nextScale / oldScale;
            container.scrollLeft = (fallbackAnchor.scrollLeft + fallbackAnchor.x) * ratio - fallbackAnchor.x;
            container.scrollTop = (fallbackAnchor.scrollTop + fallbackAnchor.y) * ratio - fallbackAnchor.y;
          }
        });
      });
    };
    container.addEventListener("wheel", handleWheel, { passive: false });

    let pan: { pointerId: number; x: number; y: number; scrollLeft: number; scrollTop: number } | undefined;
    const stopPanning = (event?: PointerEvent) => {
      if (!pan || (event && event.pointerId !== pan.pointerId)) return;
      try { container.releasePointerCapture(pan.pointerId); } catch { /* Synthetic test events have no capture. */ }
      pan = undefined;
      container.classList.remove("is-panning");
    };
    const startPanning = (event: PointerEvent) => {
      const enabled = (panModeRef.current && event.button === 0) || event.button === 1;
      if (!enabled) return;
      event.preventDefault();
      pan = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        scrollLeft: container.scrollLeft,
        scrollTop: container.scrollTop,
      };
      try { container.setPointerCapture(event.pointerId); } catch { /* Synthetic test events have no capture. */ }
      container.classList.add("is-panning");
    };
    const movePanning = (event: PointerEvent) => {
      if (!pan || event.pointerId !== pan.pointerId) return;
      event.preventDefault();
      container.scrollLeft = pan.scrollLeft - (event.clientX - pan.x);
      container.scrollTop = pan.scrollTop - (event.clientY - pan.y);
    };
    container.addEventListener("pointerdown", startPanning);
    container.addEventListener("pointermove", movePanning);
    container.addEventListener("pointerup", stopPanning);
    container.addEventListener("pointercancel", stopPanning);

    let resizeFrame = 0;
    const resizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        if (viewer.pagesCount && adapter.fitMode) viewer.currentScaleValue = adapter.fitMode;
      });
    });
    resizeObserver.observe(container);

    const loadingTask = pdfjs.getDocument({
      data: book.bytes.slice(),
      ...(book.password ? { password: book.password } : {}),
    });
    loadingTask.promise
      .then(async (document) => {
        if (disposed) return;
        adapter.document = document;
        viewer.setDocument(document);
        linkService.setDocument(document);
      })
      .catch((error: unknown) => {
        if (!disposed) onError(error instanceof Error ? error.message : String(error));
      });

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      cancelAnimationFrame(resizeFrame);
      container.removeEventListener("scroll", reportScroll);
      cancelAnimationFrame(scrollFrame);
      document.removeEventListener("selectionchange", scheduleSelectionReport);
      cancelAnimationFrame(selectionFrame);
      clearOcrBlockHighlight();
      if (selectionVisible) onSelectionChange();
      container.removeEventListener("wheel", handleWheel);
      cancelAnimationFrame(wheelFrame);
      stopPanning();
      container.removeEventListener("pointerdown", startPanning);
      container.removeEventListener("pointermove", movePanning);
      container.removeEventListener("pointerup", stopPanning);
      container.removeEventListener("pointercancel", stopPanning);
      eventBus.off("pagerendered", reportPageRendered);
      adapterRef.current = null;
      viewer.cleanup();
      void loadingTask.destroy();
    };
  }, [book, onError, onSelectionChange, onStateChange]);

  useEffect(() => {
    const viewerElement = viewerElementRef.current;
    if (!viewerElement) return;
    mountRecognizedTextLayer(viewerElement, recognizedPage);
  }, [recognizedPage, renderRevision]);

  return (
    <div className={`pdf-container ${panMode ? "pan-mode" : ""}`} ref={containerRef}>
      {loading && <div className="viewer-loading">正在准备 PDF 书籍...</div>}
      <div className="pdfViewer" ref={viewerElementRef} />
    </div>
  );
});
