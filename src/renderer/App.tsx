import * as Tooltip from "@radix-ui/react-tooltip";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Bot,
  Bug,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Copy,
  FilePlus2,
  Focus,
  Hand,
  ImagePlus,
  Library,
  Download,
  Loader2,
  MessageSquareText,
  Minus,
  Pause,
  PanelLeftClose,
  PanelRightClose,
  Play,
  Plus,
  Search,
  ScanText,
  Send,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import type {
  AgentImageAttachment,
  AppearanceSettings,
  BackgroundJob,
  ConversationMessage,
  LibraryBook,
  OpenedPdfBook,
  OpenPdfBookResult,
  SelectedPassage,
  StartupPreflight,
} from "../shared/contracts";
import { APPEARANCE_DEFAULTS, MAX_AGENT_IMAGE_ATTACHMENTS, MAX_AGENT_IMAGE_BYTES } from "../shared/contracts";
import { IconButton } from "./components/IconButton";
import { ConversationMessageItem } from "./components/ConversationMessageItem";
import { DiagnosticsDrawer } from "./components/DiagnosticsDrawer";
import { MarkdownView } from "./components/MarkdownView";
import { OutlinePanel } from "./components/OutlinePanel";
import { SettingsDialog } from "./components/SettingsDialog";
import { LibraryView } from "./components/LibraryView";
import { PasswordDialog, type PasswordRequest } from "./components/PasswordDialog";
import { PdfThumbnail } from "./components/PdfThumbnail";
import { PdfViewer, type OutlineNode, type PdfViewerHandle, type ViewerSelection, type ViewerState } from "./pdf/PdfViewer";
import { applyAppearanceSettings } from "./appearance";
import { findMissingApiMethods } from "./api-compat";
import { getConversationReferencePages } from "./conversation-reference";
import { useBookConversation } from "./use-book-conversation";
import { useBookText } from "./use-book-text";
import { useReadingStateTracker } from "./use-reading-state-tracker";

type PassagePopover = Extract<ViewerSelection, { kind: "selected" }>;

const BACKGROUND_JOB_KIND_LABELS: Record<BackgroundJob["kind"], string> = {
  ocr: "文字识别",
  embedding: "语义索引",
  index: "全文索引",
  outline: "目录补全",
};

const BACKGROUND_JOB_STATUS_LABELS: Record<BackgroundJob["status"], string> = {
  queued: "等待中",
  running: "处理中",
  paused: "已暂停",
  completed: "已完成",
  cancelled: "已取消",
  failed: "失败",
};

const browserPreflight: StartupPreflight = {
  ok: true,
  dataHome: "浏览器预览模式",
  warnings: ["桌面文件访问仅在 Electron 中启用。"],
};

