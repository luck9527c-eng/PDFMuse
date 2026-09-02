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
      adapterRef.current?.viewer.previousPage();
    },
    nextPage() {
      adapterRef.current?.viewer.nextPage();
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
      adapter.eventBus.dispatch("find", {
        source: adapter.findController,
        type: "",
        query,
        caseSensitive: false,
        entireWord: false,
        highlightAll: true,
        findPrevious,
        matchDiacritics: false,
      });
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
    const adapter = {
      eventBus,
      viewer,
      findController,
      fitMode: restoredZoomMode === "custom" ? null : restoredZoomMode,
      currentPage: book.currentPage,
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
      });
    };
    eventBus.on("pagechanging", (event: { pageNumber: number }) => {
      adapter.currentPage = event.pageNumber;
      reportState();
    });
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
    const reportScroll = () => {
      cancelAnimationFrame(scrollFrame);
      scrollFrame = requestAnimationFrame(() => reportState());
    };
    container.addEventListener("scroll", reportScroll, { passive: true });

    let resizeFrame = 0;
    const resizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        if (viewer.pagesCount && adapter.fitMode) viewer.currentScaleValue = adapter.fitMode;
      });
    });
    resizeObserver.observe(container);

    const loadingTask = pdfjs.getDocument({ data: book.bytes.slice() });
    loadingTask.promise
      .then(async (document) => {
        if (disposed) return;
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
