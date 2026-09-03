import * as Tooltip from "@radix-ui/react-tooltip";
import * as Dialog from "@radix-ui/react-dialog";
import {
  BookOpen,
  Bot,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Copy,
  FilePlus2,
  Focus,
  Hand,
  Library,
  Loader2,
  LockKeyhole,
  MessageSquareText,
  Minus,
  PanelLeftClose,
  PanelRightClose,
  Plus,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  Square,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import type {
  AgentStreamEvent,
  ConversationMessage,
  LibraryBook,
  OpenedPdfBook,
  OpenPdfBookResult,
  ReadingState,
  SelectedPassage,
  StartupPreflight,
} from "../shared/contracts";
import { IconButton } from "./components/IconButton";
import { MarkdownView } from "./components/MarkdownView";
import { SettingsDialog } from "./components/SettingsDialog";
import { PdfViewer, type OutlineNode, type PdfViewerHandle, type ViewerSelection, type ViewerState } from "./pdf/PdfViewer";
import { createReadingStateWriter } from "./reading-state-persistence";

type PassagePopover = Extract<ViewerSelection, { kind: "selected" }>;
type StreamingReply = { runId: string; sessionId: string; body: string };

const browserPreflight: StartupPreflight = {
  ok: true,
  dataHome: "浏览器预览模式",
  warnings: ["桌面文件访问仅在 Electron 中启用。"],
};

function flattenOutline(nodes: OutlineNode[]): OutlineNode[] {
  return nodes.flatMap((node) => [node, ...flattenOutline(node.children)]);
}

function findOutlinePath(nodes: OutlineNode[], targetId: string): string[] {
  for (const node of nodes) {
    if (node.id === targetId) return [node.id];
    const childPath = findOutlinePath(node.children, targetId);
    if (childPath.length > 0) return [node.id, ...childPath];
  }
  return [];
}

function OutlineTree({
  nodes,
  activeId,
  expanded,
  onToggle,
  onGoToPage,
}: {
  nodes: OutlineNode[];
  activeId?: string;
  expanded: Set<string>;
  onToggle(id: string): void;
  onGoToPage(page: number): void;
}) {
  if (nodes.length === 0) {
    return <p className="outline-empty">此 PDF 书籍没有内置目录。后续 OCR 阶段将补全章节。</p>;
  }

  return (
    <div className="outline-tree">
      {nodes.map((node) => (
        <div className="outline-group" key={node.id}>
          <div className={`outline-row ${node.id === activeId ? "current" : ""}`} data-outline-id={node.id}>
            {node.children.length > 0 ? (
              <button className="outline-toggle" aria-label={expanded.has(node.id) ? "折叠章节" : "展开章节"} onClick={() => onToggle(node.id)}>
                {expanded.has(node.id) ? <ChevronDown /> : <ChevronRight />}
              </button>
            ) : <span className="outline-spacer" />}
            <button className="outline-item" disabled={!node.page} onClick={() => node.page && onGoToPage(node.page)}>
              <span>{node.label}</span>
              {node.page && <span className="outline-page">{node.page}</span>}
            </button>
          </div>
          {node.children.length > 0 && expanded.has(node.id) && (
            <OutlineTree nodes={node.children} activeId={activeId} expanded={expanded} onToggle={onToggle} onGoToPage={onGoToPage} />
          )}
        </div>
      ))}
    </div>
  );
}

function OutlinePanel({ nodes, page, onGoToPage }: { nodes: OutlineNode[]; page: number; onGoToPage(page: number): void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const activeId = useMemo(() => {
    let active: OutlineNode | undefined;
    for (const node of flattenOutline(nodes)) {
      if (node.page !== undefined && node.page <= page && (!active?.page || node.page >= active.page)) active = node;
    }
    return active?.id;
  }, [nodes, page]);

  useEffect(() => {
    setExpanded(new Set(flattenOutline(nodes).filter((node) => node.children.length > 0).map((node) => node.id)));
  }, [nodes]);

  useEffect(() => {
    if (!activeId) return;
    setExpanded((current) => new Set([...current, ...findOutlinePath(nodes, activeId)]));
    requestAnimationFrame(() => {
      rootRef.current?.querySelector(`[data-outline-id="${activeId}"]`)?.scrollIntoView({ block: "nearest" });
    });
  }, [activeId, nodes]);

  return (
    <div className="outline-panel" ref={rootRef}>
      <OutlineTree
        nodes={nodes}
        activeId={activeId}
        expanded={expanded}
        onToggle={(id) => setExpanded((current) => {
          const next = new Set(current);
          if (next.has(id)) next.delete(id); else next.add(id);
          return next;
        })}
        onGoToPage={onGoToPage}
      />
    </div>
  );
}

function PdfThumbnail({ page, current, load, onOpen }: { page: number; current: boolean; load(): Promise<string | undefined>; onOpen(): void }) {
  const itemRef = useRef<HTMLButtonElement>(null);
  const [source, setSource] = useState<string>();
  useEffect(() => {
    const item = itemRef.current;
    if (!item || source) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void load().then(setSource);
    }, { rootMargin: "180px" });
    observer.observe(item);
    return () => observer.disconnect();
  }, [load, source]);
  useEffect(() => {
    if (current) itemRef.current?.scrollIntoView({ block: "nearest" });
  }, [current]);
  return (
    <button ref={itemRef} className={`pdf-thumbnail ${current ? "current" : ""}`} aria-current={current ? "page" : undefined} onClick={onOpen}>
      <span className="thumbnail-page">{source ? <img src={source} alt={`第 ${page} 页缩略图`} /> : <span>正在载入</span>}</span>
      <strong>第 {page} 页</strong>
    </button>
  );
}