export function App() {
  const viewerRef = useRef<PdfViewerHandle>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const startupRestoreStartedRef = useRef(false);
  const [preflight, setPreflight] = useState<StartupPreflight>();

  // preload 版本错配检测：渲染端热更新而 Electron 未重启时，缺失的方法在这里可见，
  // 用横幅提示重启，而不是让首次调用抛 TypeError 导致整树卸载（白屏）。
  const missingApiMethods = useMemo(() => findMissingApiMethods(window.pdfMuse), []);
  const apiMismatchBanner = missingApiMethods.length > 0 ? (
    <div className="api-mismatch-banner" role="alert">
      <span>界面已更新，部分功能暂不可用（缺失 {missingApiMethods.length} 个接口）。请重启 PDFMuse 保持版本一致。</span>
    </div>
  ) : null;

  const [startupReady, setStartupReady] = useState(false);
  const [book, setBook] = useState<OpenedPdfBook>();
  const [libraryBooks, setLibraryBooks] = useState<LibraryBook[]>([]);
  const [libraryError, setLibraryError] = useState("");
  const [unavailableBookId, setUnavailableBookId] = useState<string>();
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [viewerState, setViewerState] = useState<ViewerState>({
    page: 1,
    pages: 0,
    scale: 100,
    scrollTop: 0,
    zoomMode: "page-width",
    outline: [],
    findCurrent: 0,
    findTotal: 0,
    renderRevision: 0,
  });
  const [viewerError, setViewerError] = useState("");
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [leftWidth, setLeftWidth] = useState(244);
  const [rightWidth, setRightWidth] = useState(360);
  const [sidebarView, setSidebarView] = useState<"outline" | "thumbnails">("outline");
  const [passwordRequest, setPasswordRequest] = useState<PasswordRequest>();
  const [findOpen, setFindOpen] = useState(false);
  const [panMode, setPanMode] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [passage, setPassage] = useState<PassagePopover>();
  const [selectionFeedback, setSelectionFeedback] = useState<{ message: string; tone: "success" | "error" }>();
  const [draft, setDraft] = useState("");
  const [attachedPassage, setAttachedPassage] = useState<SelectedPassage>();
  const [attachments, setAttachments] = useState<AgentImageAttachment[]>([]);
  const [backgroundJobs, setBackgroundJobs] = useState<BackgroundJob[]>([]);
  const [generatedOutline, setGeneratedOutline] = useState<OutlineNode[]>();
  const [clearConversationOpen, setClearConversationOpen] = useState(false);
  const [clearingConversation, setClearingConversation] = useState(false);
  const conversationRef = useRef<HTMLDivElement>(null);
  const attachmentsRef = useRef(attachments);
  const activeBookIdRef = useRef<string | undefined>(undefined);
  const currentPageRef = useRef(viewerState.page);
  attachmentsRef.current = attachments;
  currentPageRef.current = viewerState.page;

  // AI 助手域：事件路由、乐观上屏与会话状态收敛在 useBookConversation，这里只消费。
  const {
    state: conversationState,
    busy,
    ask,
    cancel,
    dismissNotice,
    notify,
    retry,
    clear,
    exportMarkdown,
    refreshDiagnostics,
  } = useBookConversation(book, () => currentPageRef.current);

  // Text Availability 域：开书任务调度门控、Recognized Text 缓存去重、邻页预取与重渲染复查收敛在 useBookText。
  const {
    recognizedPage,
    ocrLoading,
    ocrNotice,
    recognizeCurrentPage,
    setOcrNotice,
  } = useBookText({ book, page: viewerState.page, renderRevision: viewerState.renderRevision, viewer: viewerRef });

  // 阅读状态 tracker：组装、节流写入与切书/卸载 flush 全部由它独占。
  const { trackViewerState } = useReadingStateTracker({ book, leftOpen, rightOpen });

  useEffect(() => {
    void (window.pdfMuse?.getStartupPreflight() ?? Promise.resolve(browserPreflight)).then(setPreflight);
  }, []);

  const [appearance, setAppearance] = useState<AppearanceSettings>(APPEARANCE_DEFAULTS);

  useEffect(() => {
    void (window.pdfMuse?.getAppearanceSettings() ?? Promise.resolve(APPEARANCE_DEFAULTS))
      .then((settings) => {
        setAppearance(settings);
        applyAppearanceSettings(settings);
      })
      .catch(() => applyAppearanceSettings(APPEARANCE_DEFAULTS));
  }, []);

  const previewAppearance = useCallback((settings: AppearanceSettings) => {
    applyAppearanceSettings(settings);
  }, []);

  const handleAppearanceSaved = useCallback((settings: AppearanceSettings) => {
    setAppearance(settings);
    applyAppearanceSettings(settings);
  }, []);

  const refreshLibrary = useCallback(async () => {
    if (!window.pdfMuse) {
      setLibraryLoading(false);
      return;
    }
    try {
      setLibraryBooks(await window.pdfMuse.listLibraryBooks());
    } catch {
      setLibraryError("无法读取书库，请重新启动 PDFMuse 后重试。");
    } finally {
      setLibraryLoading(false);
    }
  }, []);

  const resetReaderSideState = useCallback(() => {
    setBackgroundJobs([]);
    setGeneratedOutline(undefined);
  }, []);

  const refreshBackgroundJobs = useCallback(async (bookId: string) => {
    if (!window.pdfMuse) return;
    try {
      const [jobs, outline] = await Promise.all([
        window.pdfMuse.listBackgroundJobs(bookId),
        window.pdfMuse.getBookOutline(bookId),
      ]);
      if (activeBookIdRef.current !== bookId) return;
      setBackgroundJobs(jobs);
      setGeneratedOutline(outline);
    } catch {
      setBackgroundJobs([]);
    }
  }, []);

  useEffect(() => {
    const demoRequested = import.meta.env.DEV && new URLSearchParams(window.location.search).has("demo");
    if (window.pdfMuse || !demoRequested) return;

    void fetch("/data/qa-sample.pdf")
      .then(async (response) => {
        if (!response.ok) throw new Error(`QA PDF returned ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        setBook({
          id: "demo",
          name: "PDFMuse 界面测试文档",
          path: "data/qa-sample.pdf",
          pageCount: 1,
          currentPage: 1,
          readingState: {
            page: 1,
            scrollTop: 0,
            zoomMode: "page-width",
            zoomScale: 100,
            leftSidebarOpen: true,
            rightSidebarOpen: true,
          },
          bytes,
        });
      })
      .catch((error: unknown) => setViewerError(error instanceof Error ? error.message : String(error)));
  }, []);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f" && book) {
        event.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [book]);

  const activateBook = useCallback((openedBook: OpenedPdfBook) => {
    activeBookIdRef.current = openedBook.id;
    setViewerState({
      page: openedBook.readingState.page,
      pages: openedBook.pageCount,
      scale: openedBook.readingState.zoomScale,
      scrollTop: openedBook.readingState.scrollTop,
      zoomMode: openedBook.readingState.zoomMode,
      outline: [],
      findCurrent: 0,
      findTotal: 0,
      renderRevision: 0,
    });
    setLeftOpen(openedBook.readingState.leftSidebarOpen);
    setRightOpen(openedBook.readingState.rightSidebarOpen);
    setBook(openedBook);
    setViewerError("");
    setLibraryError("");
    setUnavailableBookId(undefined);
    resetReaderSideState();
    setPanMode(false);
    setPassage(undefined);
    setAttachedPassage(undefined);
    setAttachments([]);
    setSelectionFeedback(undefined);
  }, [resetReaderSideState]);

  // 后台状态走推送（ADR-0008）：开书拉一次初值，此后由任务/目录变更事件驱动，不再轮询。
  useEffect(() => {
    if (!book || !window.pdfMuse) return;
    void refreshBackgroundJobs(book.id);
  }, [book, refreshBackgroundJobs]);

  useEffect(() => {
    const unsubscribe = window.pdfMuse?.onBackgroundEvent((event) => {
      const bookId = activeBookIdRef.current;
      if (!bookId || event.bookId !== bookId) return;
      if (event.kind === "jobs") setBackgroundJobs(event.jobs);
      else setGeneratedOutline(event.nodes);
    });
    return () => unsubscribe?.();
  }, []);

  const visibleBackgroundJob = useMemo(() => {
    const rank: Record<BackgroundJob["status"], number> = {
      running: 0,
      queued: 1,
      paused: 2,
      failed: 3,
      completed: 4,
      cancelled: 5,
    };
    const latestByKind = backgroundJobs.filter((job, index, jobs) => (
      jobs.findIndex((candidate) => candidate.kind === job.kind) === index
    ));
    return latestByKind.sort((left, right) => rank[left.status] - rank[right.status])[0];
  }, [backgroundJobs]);

  const mutateBackgroundJob = useCallback(async (action: "pause" | "resume" | "cancel") => {
    if (!book || !visibleBackgroundJob || !window.pdfMuse) return;
    const method = action === "pause"
      ? window.pdfMuse.pauseBackgroundJob
      : action === "resume"
        ? window.pdfMuse.resumeBackgroundJob
        : window.pdfMuse.cancelBackgroundJob;
    await method(visibleBackgroundJob.id);
  }, [book, visibleBackgroundJob]);

  const effectiveOutline = viewerState.outline.length > 0 ? viewerState.outline : generatedOutline ?? [];
  const outlineJob = backgroundJobs.find((job) => job.kind === "outline");
  const outlineEmptyMessage = outlineJob?.status === "running" || outlineJob?.status === "queued"
    ? "正在分析章节结构..."
    : outlineJob?.status === "paused"
      ? "目录补全已暂停。"
      : outlineJob?.status === "failed"
        ? "暂时无法补全目录，请稍后重试。"
        : "未检测到可用章节，可使用缩略图浏览。";

  const handleOpenResult = useCallback((result: OpenPdfBookResult, attemptedBookId?: string) => {
    if (result.ok) {
      setPasswordRequest(undefined);
      activateBook(result.book);
    }
    else {
      if (result.code === "PASSWORD_REQUIRED") {
        setPasswordRequest(result);
        return;
      }
      setLibraryError(result.message);
      const canRelocate = result.code === "FILE_UNAVAILABLE" || result.code === "CONTENT_CHANGED";
      setUnavailableBookId(canRelocate ? result.bookId ?? attemptedBookId : undefined);
    }
  }, [activateBook]);

  const unlockPdf = useCallback(async (password: string, remember: boolean) => {
    if (!window.pdfMuse || !passwordRequest) return;
    try {
      handleOpenResult(await window.pdfMuse.unlockPdfBook(passwordRequest.challengeId, password, remember));
    } catch {
      setLibraryError("无法验证 PDF 密码，请重试。");
      setPasswordRequest(undefined);
    }
  }, [handleOpenResult, passwordRequest]);

  const beginSidebarResize = useCallback((side: "left" | "right", event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = side === "left" ? leftWidth : rightWidth;
    const otherWidth = side === "left" ? (rightOpen ? rightWidth : 0) : (leftOpen ? leftWidth : 0);
    const move = (pointerEvent: PointerEvent) => {
      const delta = pointerEvent.clientX - startX;
      const desired = side === "left" ? startWidth + delta : startWidth - delta;
      const minimum = side === "left" ? 180 : 280;
      const configuredMaximum = side === "left" ? 360 : 480;
      const maximum = Math.max(minimum, Math.min(configuredMaximum, window.innerWidth - otherWidth - 420));
      const next = Math.min(maximum, Math.max(minimum, desired));
      if (side === "left") setLeftWidth(next); else setRightWidth(next);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      document.body.classList.remove("resizing-sidebar");
    };
    document.body.classList.add("resizing-sidebar");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }, [leftOpen, leftWidth, rightOpen, rightWidth]);

  useEffect(() => {
    if (!preflight?.ok || startupRestoreStartedRef.current) return;
    startupRestoreStartedRef.current = true;
    void (async () => {
      if (!window.pdfMuse) {
        await refreshLibrary();
        setStartupReady(true);
        return;
      }
      try {
        const result = await window.pdfMuse.openRecentLibraryBook();
        if (result?.ok) activateBook(result.book);
        else {
          if (result) handleOpenResult(result);
          await refreshLibrary();
        }
      } catch {
        setLibraryError("无法恢复最近阅读的书籍，已返回书库。");
        await refreshLibrary();
      } finally {
        setStartupReady(true);
      }
    })();
  }, [activateBook, handleOpenResult, preflight, refreshLibrary]);

  const openBook = useCallback(async () => {
    if (!window.pdfMuse) return;
    try {
      const selected = await window.pdfMuse.choosePdfBook();
      if (selected) handleOpenResult(selected);
    } catch {
      setLibraryError("无法打开文件选择器，请重试。");
    }
  }, [handleOpenResult]);

  const openDroppedBook = useCallback(async (file?: File) => {
    if (!window.pdfMuse) {
      setLibraryError("拖放打开 PDF 仅在桌面应用中可用。");
      return;
    }
    if (!file?.name || !file.name.toLowerCase().endsWith(".pdf")) {
      setLibraryError(file?.name ? "请拖入一个 PDF 文件。" : "每次只能拖入一个 PDF 文件。");
      return;
    }
    try {
      handleOpenResult(await window.pdfMuse.openDroppedPdf(file));
    } catch {
      setLibraryError("无法读取拖入的 PDF 文件，请重试。");
    }
  }, [handleOpenResult]);

  const openLibraryBook = useCallback(async (bookId: string) => {
    if (!window.pdfMuse) return;
    try {
      handleOpenResult(await window.pdfMuse.openLibraryBook(bookId), bookId);
    } catch {
      setLibraryError("无法打开这本 PDF 书籍，请重试。");
    }
  }, [handleOpenResult]);

  const relocateLibraryBook = useCallback(async (bookId: string) => {
    if (!window.pdfMuse) return;
    try {
      const result = await window.pdfMuse.relocateLibraryBook(bookId);
      if (result) handleOpenResult(result, bookId);
    } catch {
      setLibraryError("无法重新定位这本 PDF 书籍，请重试。");
    }
  }, [handleOpenResult]);

  const removeLibraryBook = useCallback(async (bookId: string) => {
    if (!window.pdfMuse) return;
    try {
      const result = await window.pdfMuse.removeLibraryBook(bookId);
      if (!result.ok) setLibraryError(result.message);
      else {
        setLibraryError("");
        setUnavailableBookId(undefined);
        await refreshLibrary();
      }
    } catch {
      setLibraryError("无法将这本书移出书库，请稍后重试。");
    }
  }, [refreshLibrary]);

  const deleteLibraryBookData = useCallback(async (bookId: string) => {
    if (!window.pdfMuse) return;
    try {
      const result = await window.pdfMuse.deleteLibraryBookData(bookId);
      if (!result.ok) setLibraryError(result.message);
      else {
        setLibraryError("");
        setUnavailableBookId(undefined);
        await refreshLibrary();
      }
    } catch {
      setLibraryError("无法删除本书数据，请稍后重试。");
    }
  }, [refreshLibrary]);

  const findInBook = useCallback(async (query: string, previous = false) => {
    const normalized = query.trim();
    viewerRef.current?.find(normalized, previous);
    if (!normalized || !book || !window.pdfMuse) return;
    try {
      const result = await window.pdfMuse.searchBook(book.id, normalized, 20);
      const pages = result.hits.filter((hit) => hit.source === "pdf" && typeof hit.page === "number").map((hit) => hit.page as number);
      if (pages.length > 0 && !pages.includes(viewerState.page)) {
        viewerRef.current?.goToPage(previous ? pages[pages.length - 1]! : pages[0]!);
      }
      if (pages.length > 0 && result.note) setOcrNotice(result.note);
      else if (pages.length > 0 && viewerState.findTotal === 0) setOcrNotice(`识别文字命中 ${pages.length} 页，已跳转到${previous ? "最后" : "第一"}个结果。`);
    } catch {
      // PDF.js 原生查找仍然可用，索引查询失败不阻断阅读。
    }
  }, [book, viewerState.findTotal, viewerState.page]);

  const showLibrary = useCallback(() => {
    activeBookIdRef.current = undefined;
    setBook(undefined);
    setViewerError("");
    setPassage(undefined);
    setLibraryError("");
    setUnavailableBookId(undefined);
    setLibraryLoading(true);
    resetReaderSideState();
    void refreshLibrary();
  }, [refreshLibrary, resetReaderSideState]);

  const handleViewerState = useCallback((state: ViewerState) => {
    setViewerState(state);
    trackViewerState(state);
  }, [trackViewerState]);

  const handleViewerSelection = useCallback((selection?: ViewerSelection) => {
    if (!selection) {
      setPassage(undefined);
      return;
    }
    if (selection.kind === "rejected") {
      setPassage(undefined);
      setSelectionFeedback({ message: selection.message, tone: "error" });
      return;
    }
    setSelectionFeedback(undefined);
    setPassage(selection);
  }, []);

  useEffect(() => {
    if (!selectionFeedback) return;
    const timer = window.setTimeout(() => setSelectionFeedback(undefined), 3_000);
    return () => window.clearTimeout(timer);
  }, [selectionFeedback]);

  const clearBookConversation = useCallback(async () => {
    setClearingConversation(true);
    const outcome = await clear();
    setClearingConversation(false);
    if (outcome === "ok") setClearConversationOpen(false);
  }, [clear]);

  const explain = useCallback((selectedPassage: SelectedPassage) => {
    setRightOpen(true);
    setPassage(undefined);
    void ask("请解释这段内容。", selectedPassage);
  }, [ask]);

  const askAboutPassage = useCallback((selectedPassage: SelectedPassage) => {
    setAttachedPassage(selectedPassage);
    setRightOpen(true);
    setPassage(undefined);
    // 已展开时同步聚焦：不留延迟回调——渲染繁忙时迟到的 focus 会塌掉其后新建的页面选区。
    if (rightOpen) composerRef.current?.focus();
  }, [rightOpen]);

  // 右栏由收起转展开的场合，composer 在提交后才挂载，此时补一次聚焦。
  const prevRightOpenRef = useRef(rightOpen);
  useEffect(() => {
    const expanded = !prevRightOpenRef.current && rightOpen;
    prevRightOpenRef.current = rightOpen;
    if (expanded && attachedPassage) composerRef.current?.focus();
  }, [rightOpen, attachedPassage]);

  const copyPassage = useCallback(async (selectedPassage: SelectedPassage) => {
    setPassage(undefined);
    try {
      await navigator.clipboard.writeText(selectedPassage.text);
      setSelectionFeedback({ message: "已复制选中原文。", tone: "success" });
    } catch {
      setSelectionFeedback({ message: "复制失败，请检查系统剪贴板权限后重试。", tone: "error" });
    }
  }, []);

  const addClipboardImages = useCallback(async (items: DataTransferItem[]) => {
    const remaining = MAX_AGENT_IMAGE_ATTACHMENTS - attachmentsRef.current.length;
    if (remaining <= 0) {
      notify(`最多添加 ${MAX_AGENT_IMAGE_ATTACHMENTS} 张截图。`);
      return;
    }
    const files = items.slice(0, remaining).map((item) => item.getAsFile()).filter((file): file is File => Boolean(file));
    if (files.length < items.slice(0, remaining).length) {
      notify("无法读取剪贴板截图，请重试。");
      return;
    }
    const accepted: AgentImageAttachment[] = [];
    for (const file of files) {
      const mimeType = file.type.toLowerCase();
      if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mimeType)) {
        notify("仅支持 PNG、JPEG、WEBP 或 GIF 截图。");
        continue;
      }
      if (file.size > MAX_AGENT_IMAGE_BYTES) {
        notify("单张截图不能超过 8 MB。");
        continue;
      }
      const dataUrl = await new Promise<string | undefined>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : undefined);
        reader.onerror = () => resolve(undefined);
        reader.readAsDataURL(file);
      });
      const data = dataUrl?.split(",", 2)[1];
      if (!data) {
        notify("读取截图失败，请重试。");
        continue;
      }
      accepted.push({
        id: typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${accepted.length}`,
        mimeType: mimeType as AgentImageAttachment["mimeType"],
        data,
      });
    }
    if (accepted.length > 0) {
      setAttachments((current) => [...current, ...accepted].slice(0, MAX_AGENT_IMAGE_ATTACHMENTS));
      notify("");
    }
    if (items.length > remaining) notify(`最多添加 ${MAX_AGENT_IMAGE_ATTACHMENTS} 张截图，超出的图片未添加。`);
  }, []);

  const handleComposerPaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imageItems = Array.from(event.clipboardData.items).filter((item) => item.kind === "file" && item.type.toLowerCase().startsWith("image/"));
    if (imageItems.length === 0) return;
    event.preventDefault();
    void addClipboardImages(imageItems);
  }, [addClipboardImages]);

  const sendDraft = useCallback(async () => {
    const question = draft.trim();
    if (!question || busy) return;
    const passage = attachedPassage;
    const imageAttachments = attachments;
    setDraft("");
    setAttachedPassage(undefined);
    setAttachments([]);
    const accepted = await ask(question, passage, imageAttachments);
    if (!accepted) {
      // 启动失败时恢复已提交的问题与附件；用户随后输入的新草稿优先。
      setDraft((current) => current || question);
      setAttachedPassage((current) => current ?? passage);
      setAttachments((current) => (current.length > 0 ? current : imageAttachments));
    }
  }, [ask, attachedPassage, attachments, busy, draft]);

  const passageByRun = useMemo(() => {
    const map = new Map<string, { page: number; text: string }>();
    for (const message of conversationState.messages) {
      if (message.role === "reader" && message.passage) map.set(message.runId, message.passage);
    }
    return map;
  }, [conversationState.messages]);

  // 稳定引用：memo 化的会话消息项依赖它跳过重渲染。
  const goToPage = useCallback((page: number) => viewerRef.current?.goToPage(page), []);

  // 运行详情抽屉：入口在消息与流式气泡上；打开时拉取环形缓冲补历史。
  const [debugRunId, setDebugRunId] = useState<string>();
  const openDiagnostics = useCallback((runId: string) => setDebugRunId(runId), []);
  const openMessageDiagnostics = useCallback((message: ConversationMessage) => setDebugRunId(message.runId), []);
  useEffect(() => {
    if (debugRunId) void refreshDiagnostics();
  }, [debugRunId, refreshDiagnostics]);

  // 流式输出期间保持对话底部可见。
  useEffect(() => {
    const container = conversationRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, [conversationState.messages, conversationState.streaming]);

  if (!preflight) return <div className="boot-state">正在检查数据目录...</div>;
  if (!preflight.ok) {
    return (
      <main className="preflight-failure">
        <div className="failure-mark">!</div>
        <h1>PDFMuse 无法安全启动</h1>
        <p>{preflight.message}</p>
        <code>{preflight.dataHome}</code>
        <p className="failure-help">请将整个 PDFMuse 文件夹移动到可写位置后重新启动。</p>
      </main>
    );
  }
  if (!startupReady) return <div className="boot-state">正在恢复最近阅读...</div>;
  if (!book) {
    return <>{apiMismatchBanner}<LibraryView books={libraryBooks} error={libraryError} loading={libraryLoading} unavailableBookId={unavailableBookId} warnings={preflight.warnings} appearance={appearance} onAppearancePreview={previewAppearance} onAppearanceSaved={handleAppearanceSaved} onChoose={openBook} onDropFile={openDroppedBook} onOpenBook={openLibraryBook} onRelocate={relocateLibraryBook} onRemove={removeLibraryBook} onDeleteData={deleteLibraryBookData} /><PasswordDialog request={passwordRequest} onCancel={() => setPasswordRequest(undefined)} onUnlock={unlockPdf} /></>;
  }

  return (
    <Tooltip.Provider>
      {apiMismatchBanner}
      <div
        className={`workspace ${leftOpen ? "left-open" : ""} ${rightOpen ? "right-open" : ""}`}
        style={{ "--left-width": `${leftWidth}px`, "--right-width": `${rightWidth}px` } as CSSProperties}
      >
        <header className="topbar">
          <div className="brand"><span className="brand-mark">PM</span><strong>PDFMuse</strong></div>
          <div className="document-bar">
            <IconButton label="返回书库" onClick={showLibrary}><Library /></IconButton>
            <IconButton label={leftOpen ? "收起目录" : "展开目录"} onClick={() => setLeftOpen((value) => !value)}><PanelLeftClose /></IconButton>
            <button className="book-title" onClick={openBook} title={book.path}>{book.name}<ChevronDown size={14} /></button>
            <IconButton label="打开另一本 PDF" onClick={openBook}><FilePlus2 /></IconButton>
          </div>
          <div className="top-actions">
            <span className="data-home-status" title={preflight.dataHome}><span />数据目录</span>
            <SettingsDialog warnings={preflight.warnings} appearance={appearance} onAppearancePreview={previewAppearance} onAppearanceSaved={handleAppearanceSaved} />
            <IconButton label={rightOpen ? "收起 AI 助手" : "展开 AI 助手"} onClick={() => setRightOpen((value) => !value)}><PanelRightClose /></IconButton>
          </div>
        </header>

        {leftOpen && (
          <aside className="left-sidebar">
            <div className="left-sidebar-content">
              <div className="book-summary">
                <div className="mini-cover">PDF<br />MUSE</div>
                <div><strong>{book.name}</strong><span>第 {viewerState.page} / {viewerState.pages || "-"} 页</span></div>
              </div>
              <div className="sidebar-tabs"><button className={sidebarView === "outline" ? "active" : ""} onClick={() => setSidebarView("outline")}>目录</button><button className={sidebarView === "thumbnails" ? "active" : ""} onClick={() => setSidebarView("thumbnails")}>缩略图</button></div>
              {sidebarView === "outline" ? (
                <OutlinePanel nodes={effectiveOutline} page={viewerState.page} emptyMessage={outlineEmptyMessage} onGoToPage={(page) => viewerRef.current?.goToPage(page)} />
              ) : (
                <div className="thumbnail-list">
                  {Array.from({ length: viewerState.pages }, (_, index) => index + 1).map((page) => (
                    <PdfThumbnail key={page} page={page} current={page === viewerState.page} load={() => viewerRef.current?.getThumbnail(page) ?? Promise.resolve(undefined)} onOpen={() => viewerRef.current?.goToPage(page)} />
                  ))}
                </div>
              )}
            </div>
            <div className="sidebar-resize-handle left" role="separator" aria-label="调整左侧栏宽度" aria-orientation="vertical" onPointerDown={(event) => beginSidebarResize("left", event)} />
          </aside>
        )}

        <main className="reader">
          {libraryError && (
            <div className="reader-notice" role="alert">
              <span>{libraryError}</span>
              <button aria-label="关闭错误提示" onClick={() => setLibraryError("")}><X size={14} /></button>
            </div>
          )}
          {selectionFeedback && (
            <div className={`reader-notice selection-feedback ${selectionFeedback.tone}`} role={selectionFeedback.tone === "error" ? "alert" : "status"}>
              <span>{selectionFeedback.message}</span>
              <button aria-label="关闭选区提示" onClick={() => setSelectionFeedback(undefined)}><X size={14} /></button>
            </div>
          )}
          <div className="reader-toolbar">
            <IconButton label="上一页" disabled={viewerState.page <= 1} onClick={() => viewerRef.current?.previousPage()}><ChevronLeft /></IconButton>
            <label className="page-control"><input value={viewerState.page} onChange={(event) => viewerRef.current?.goToPage(Number(event.target.value))} aria-label="当前页" /><span>/ {viewerState.pages || "-"}</span></label>
            <IconButton label="下一页" disabled={viewerState.page >= viewerState.pages} onClick={() => viewerRef.current?.nextPage()}><ChevronRight /></IconButton>
            <span className="toolbar-divider" />
            <IconButton label="缩小" onClick={() => viewerRef.current?.zoomOut()}><Minus /></IconButton>
            <span className="zoom-value">{viewerState.scale}%</span>
            <IconButton label="放大" onClick={() => viewerRef.current?.zoomIn()}><Plus /></IconButton>
            <IconButton label="适合宽度" onClick={() => viewerRef.current?.fitWidth()}><ChevronsLeft /></IconButton>
            <IconButton label="适合页面" onClick={() => viewerRef.current?.fitPage()}><Focus /></IconButton>
            <span className="toolbar-divider" />
            <IconButton aria-pressed={panMode} label={panMode ? "关闭拖拽浏览" : "开启拖拽浏览"} onClick={() => setPanMode((value) => !value)}><Hand /></IconButton>
            <IconButton label="在 PDF 中查找" onClick={() => setFindOpen((value) => !value)}><Search /></IconButton>
            <IconButton label={ocrLoading ? "正在识别当前页" : "识别当前页文字"} disabled={ocrLoading} onClick={() => void recognizeCurrentPage}><ScanText /></IconButton>
          </div>
          {visibleBackgroundJob && (
            <div className="background-job-control">
                <span
                  className={`background-job-status ${visibleBackgroundJob.status}`}
                  title={visibleBackgroundJob.errorMessage}
                  role="status"
                >
                  {visibleBackgroundJob.status === "running" && <Loader2 size={13} />}
                  <span>{BACKGROUND_JOB_KIND_LABELS[visibleBackgroundJob.kind]} · {BACKGROUND_JOB_STATUS_LABELS[visibleBackgroundJob.status]}</span>
                  {visibleBackgroundJob.total > 0 && visibleBackgroundJob.status !== "failed" && (
                    <span>{visibleBackgroundJob.progress}/{visibleBackgroundJob.total}</span>
                  )}
                </span>
                {(visibleBackgroundJob.status === "running" || visibleBackgroundJob.status === "queued") && (
                  <IconButton label="暂停后台任务" onClick={() => void mutateBackgroundJob("pause")}><Pause /></IconButton>
                )}
                {(visibleBackgroundJob.status === "paused" || visibleBackgroundJob.status === "failed") && (
                  <IconButton label={visibleBackgroundJob.status === "failed" ? "重试后台任务" : "继续后台任务"} onClick={() => void mutateBackgroundJob("resume")}><Play /></IconButton>
                )}
                {(visibleBackgroundJob.status === "running" || visibleBackgroundJob.status === "queued" || visibleBackgroundJob.status === "paused") && (
                  <IconButton label="取消后台任务" onClick={() => void mutateBackgroundJob("cancel")}><X /></IconButton>
                )}
            </div>
          )}
          {findOpen && (
            <form className="find-bar" onSubmit={(event) => { event.preventDefault(); void findInBook(findQuery); }}>
              <Search size={15} />
              <input autoFocus value={findQuery} onChange={(event) => setFindQuery(event.target.value)} placeholder="查找文字" />
              <span className="find-count">{viewerState.findTotal > 0 ? `${viewerState.findCurrent} / ${viewerState.findTotal}` : "0 / 0"}</span>
              <IconButton type="button" label="上一个结果" onClick={() => void findInBook(findQuery, true)}><ChevronLeft /></IconButton>
              <IconButton type="submit" label="下一个结果"><ChevronRight /></IconButton>
              <IconButton type="button" label="关闭查找" onClick={() => { viewerRef.current?.find(""); setFindQuery(""); setFindOpen(false); }}><X /></IconButton>
            </form>
          )}
          {ocrNotice && <div className="reader-notice" role="status"><span>{ocrNotice}</span><button aria-label="关闭识别提示" onClick={() => setOcrNotice("")}><X size={14} /></button></div>}
          {viewerError ? <div className="viewer-error"><strong>无法打开 PDF 书籍</strong><span>{viewerError}</span></div> : <PdfViewer ref={viewerRef} book={book} panMode={panMode} recognizedPage={recognizedPage} onStateChange={handleViewerState} onSelectionChange={handleViewerSelection} onError={setViewerError} />}
        </main>

        {rightOpen && (
          <aside className="assistant-panel">
            <div className="sidebar-resize-handle right" role="separator" aria-label="调整右侧栏宽度" aria-orientation="vertical" onPointerDown={(event) => beginSidebarResize("right", event)} />
            <header className="assistant-header">
              <div className="assistant-heading"><span className="assistant-title"><Sparkles size={16} />AI 助手</span><span className="assistant-context">本书对话 · 当前 PDF 书籍</span></div>
              <IconButton label="导出会话为 Markdown" disabled={conversationState.messages.length === 0 || busy || conversationState.loading} onClick={() => void exportMarkdown()}><Download /></IconButton>
              <IconButton label="清空本书会话" disabled={conversationState.messages.length === 0 || busy || conversationState.loading} onClick={() => setClearConversationOpen(true)}><Trash2 /></IconButton>
            </header>
            <div className="conversation" ref={conversationRef}>
              {conversationState.messages.length === 0 && !conversationState.streaming && !conversationState.loading ? (
                <div className="conversation-empty"><Bot size={24} /><strong>从原文开始</strong><span>选中文字后解释，或直接询问这本 PDF 书籍。</span></div>
              ) : (
                <>
                  {conversationState.loading && conversationState.messages.length === 0 && <div className="conversation-loading">正在读取对话...</div>}
                  {conversationState.messages.map((message) => (
                    <ConversationMessageItem
                      key={message.id}
                      message={message}
                      referencePages={getConversationReferencePages(message, passageByRun.get(message.runId)?.page)}
                      onRetry={retry}
                      onOpenPage={goToPage}
                      onOpenDiagnostics={openMessageDiagnostics}
                    />
                  ))}
                  {conversationState.streaming && (
                    <article className="message assistant streaming">
                      <div className="message-role">
                        <span>PDFMuse</span>
                        <button
                          className="diag-entry"
                          aria-label="查看运行详情"
                          title="查看运行详情（发给模型的内容与 AI 的行为）"
                          onClick={() => openDiagnostics(conversationState.streaming!.runId)}
                        ><Bug size={12} /></button>
                      </div>
                      {conversationState.streaming.body ? <MarkdownView markdown={conversationState.streaming.body} streaming /> : <div className="streaming-hint"><Loader2 size={13} className="spin" />正在生成回答...</div>}
                      {conversationState.toolStatus && <div className="tool-status" role="status"><Search size={12} className="spin" />{conversationState.toolStatus}</div>}
                      {conversationState.streaming.body && <span className="streaming-cursor" aria-hidden />}
                    </article>
                  )}
                </>
              )}
            </div>
            {conversationState.notice && (
              <div className="agent-notice" role="alert">
                <span>{conversationState.notice}</span>
                <button aria-label="关闭提示" onClick={dismissNotice}><X size={13} /></button>
              </div>
            )}
            <div className="composer-wrap">
              {attachedPassage && <div className="passage-chip"><span>已选原文 · 第 {attachedPassage.page} 页</span><p>{attachedPassage.text}</p><button aria-label="移除已选原文" onClick={() => setAttachedPassage(undefined)}><X size={14} /></button></div>}
              {attachments.length > 0 && (
                <div className="attachment-strip" aria-label="截图附件">
                  {attachments.map((attachment, index) => (
                    <div className="attachment-thumb" key={attachment.id}>
                      <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt={`截图 ${index + 1}`} />
                      <button aria-label={`移除截图 ${index + 1}`} onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}><X size={12} /></button>
                    </div>
                  ))}
                </div>
              )}
              <div className="composer">
                <textarea ref={composerRef} value={draft} onChange={(event) => setDraft(event.target.value)} onPaste={handleComposerPaste} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendDraft(); } }} placeholder={attachments.length > 0 ? "已添加截图，输入问题..." : "询问这本 PDF 书籍..."} rows={2} />
                {conversationState.streaming
                  ? <button className="send-button stop" aria-label="停止回答" onClick={() => void cancel()}><Square size={14} /></button>
                  : <button className="send-button" aria-label="发送问题" disabled={!draft.trim()} onClick={() => void sendDraft()}><Send size={17} /></button>}
              </div>
              <div className="composer-meta" title={`粘贴截图，最多 ${MAX_AGENT_IMAGE_ATTACHMENTS} 张`} aria-label={`截图附件 ${attachments.length}/${MAX_AGENT_IMAGE_ATTACHMENTS}`}><ImagePlus size={12} />{attachments.length > 0 && <span>{attachments.length}/{MAX_AGENT_IMAGE_ATTACHMENTS}</span>}</div>
            </div>
            {debugRunId && (
              <DiagnosticsDrawer
                run={conversationState.diagnostics[debugRunId]}
                onClose={() => setDebugRunId(undefined)}
              />
            )}
          </aside>
        )}

        {passage && (
          <div className="selection-popover" style={{ left: passage.popover.x, top: Math.max(12, passage.popover.y - 48) }}>
            <button onClick={() => explain(passage.passage)}><Sparkles size={14} />解释</button>
            <button onClick={() => askAboutPassage(passage.passage)}><MessageSquareText size={14} />提问</button>
            <span />
            <button onClick={() => void copyPassage(passage.passage)}><Copy size={14} />复制</button>
          </div>
        )}
        <PasswordDialog request={passwordRequest} onCancel={() => setPasswordRequest(undefined)} onUnlock={unlockPdf} />
        <Dialog.Root open={clearConversationOpen} onOpenChange={(open) => { if (!clearingConversation) setClearConversationOpen(open); }}>
          <Dialog.Portal>
            <Dialog.Overlay className="dialog-overlay" />
            <Dialog.Content className="settings-dialog conversation-clear-dialog" aria-describedby="clear-conversation-description">
              <div className="dialog-heading">
                <div><Dialog.Title>清空本书会话</Dialog.Title><Dialog.Description id="clear-conversation-description">将删除这本 PDF 的全部聊天记录和会话摘要。OCR 与 PDF 索引会保留。</Dialog.Description></div>
                <Dialog.Close asChild><IconButton label="关闭清空会话确认" disabled={clearingConversation}><X /></IconButton></Dialog.Close>
              </div>
              <div className="library-manage-actions">
                <Dialog.Close asChild><button className="secondary-command" disabled={clearingConversation}>取消</button></Dialog.Close>
                <button className="danger-command" disabled={clearingConversation} onClick={() => void clearBookConversation()}><Trash2 size={16} />{clearingConversation ? "正在清空..." : "确认清空"}</button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </div>
    </Tooltip.Provider>
  );
}
