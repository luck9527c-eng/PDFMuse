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
  PDFFindController,
  PDFLinkService,
  PDFViewer,
} from "pdfjs-dist/web/pdf_viewer.mjs";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import type { OpenedPdfBook, ReadingZoomMode } from "../../shared/contracts";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type OutlineNode = {
  id: string;
  label: string;
  page?: number;
  children: OutlineNode[];
};

export type ViewerState = {
  page: number;
  pages: number;
  scale: number;
  scrollTop: number;
  zoomMode: ReadingZoomMode;
  outline: OutlineNode[];
  findCurrent: number;
  findTotal: number;
};

export interface PdfViewerHandle {
  goToPage(page: number): void;
  previousPage(): void;
  nextPage(): void;
  zoomIn(): void;
  zoomOut(): void;
  fitWidth(): void;
  fitPage(): void;
  find(query: string, findPrevious?: boolean): void;
  getThumbnail(page: number): Promise<string | undefined>;
}

type Props = {
  book: OpenedPdfBook;
  onStateChange(state: ViewerState): void;
  onError(message: string): void;
};

async function resolveOutline(
  document: pdfjs.PDFDocumentProxy,
  items: Awaited<ReturnType<pdfjs.PDFDocumentProxy["getOutline"]>>,
  lineage = "outline",
): Promise<OutlineNode[]> {
  if (!items) return [];

  return Promise.all(
    items.map(async (item, index) => {
      const id = `${lineage}-${index}`;
      let page: number | undefined;
      try {
        const destination = typeof item.dest === "string" ? await document.getDestination(item.dest) : item.dest;
        const pageReference = destination?.[0];
        if (typeof pageReference === "number") page = pageReference + 1;
        else if (pageReference) page = (await document.getPageIndex(pageReference)) + 1;
      } catch {
        page = undefined;
      }

      return {
        id,
        label: item.title || `未命名章节 ${index + 1}`,
        page,
        children: await resolveOutline(document, item.items, id),
      };
    }),
  );
}

export const PdfViewer = forwardRef<PdfViewerHandle, Props>(function PdfViewer(
  { book, onStateChange, onError },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerElementRef = useRef<HTMLDivElement>(null);
  const adapterRef = useRef<{
    eventBus: EventBus;
    viewer: PDFViewer;
    findController: PDFFindController;
    fitMode: Exclude<ReadingZoomMode, "custom"> | null;
    currentPage: number;
    document?: pdfjs.PDFDocumentProxy;
    thumbnailCache: Map<number, Promise<string | undefined>>;
    findQuery: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  useImperativeHandle(ref, () => ({
    goToPage(page) {
      const adapter = adapterRef.current;
      if (adapter) {
        const targetPage = Math.max(1, Math.min(adapter.viewer.pagesCount, page));
        adapter.currentPage = targetPage;
        adapter.viewer.currentPageNumber = targetPage;
      }
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
    fitPage() {
      if (adapterRef.current) {
        adapterRef.current.fitMode = "page-fit";
        adapterRef.current.viewer.currentScaleValue = "page-fit";
      }
    },
    find(query, findPrevious = false) {
      const adapter = adapterRef.current;
      if (!adapter) return;
      const normalizedQuery = query.trim();
      const repeatSearch = normalizedQuery === adapter.findQuery;
      adapter.findQuery = normalizedQuery;
      adapter.eventBus.dispatch("find", {
        source: adapter.findController,
        type: repeatSearch && normalizedQuery ? "again" : "",
        query: normalizedQuery,
        caseSensitive: false,
        entireWord: false,
        highlightAll: true,
        findPrevious,
        matchDiacritics: false,
      });
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
  }));

  useEffect(() => {
    const container = containerRef.current;
    const viewerElement = viewerElementRef.current;
    if (!container || !viewerElement) return;

    let disposed = false;
    const eventBus = new EventBus();
    const linkService = new PDFLinkService({ eventBus });
    const findController = new PDFFindController({ eventBus, linkService });
    const viewer = new PDFViewer({
      container,
      viewer: viewerElement,
      eventBus,
      linkService,
      findController,
      textLayerMode: 1,
    });
    linkService.setViewer(viewer);
    const restoredZoomMode = book.readingState.zoomMode;
    const adapter: NonNullable<typeof adapterRef.current> = {
      eventBus,
      viewer,
      findController,
      fitMode: restoredZoomMode === "custom" ? null : restoredZoomMode,
      currentPage: book.currentPage,
      thumbnailCache: new Map<number, Promise<string | undefined>>(),
      findQuery: "",
    };
    adapterRef.current = adapter;

    let outline: OutlineNode[] = [];
    const reportState = (page = adapter.currentPage) => {
      onStateChange({
        page,
        pages: viewer.pagesCount || 0,
        scale: Math.round((viewer.currentScale || 1) * 100),
        scrollTop: container.scrollTop,
        zoomMode: adapter.fitMode ?? "custom",
        outline,
        findCurrent,
        findTotal,
      });
    };
    let findCurrent = 0;
    let findTotal = 0;
    eventBus.on("pagechanging", (event: { pageNumber: number }) => {
      adapter.currentPage = event.pageNumber;
      reportState();
    });
    eventBus.on("scalechanging", () => reportState());
    const updateFindState = (event: { matchesCount?: { current?: number; total?: number } }) => {
      findCurrent = event.matchesCount?.current ?? 0;
      findTotal = event.matchesCount?.total ?? 0;
      reportState();
    };
    eventBus.on("updatefindmatchescount", updateFindState);
    eventBus.on("updatefindcontrolstate", updateFindState);
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
    const reportScroll = () => {
      cancelAnimationFrame(scrollFrame);
      scrollFrame = requestAnimationFrame(() => reportState());
    };
    container.addEventListener("scroll", reportScroll, { passive: true });

    let wheelFrame = 0;
    let wheelDelta = 0;
    let wheelAnchor = { x: 0, y: 0 };
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const rect = container.getBoundingClientRect();
      wheelDelta += event.deltaY;
      wheelAnchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      if (wheelFrame) return;
      wheelFrame = requestAnimationFrame(() => {
        wheelFrame = 0;
        const oldScale = viewer.currentScale || 1;
        const scaleFactor = Math.exp(-wheelDelta * 0.002);
        wheelDelta = 0;
        const nextScale = Math.min(5, Math.max(0.25, oldScale * scaleFactor));
        if (Math.abs(nextScale - oldScale) < 0.001) return;
        const documentX = container.scrollLeft + wheelAnchor.x;
        const documentY = container.scrollTop + wheelAnchor.y;
        adapter.fitMode = null;
        viewer.currentScale = nextScale;
        requestAnimationFrame(() => {
          container.scrollLeft = documentX * (nextScale / oldScale) - wheelAnchor.x;
          container.scrollTop = documentY * (nextScale / oldScale) - wheelAnchor.y;
        });
      });
    };
    container.addEventListener("wheel", handleWheel, { passive: false });

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
        outline = await resolveOutline(document, await document.getOutline());
        reportState();
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
      container.removeEventListener("wheel", handleWheel);
      cancelAnimationFrame(wheelFrame);
      adapterRef.current = null;
      viewer.cleanup();
      void loadingTask.destroy();
    };
  }, [book, onError, onStateChange]);

  return (
    <div className="pdf-container" ref={containerRef}>
      {loading && <div className="viewer-loading">正在准备 PDF 书籍...</div>}
      <div className="pdfViewer" ref={viewerElementRef} />
    </div>
  );
});