type PasswordRequest = Extract<OpenPdfBookResult, { ok: false; code: "PASSWORD_REQUIRED" }>;

function PasswordDialog({ request, onCancel, onUnlock }: { request?: PasswordRequest; onCancel(): void; onUnlock(password: string, remember: boolean): Promise<void> }) {
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setPassword(""), [request?.challengeId]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    try { await onUnlock(password, remember); } finally { setBusy(false); }
  };
  return (
    <Dialog.Root open={Boolean(request)} onOpenChange={(open) => { if (!open && !busy) onCancel(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="password-overlay" />
        <Dialog.Content className="password-dialog" aria-describedby="pdf-password-description">
          <div className="password-mark"><LockKeyhole /></div>
          <Dialog.Title>打开加密 PDF</Dialog.Title>
          <Dialog.Description id="pdf-password-description">{request?.message}</Dialog.Description>
          <form onSubmit={(event) => void submit(event)}>
            <label>PDF 密码<input autoFocus type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
            <label className="remember-password"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />记住这本书的密码</label>
            <p>记住后，密码会以明文保存在 PDFMuse 便携数据目录中。复制程序目录也会复制此密码。</p>
            <div className="password-actions"><button type="button" className="secondary-command" disabled={busy} onClick={onCancel}>取消</button><button className="primary-command" disabled={!password || busy}>{busy ? "正在验证..." : "解锁"}</button></div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function formatUpdatedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "更新时间未知";
  return `更新于 ${new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)}`;
}

type LibraryViewProps = {
  books: LibraryBook[];
  error: string;
  loading: boolean;
  unavailableBookId?: string;
  warnings: string[];
  onChoose(): Promise<void>;
  onDropFile(file?: File): Promise<void>;
  onOpenBook(bookId: string): Promise<void>;
  onRelocate(bookId: string): Promise<void>;
};

function LibraryView({
  books,
  error,
  loading,
  unavailableBookId,
  warnings,
  onChoose,
  onDropFile,
  onOpenBook,
  onRelocate,
}: LibraryViewProps) {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  const handleDrop = (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length !== 1) return void run(() => onDropFile());
    void run(() => onDropFile(files[0]!));
  };

  return (
    <Tooltip.Provider>
      <main
        className={`library-view ${dragging ? "is-dragging" : ""}`}
        onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          const nextTarget = event.relatedTarget;
          if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) setDragging(false);
        }}
        onDrop={handleDrop}
      >
        <header className="library-topbar">
          <div className="library-brand"><span>PM</span><strong>PDFMuse</strong></div>
          <SettingsDialog warnings={warnings} />
        </header>
        <section className="library-content">
          <div className="library-heading">
            <div><h1>书库</h1><p>{books.length > 0 ? `共 ${books.length} 本 PDF 书籍` : "你的 PDF 阅读空间"}</p></div>
            <button className="primary-command" disabled={busy} onClick={() => void run(onChoose)}><FilePlus2 size={17} />选择 PDF</button>
          </div>

          {error && (
            <div className="library-error" role="alert">
              <span>{error}</span>
              {unavailableBookId && (
                <button className="secondary-command" disabled={busy} onClick={() => void run(() => onRelocate(unavailableBookId))}>重新定位原文件</button>
              )}
            </div>
          )}

          {loading ? (
            <div className="library-loading">正在读取书库...</div>
          ) : books.length === 0 ? (
            <div className="library-empty">
              <div className="empty-icon"><BookOpen size={30} /></div>
              <h2>打开第一本 PDF 书籍</h2>
              <p>选择文件或将一个 PDF 拖到这里。原文件只会被读取，不会移动、复制或修改。</p>
              <button className="primary-command" disabled={busy} onClick={() => void run(onChoose)}><FilePlus2 size={17} />选择 PDF</button>
            </div>
          ) : (
            <div className="library-grid">
              {books.map((item) => (
                <button
                  className="library-book"
                  key={item.id}
                  disabled={busy}
                  onClick={() => void run(() => onOpenBook(item.id))}
                  aria-label={`打开《${item.title}》`}
                >
                  <span className={`library-cover cover-${Number.parseInt(item.id.slice(0, 2), 16) % 4}`}>
                    <span className="cover-label">PDFMuse</span>
                    <strong>{item.title}</strong>
                    <span className="cover-rule" />
                    <small>PDF · {item.pageCount} 页</small>
                  </span>
                  <span className="library-book-info">
                    <strong title={item.title}>{item.title}</strong>
                    <span>读至第 {item.currentPage} 页，共 {item.pageCount} 页</span>
                    <span>{formatUpdatedAt(item.updatedAt)}</span>
                  </span>
                </button>
              ))}
            </div>
          )}

          <div className="library-drop-hint"><Upload size={15} />也可以将一个 PDF 文件拖到窗口中</div>
        </section>
        {dragging && <div className="drop-overlay"><Upload size={30} /><strong>松开以加入书库</strong><span>仅接受一个 PDF 文件</span></div>}
      </main>
    </Tooltip.Provider>
  );
}

