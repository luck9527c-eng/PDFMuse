import { useCallback, useEffect, useRef, useState } from "react";

import type { OpenedPdfBook, OcrPageResult, RecognizedPageText, StartupPreflight } from "../shared/contracts";
import { MINERU_INPUT_VERSION } from "../shared/mineru-config";
import type { PdfViewerHandle } from "./pdf/PdfViewer";

const PREFETCH_DELAY_MS = 250;
const OCR_WARNING_MARK = "OCR";

/** OCR 资源缺失 = 启动预检通过且警告含 OCR 项；开书调度门控与当前页识别共享同一判定。 */
function ocrResourcesMissing(preflight: StartupPreflight) {
  return preflight.ok && preflight.warnings.some((warning) => warning.includes(OCR_WARNING_MARK));
}

/**
 * Text Availability：拥有「让当前 PDF Book 的文本可选用」。
 * 开书任务调度门控、Recognized Text 缓存去重、邻页预取与 pdfjs 重渲染复查
 * 全部收在这里；查看器只接收 recognizedPage 文字层，不知道识别编排。
 */
export function useBookText(options: {
  book: OpenedPdfBook | undefined;
  page: number;
  renderRevision: number;
  viewer: { current: PdfViewerHandle | null };
}) {
  const { book, page, renderRevision, viewer } = options;
  const [recognizedPage, setRecognizedPage] = useState<RecognizedPageText>();
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrNotice, setOcrNotice] = useState("");
  const requestsRef = useRef(new Map<string, Promise<OcrPageResult>>());
  const [ocrUnavailable, setOcrUnavailable] = useState(false);
  // OCR 资源可用性是启动期静态事实：预检整个会话只取一次，两处消费共享同一 Promise。
  const preflightRef = useRef<Promise<StartupPreflight | undefined> | undefined>(undefined);
  const loadStartupPreflight = useCallback((): Promise<StartupPreflight | undefined> | undefined => {
    preflightRef.current ??= window.pdfMuse?.getStartupPreflight();
    return preflightRef.current;
  }, []);

  useEffect(() => {
    let disposed = false;
    void loadStartupPreflight()?.then((preflight) => {
      if (preflight && !disposed) setOcrUnavailable(ocrResourcesMissing(preflight));
    });
    return () => { disposed = true; };
  }, [loadStartupPreflight]);

  // 开书任务调度门控：全文索引与目录总是排；OCR 视资源可用，语义索引视嵌入连接。
  useEffect(() => {
    if (!book || !window.pdfMuse) return;
    const api = window.pdfMuse;
    void (async () => {
      await api.scheduleBackgroundJob({ bookId: book.id, kind: "index", priority: 10, total: book.pageCount });
      await api.scheduleBackgroundJob({ bookId: book.id, kind: "outline", priority: 5, total: book.pageCount });
      const preflight = await loadStartupPreflight();
      if (preflight?.ok && !ocrResourcesMissing(preflight)) {
        await api.scheduleBackgroundJob({ bookId: book.id, kind: "ocr", priority: 20, total: book.pageCount, maxAttempts: 3, inputVersion: MINERU_INPUT_VERSION, startPage: book.currentPage });
      }
      const embedding = await api.getEmbeddingConnection();
      if (embedding.baseUrl && embedding.model) {
        await api.scheduleBackgroundJob({ bookId: book.id, kind: "embedding", priority: 0, total: book.pageCount });
      }
    })().catch(() => undefined);
  }, [book, loadStartupPreflight]);

  const ensureRecognizedPage = useCallback((targetBook: OpenedPdfBook, targetPage: number) => {
    const key = `${targetBook.id}:${targetPage}`;
    const pending = requestsRef.current.get(key);
    if (pending) return pending;
    const request = (async (): Promise<OcrPageResult> => {
      if (!window.pdfMuse) return { ok: false, code: "UNAVAILABLE", message: "文字识别功能不可用。" };
      const cached = await window.pdfMuse.getRecognizedPage(targetBook.id, targetPage);
      if (cached?.inputVersion === MINERU_INPUT_VERSION) return { ok: true, page: cached };
      // MinerU 按页直读 PDF 原文件，渲染端不再需要先送页面图像。
      return window.pdfMuse.recognizePage({ bookId: targetBook.id, page: targetPage });
    })().finally(() => requestsRef.current.delete(key));
    requestsRef.current.set(key, request);
    return request;
  }, []);

  // 当前页静默确保：无原生文本才识别；完成后空闲预取相邻页。
  // renderRevision 来自 ViewerState（pdfjs 重渲染的单一事实源），页面重绘后复查恢复文字层。
  useEffect(() => {
    if (!book || !window.pdfMuse) {
      setRecognizedPage(undefined);
      return;
    }
    setRecognizedPage(undefined);
    if (ocrUnavailable) return;
    let disposed = false;
    let prefetchTimer = 0;
    const targetPage = page;
    void (async () => {
      if (await viewer.current?.hasNativeText(targetPage)) return;
      const result = await ensureRecognizedPage(book, targetPage);
      if (disposed) return;
      if (result.ok) setRecognizedPage(result.page);
      prefetchTimer = window.setTimeout(() => {
        void (async () => {
          for (const neighbor of [targetPage + 1, targetPage - 1]) {
            if (disposed || neighbor < 1 || neighbor > book.pageCount) continue;
            if (await viewer.current?.hasNativeText(neighbor)) continue;
            await ensureRecognizedPage(book, neighbor);
          }
        })();
      }, PREFETCH_DELAY_MS);
    })();
    return () => {
      disposed = true;
      window.clearTimeout(prefetchTimer);
    };
  }, [book, ensureRecognizedPage, ocrUnavailable, page, renderRevision, viewer]);

  const recognizeCurrentPage = useCallback(async () => {
    if (!book || !window.pdfMuse || ocrLoading) return;
    setOcrLoading(true);
    setOcrNotice("");
    try {
      const result = await ensureRecognizedPage(book, page);
      if (result.ok) setRecognizedPage(result.page);
      else setOcrNotice(result.message);
    } catch {
      setOcrNotice("当前页识别失败，请稍后重试。");
    } finally {
      setOcrLoading(false);
    }
  }, [book, ensureRecognizedPage, ocrLoading, page]);

  return { recognizedPage, ocrLoading, ocrNotice, recognizeCurrentPage, setOcrNotice };
}