export function App() {
  const viewerRef = useRef<PdfViewerHandle>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const startupRestoreStartedRef = useRef(false);
  const readingStateRef = useRef<ReadingState>({
    page: 1,
    scrollTop: 0,
    zoomMode: "page-width",
    zoomScale: 100,
    leftSidebarOpen: true,
    rightSidebarOpen: true,
  });
  const leftOpenRef = useRef(true);
  const rightOpenRef = useRef(true);
  const stateWriterRef = useRef<ReturnType<typeof createReadingStateWriter<{
    bookId: string;
    state: ReadingState;
  }>> | null>(null);
  if (!stateWriterRef.current) {
    stateWriterRef.current = createReadingStateWriter(({ bookId, state }) => {
      void window.pdfMuse?.updateLibraryBookState(bookId, state).catch(() => undefined);
    });
  }
  const [preflight, setPreflight] = useState<StartupPreflight>();
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
  const [conversation, setConversation] = useState<ConversationMessage[]>([]);
  const [streamingReply, setStreamingReply] = useState<StreamingReply>();
  const [agentNotice, setAgentNotice] = useState("");
  const [conversationLoading, setConversationLoading] = useState(false);
  const conversationRef = useRef<HTMLDivElement>(null);
  const activeRunRef = useRef<StreamingReply | undefined>(undefined);

  useEffect(() => {
    void (window.pdfMuse?.getStartupPreflight() ?? Promise.resolve(browserPreflight)).then(setPreflight);
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

  const refreshConversation = useCallback(async (bookId: string) => {
    if (!window.pdfMuse) return;
    setConversationLoading(true);
    try {
      setConversation(await window.pdfMuse.getBookConversation(bookId));
    } catch {
      setAgentNotice("无法读取本书对话记录。");
    } finally {
      setConversationLoading(false);
    }
  }, []);

  const resetConversationState = useCallback(() => {
    setConversation([]);
    setStreamingReply(undefined);
    setAgentNotice("");
    activeRunRef.current = undefined;
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
    stateWriterRef.current?.flush();
    readingStateRef.current = openedBook.readingState;
    leftOpenRef.current = openedBook.readingState.leftSidebarOpen;
    rightOpenRef.current = openedBook.readingState.rightSidebarOpen;
    setViewerState({
      page: openedBook.readingState.page,
      pages: openedBook.pageCount,
      scale: openedBook.readingState.zoomScale,
      scrollTop: openedBook.readingState.scrollTop,
      zoomMode: openedBook.readingState.zoomMode,
      outline: [],
      findCurrent: 0,
      findTotal: 0,
    });
    setLeftOpen(openedBook.readingState.leftSidebarOpen);
    setRightOpen(openedBook.readingState.rightSidebarOpen);
    setBook(openedBook);
    setViewerError("");
    setLibraryError("");
    setUnavailableBookId(undefined);
    resetConversationState();
    void refreshConversation(openedBook.id);
    setPanMode(false);
    setPassage(undefined);
    setAttachedPassage(undefined);
    setSelectionFeedback(undefined);
  }, [refreshConversation, resetConversationState]);

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

  useEffect(() => () => stateWriterRef.current?.flush(), []);

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

  const showLibrary = useCallback(() => {
    stateWriterRef.current?.flush();
    setBook(undefined);
    setViewerError("");
    setPassage(undefined);
    setLibraryError("");
    setUnavailableBookId(undefined);
    setLibraryLoading(true);
    resetConversationState();
    void refreshLibrary();
  }, [refreshLibrary, resetConversationState]);

  const handleViewerState = useCallback((state: ViewerState) => {
    setViewerState(state);
    if (!book) return;
    const readingState: ReadingState = {
      page: state.page,
      scrollTop: state.scrollTop,
      zoomMode: state.zoomMode,
      zoomScale: state.scale,
      leftSidebarOpen: leftOpenRef.current,
      rightSidebarOpen: rightOpenRef.current,
    };
    readingStateRef.current = readingState;
    stateWriterRef.current?.schedule({ bookId: book.id, state: readingState });
  }, [book]);

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

  useEffect(() => {
    leftOpenRef.current = leftOpen;
    rightOpenRef.current = rightOpen;
    if (!book) return;
    readingStateRef.current = {
      ...readingStateRef.current,
      leftSidebarOpen: leftOpen,
      rightSidebarOpen: rightOpen,
    };
    stateWriterRef.current?.schedule({ bookId: book.id, state: readingStateRef.current });
  }, [book, leftOpen, rightOpen]);

  // Agent 事件订阅：流式增量、消息终态与会话收尾都由 Main 推送。
  useEffect(() => {
    if (!window.pdfMuse) return;
    return window.pdfMuse.onAgentEvent((event) => {
      const active = activeRunRef.current;
      if (active && event.runId === active.runId) {
        if (event.stream === "assistant") {
          activeRunRef.current = { ...active, body: active.body + event.delta };
          setStreamingReply(activeRunRef.current);
        } else if (event.stream === "lifecycle" && (event.phase === "end" || event.phase === "cancelled" || event.phase === "error")) {
          activeRunRef.current = undefined;
          setStreamingReply(undefined);
          if (book) void refreshConversation(book.id);
        }
      }
    });
  }, [book, refreshConversation]);

  const askAgent = useCallback(async (question: string, passage?: SelectedPassage) => {
    if (!book || !window.pdfMuse || activeRunRef.current) return;
    setAgentNotice("");
    try {
      const result = await window.pdfMuse.startAgentRun({
        bookId: book.id,
        question,
        focus: {
          currentPage: viewerState.page,
          ...(passage ? { selectedPassage: passage } : {}),
        },
      });
      if (!result.ok) {
        setAgentNotice(result.message);
        return;
      }
      // Reader 问题立即上屏；终态时 refreshConversation 会以持久化数据替换。
      setConversation((current) => [
        ...current,
        {
          id: `pending-${result.runId}`,
          sessionId: result.sessionId,
          runId: result.runId,
          role: "reader",
          body: question,
          status: "complete",
          ...(passage ? { passage: { page: passage.page, text: passage.text, rects: passage.rects } } : {}),
          createdAt: new Date().toISOString(),
        },
      ]);
      activeRunRef.current = { runId: result.runId, sessionId: result.sessionId, body: "" };
      setStreamingReply(activeRunRef.current);
    } catch {
      setAgentNotice("无法发起回答，请重试。");
    }
  }, [book, viewerState.page]);

  const stopAgent = useCallback(async () => {
    const active = activeRunRef.current;
    if (!active || !window.pdfMuse) return;
    try {
      await window.pdfMuse.cancelAgentRun(active.runId);
    } catch {
      // 取消失败时等待运行自然结束。
    }
  }, []);

  const explain = useCallback((selectedPassage: SelectedPassage) => {
    setRightOpen(true);
    setPassage(undefined);
    window.getSelection()?.removeAllRanges();
    void askAgent("请解释这段内容。", selectedPassage);
  }, [askAgent]);

  const askAboutPassage = useCallback((selectedPassage: SelectedPassage) => {
    setAttachedPassage(selectedPassage);
    setRightOpen(true);
    setPassage(undefined);
    window.getSelection()?.removeAllRanges();
    requestAnimationFrame(() => composerRef.current?.focus());
  }, []);

  const copyPassage = useCallback(async (selectedPassage: SelectedPassage) => {
    setPassage(undefined);
    window.getSelection()?.removeAllRanges();
    try {
      await navigator.clipboard.writeText(selectedPassage.text);
      setSelectionFeedback({ message: "已复制选中原文。", tone: "success" });
    } catch {
      setSelectionFeedback({ message: "复制失败，请检查系统剪贴板权限后重试。", tone: "error" });
    }
  }, []);

  const retryRun = useCallback((message: ConversationMessage) => {
    if (!book) return;
    const readerQuestion = conversation
      .slice(0, conversation.findIndex((item) => item.id === message.id))
      .reverse()
      .find((item) => item.role === "reader" && item.runId === message.runId);
    if (!readerQuestion) return;
    // 重试沿用原 Selected Passage 的完整 Evidence 坐标。
    const passage = readerQuestion.passage
      ? { bookId: book.id, page: readerQuestion.passage.page, text: readerQuestion.passage.text, rects: readerQuestion.passage.rects }
      : undefined;
    void askAgent(readerQuestion.body, passage);
  }, [askAgent, book, conversation]);

  const sendDraft = useCallback(() => {
    const question = draft.trim();
    if (!question || activeRunRef.current) return;
    const passage = attachedPassage;
    setDraft("");
    setAttachedPassage(undefined);
    void askAgent(question, passage);
  }, [askAgent, attachedPassage, draft]);

  const passageByRun = useMemo(() => {
    const map = new Map<string, { page: number; text: string }>();
    for (const message of conversation) {
      if (message.role === "reader" && message.passage) map.set(message.runId, message.passage);
    }
    return map;
  }, [conversation]);

  // 流式输出期间保持对话底部可见。
  useEffect(() => {
    const container = conversationRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, [conversation, streamingReply]);

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
    return <><LibraryView books={libraryBooks} error={libraryError} loading={libraryLoading} unavailableBookId={unavailableBookId} warnings={preflight.warnings} onChoose={openBook} onDropFile={openDroppedBook} onOpenBook={openLibraryBook} onRelocate={relocateLibraryBook} /><PasswordDialog request={passwordRequest} onCancel={() => setPasswordRequest(undefined)} onUnlock={unlockPdf} /></>;
  }

  return (
    <Tooltip.Provider>
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
            <SettingsDialog warnings={preflight.warnings} />
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
                <OutlinePanel nodes={viewerState.outline} page={viewerState.page} onGoToPage={(page) => viewerRef.current?.goToPage(page)} />
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
          </div>
          {findOpen && (
            <form className="find-bar" onSubmit={(event) => { event.preventDefault(); viewerRef.current?.find(findQuery); }}>
              <Search size={15} />
              <input autoFocus value={findQuery} onChange={(event) => setFindQuery(event.target.value)} placeholder="查找文字" />
              <span className="find-count">{viewerState.findTotal > 0 ? `${viewerState.findCurrent} / ${viewerState.findTotal}` : "0 / 0"}</span>
              <IconButton type="button" label="上一个结果" onClick={() => viewerRef.current?.find(findQuery, true)}><ChevronLeft /></IconButton>
              <IconButton type="submit" label="下一个结果"><ChevronRight /></IconButton>
              <IconButton type="button" label="关闭查找" onClick={() => { viewerRef.current?.find(""); setFindQuery(""); setFindOpen(false); }}><X /></IconButton>
            </form>
          )}
          {viewerError ? <div className="viewer-error"><strong>无法打开 PDF 书籍</strong><span>{viewerError}</span></div> : <PdfViewer ref={viewerRef} book={book} panMode={panMode} onStateChange={handleViewerState} onSelectionChange={handleViewerSelection} onError={setViewerError} />}
        </main>

        {rightOpen && (
          <aside className="assistant-panel">
            <div className="sidebar-resize-handle right" role="separator" aria-label="调整右侧栏宽度" aria-orientation="vertical" onPointerDown={(event) => beginSidebarResize("right", event)} />
            <header className="assistant-header"><div><span className="assistant-title"><Sparkles size={16} />AI 助手</span><span className="assistant-context">本书对话 · 当前 PDF 书籍</span></div></header>
            <div className="conversation" ref={conversationRef}>
              {conversation.length === 0 && !streamingReply && !conversationLoading ? (
                <div className="conversation-empty"><Bot size={24} /><strong>从原文开始</strong><span>选中文字后解释，或直接询问这本 PDF 书籍。</span></div>
              ) : (
                <>
                  {conversationLoading && conversation.length === 0 && <div className="conversation-loading">正在读取对话...</div>}
                  {conversation.map((message) => (
                    <article className={`message ${message.role}`} key={message.id}>
                      <div className="message-role">{message.role === "reader" ? "你" : "PDFMuse"}</div>
                      {message.role === "reader" ? (
                        <>
                          <p>{message.body}</p>
                          {message.passage && <div className="passage-quote">引用原文 · 第 {message.passage.page} 页</div>}
                        </>
                      ) : (
                        <>
                          {message.body ? <MarkdownView markdown={message.body} /> : null}
                          {message.status === "error" && (
                            <div className="message-failure" role="alert">
                              <span>{message.errorMessage ?? "回答生成失败。"}</span>
                              <button className="secondary-command retry-command" onClick={() => retryRun(message)}><RefreshCw size={12} />重试</button>
                            </div>
                          )}
                          {message.status === "cancelled" && message.body && <div className="message-interrupted">回答已停止，以上为已生成内容。</div>}
                          {passageByRun.get(message.runId) && (
                            <button className="evidence-tag" onClick={() => viewerRef.current?.goToPage(passageByRun.get(message.runId)!.page)}>参考：PDF 第 {passageByRun.get(message.runId)!.page} 页</button>
                          )}
                        </>
                      )}
                    </article>
                  ))}
                  {streamingReply && (
                    <article className="message assistant streaming">
                      <div className="message-role">PDFMuse</div>
                      {streamingReply.body ? <MarkdownView markdown={streamingReply.body} /> : <div className="streaming-hint"><Loader2 size={13} className="spin" />正在生成回答...</div>}
                      {streamingReply.body && <span className="streaming-cursor" aria-hidden />}
                    </article>
                  )}
                </>
              )}
            </div>
            {agentNotice && (
              <div className="agent-notice" role="alert">
                <span>{agentNotice}</span>
                <button aria-label="关闭提示" onClick={() => setAgentNotice("")}><X size={13} /></button>
              </div>
            )}
            <div className="composer-wrap">
              {attachedPassage && <div className="passage-chip"><span>已选原文 · 第 {attachedPassage.page} 页</span><p>{attachedPassage.text}</p><button aria-label="移除已选原文" onClick={() => setAttachedPassage(undefined)}><X size={14} /></button></div>}
              <div className="composer">
                <textarea ref={composerRef} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendDraft(); } }} placeholder="询问这本 PDF 书籍..." rows={2} />
                {streamingReply
                  ? <button className="send-button stop" aria-label="停止回答" onClick={() => void stopAgent()}><Square size={14} /></button>
                  : <button className="send-button" aria-label="发送问题" disabled={!draft.trim()} onClick={sendDraft}><Send size={17} /></button>}
              </div>
            </div>
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
      </div>
    </Tooltip.Provider>
  );
}
