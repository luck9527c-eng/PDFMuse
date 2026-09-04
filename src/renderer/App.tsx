import * as Tooltip from "@radix-ui/react-tooltip";
import * as Dialog from "@radix-ui/react-dialog";
import {
  BookOpen,
  Bot,
  Check,
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
  Loader2,
  LockKeyhole,
  MessageSquareText,
  Minus,
  Pause,
  PanelLeftClose,
  PanelRightClose,
  Play,
  Plus,
  RefreshCw,
  Search,
  ScanText,
  Send,
  Sparkles,
  Square,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import type {
  AgentStreamEvent,
  AgentImageAttachment,
  BackgroundJob,
  BookMemory,
  OcrPageResult,
  RecognizedPageText,
  MemoryProposal,
  MemoryAuditEntry,
  ConversationMessage,
  LibraryBook,
  OpenedPdfBook,
  OpenPdfBookResult,
  ReadingState,
  SelectedPassage,
  StartupPreflight,
} from "../shared/contracts";
import { MAX_AGENT_IMAGE_ATTACHMENTS, MAX_AGENT_IMAGE_BYTES } from "../shared/contracts";
import { IconButton } from "./components/IconButton";
import { MarkdownView } from "./components/MarkdownView";
import { SettingsDialog } from "./components/SettingsDialog";
import { PdfViewer, type OutlineNode, type PdfViewerHandle, type ViewerSelection, type ViewerState } from "./pdf/PdfViewer";
import { createReadingStateWriter } from "./reading-state-persistence";

type PassagePopover = Extract<ViewerSelection, { kind: "selected" }>;
type StreamingReply = { runId: string; sessionId: string; body: string };
type ComposerSubmission = { runId: string; question: string; passage?: SelectedPassage; attachments: AgentImageAttachment[] };
type PendingApproval = { approvalId: string; runId: string; toolName?: string };

const TOOL_TITLES: Record<string, string> = {
  book_search: "检索本书",
};

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

function OutlinePanel({ nodes, page, emptyMessage, onGoToPage }: { nodes: OutlineNode[]; page: number; emptyMessage: string; onGoToPage(page: number): void }) {
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

  if (nodes.length === 0) return <p className="outline-empty">{emptyMessage}</p>;

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
  const [attachments, setAttachments] = useState<AgentImageAttachment[]>([]);
  const [conversation, setConversation] = useState<ConversationMessage[]>([]);
  const [memoryProposals, setMemoryProposals] = useState<MemoryProposal[]>([]);
  const [bookMemories, setBookMemories] = useState<BookMemory[]>([]);
  const [recognizedPage, setRecognizedPage] = useState<RecognizedPageText>();
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrNotice, setOcrNotice] = useState("");
  const [backgroundJobs, setBackgroundJobs] = useState<BackgroundJob[]>([]);
  const [generatedOutline, setGeneratedOutline] = useState<OutlineNode[]>();
  const [memoryAudit, setMemoryAudit] = useState<MemoryAuditEntry[]>([]);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval>();
  const [streamingReply, setStreamingReply] = useState<StreamingReply>();
  const [toolStatus, setToolStatus] = useState<string>();
  const [agentNotice, setAgentNotice] = useState("");
  const [conversationLoading, setConversationLoading] = useState(false);
  const conversationRef = useRef<HTMLDivElement>(null);
  const activeRunRef = useRef<StreamingReply | undefined>(undefined);
  const pendingComposerRef = useRef<ComposerSubmission | undefined>(undefined);
  const draftRef = useRef(draft);
  const passageRef = useRef(attachedPassage);
  const attachmentsRef = useRef(attachments);
  draftRef.current = draft;
  passageRef.current = attachedPassage;
  attachmentsRef.current = attachments;

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

  const refreshMemoryProposals = useCallback(async (bookId: string) => {
    if (!window.pdfMuse) return;
    try {
      const proposals = await window.pdfMuse.listMemoryProposals(bookId);
      setMemoryProposals(proposals.filter((proposal) => proposal.status === "pending"));
      setBookMemories(await window.pdfMuse.listBookMemories(bookId));
      setMemoryAudit(await window.pdfMuse.listMemoryAudit(bookId));
    } catch {
      setAgentNotice("无法读取待确认的本书记忆。");
    }
  }, []);

  const refreshBackgroundJobs = useCallback(async (bookId: string) => {
    if (!window.pdfMuse) return;
    try {
      const [jobs, outline] = await Promise.all([
        window.pdfMuse.listBackgroundJobs(bookId),
        window.pdfMuse.getBookOutline(bookId),
      ]);
      setBackgroundJobs(jobs);
      setGeneratedOutline(outline);
    } catch {
      setBackgroundJobs([]);
    }
  }, []);

  const resetConversationState = useCallback(() => {
    setConversation([]);
    setMemoryProposals([]);
    setBookMemories([]);
    setMemoryAudit([]);
    setRecognizedPage(undefined);
    setOcrNotice("");
    setBackgroundJobs([]);
    setGeneratedOutline(undefined);
    setPendingApproval(undefined);
    setStreamingReply(undefined);
    setToolStatus(undefined);
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
    void refreshMemoryProposals(openedBook.id);
    const pdfMuseApi = window.pdfMuse;
    if (pdfMuseApi) {
      void (async () => {
        await pdfMuseApi.scheduleBackgroundJob({ bookId: openedBook.id, kind: "index", priority: 10, total: openedBook.pageCount });
        await pdfMuseApi.scheduleBackgroundJob({ bookId: openedBook.id, kind: "outline", priority: 5, total: openedBook.pageCount });
        const embedding = await pdfMuseApi.getEmbeddingConnection();
        if (embedding.baseUrl && embedding.model) {
          await pdfMuseApi.scheduleBackgroundJob({ bookId: openedBook.id, kind: "embedding", priority: 0, total: openedBook.pageCount });
        }
        await refreshBackgroundJobs(openedBook.id);
      })().catch(() => undefined);
    }
    setPanMode(false);
    setPassage(undefined);
    setAttachedPassage(undefined);
    setAttachments([]);
    setSelectionFeedback(undefined);
  }, [refreshBackgroundJobs, refreshConversation, refreshMemoryProposals, resetConversationState]);

  useEffect(() => {
    if (!book || !window.pdfMuse) return;
    void refreshBackgroundJobs(book.id);
    const timer = window.setInterval(() => void refreshBackgroundJobs(book.id), 1_500);
    return () => window.clearInterval(timer);
  }, [book, refreshBackgroundJobs]);

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
    await refreshBackgroundJobs(book.id);
  }, [book, refreshBackgroundJobs, visibleBackgroundJob]);

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

  const recognizeCurrentPage = useCallback(async () => {
    if (!book || !window.pdfMuse || ocrLoading) return;
    setOcrLoading(true);
    setOcrNotice("");
    try {
      const image = await viewerRef.current?.getPageImage(viewerState.page, 1.5);
      if (!image) {
        setOcrNotice("当前页面尚未准备好，请稍后重试。");
        return;
      }
      const result: OcrPageResult = await window.pdfMuse.recognizePage({
        bookId: book.id,
        page: viewerState.page,
        imageData: image.data,
        width: image.width,
        height: image.height,
      });
      if (result.ok) setRecognizedPage(result.page);
      else setOcrNotice(result.message);
    } catch {
      setOcrNotice("当前页识别失败，请稍后重试。");
    } finally {
      setOcrLoading(false);
    }
  }, [book, ocrLoading, viewerState.page]);

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

  useEffect(() => {
    if (!book || !window.pdfMuse) {
      setRecognizedPage(undefined);
      return;
    }
    let disposed = false;
    void window.pdfMuse.getRecognizedPage(book.id, viewerState.page).then((page) => {
      if (!disposed) setRecognizedPage(page);
    });
    return () => { disposed = true; };
  }, [book, viewerState.page]);

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

  // Agent 事件订阅：流式增量、工具状态、消息终态与会话收尾都由 Main 推送。
  useEffect(() => {
    if (!window.pdfMuse) return;
    return window.pdfMuse.onAgentEvent((event) => {
      const active = activeRunRef.current;
      if (active && event.runId === active.runId) {
        if (event.stream === "assistant") {
          activeRunRef.current = { ...active, body: active.body + event.delta };
          setStreamingReply(activeRunRef.current);
        } else if (event.stream === "tool") {
          const title = TOOL_TITLES[event.name] ?? event.name;
          setToolStatus(event.phase === "end" ? `${title}完成` : `${title}中...`);
        } else if (event.stream === "lifecycle" && event.phase === "waiting-approval" && event.approvalId) {
          setPendingApproval({ approvalId: event.approvalId, runId: event.runId, toolName: event.toolName });
        } else if (event.stream === "lifecycle" && (event.phase === "end" || event.phase === "cancelled" || event.phase === "error")) {
          const submission = pendingComposerRef.current;
          if (submission?.runId === event.runId) {
            if (event.phase === "end"
              && draftRef.current === submission.question
              && passageRef.current === submission.passage
              && attachmentsRef.current.length === submission.attachments.length
              && attachmentsRef.current.every((item, index) => item.id === submission.attachments[index]?.id)) {
              setDraft("");
              setAttachedPassage(undefined);
              setAttachments([]);
            }
            pendingComposerRef.current = undefined;
          }
          activeRunRef.current = undefined;
          setPendingApproval(undefined);
          setStreamingReply(undefined);
          setToolStatus(undefined);
          if (book) void refreshConversation(book.id);
          if (book) void refreshMemoryProposals(book.id);
        }
      }
    });
  }, [book, refreshConversation, refreshMemoryProposals]);

  const askAgent = useCallback(async (question: string, passage?: SelectedPassage, imageAttachments: AgentImageAttachment[] = []) => {
    if (!book || !window.pdfMuse || activeRunRef.current) return undefined;
    setAgentNotice("");
    try {
      const result = await window.pdfMuse.startAgentRun({
        bookId: book.id,
        question,
        focus: {
          currentPage: viewerState.page,
          ...(passage ? { selectedPassage: passage } : {}),
        },
        ...(imageAttachments.length > 0 ? { attachments: imageAttachments } : {}),
      });
      if (!result.ok) {
        setAgentNotice(result.message);
        return undefined;
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
      return result;
    } catch {
      setAgentNotice("无法发起回答，请重试。");
      return undefined;
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

  const resolveAgentApproval = useCallback(async (approved: boolean) => {
    if (!window.pdfMuse || !pendingApproval) return;
    const result = await window.pdfMuse.approveAgentTool({ approvalId: pendingApproval.approvalId, approved });
    if (!result.ok) setAgentNotice(result.message);
    setPendingApproval(undefined);
  }, [pendingApproval]);

  const reviewMemoryProposal = useCallback(async (proposalId: string, action: "approve" | "reject") => {
    if (!window.pdfMuse || !book) return;
    try {
      const result = await window.pdfMuse.reviewMemoryProposal({ bookId: book.id, proposalId, action });
      if (!result.ok) {
        setAgentNotice(result.message);
        return;
      }
      await refreshMemoryProposals(book.id);
    } catch {
      setAgentNotice("无法更新本书记忆，请重试。");
    }
  }, [book, refreshMemoryProposals]);

  const revokeBookMemory = useCallback(async (memoryId: string) => {
    if (!window.pdfMuse || !book) return;
    try {
      const result = await window.pdfMuse.revokeBookMemory({ bookId: book.id, memoryId });
      if (!result.ok) {
        setAgentNotice(result.message);
        return;
      }
      await refreshMemoryProposals(book.id);
    } catch {
      setAgentNotice("无法撤销本书记忆，请重试。");
    }
  }, [book, refreshMemoryProposals]);

  const explain = useCallback((selectedPassage: SelectedPassage) => {
    setRightOpen(true);
    setPassage(undefined);
    void askAgent("请解释这段内容。", selectedPassage);
  }, [askAgent]);

  const askAboutPassage = useCallback((selectedPassage: SelectedPassage) => {
    setAttachedPassage(selectedPassage);
    setRightOpen(true);
    setPassage(undefined);
    requestAnimationFrame(() => composerRef.current?.focus());
  }, []);

  const copyPassage = useCallback(async (selectedPassage: SelectedPassage) => {
    setPassage(undefined);
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

  const addClipboardImages = useCallback(async (items: DataTransferItem[]) => {
    const remaining = MAX_AGENT_IMAGE_ATTACHMENTS - attachmentsRef.current.length;
    if (remaining <= 0) {
      setAgentNotice(`最多添加 ${MAX_AGENT_IMAGE_ATTACHMENTS} 张截图。`);
      return;
    }
    const files = items.slice(0, remaining).map((item) => item.getAsFile()).filter((file): file is File => Boolean(file));
    if (files.length < items.slice(0, remaining).length) {
      setAgentNotice("无法读取剪贴板截图，请重试。");
      return;
    }
    const accepted: AgentImageAttachment[] = [];
    for (const file of files) {
      const mimeType = file.type.toLowerCase();
      if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mimeType)) {
        setAgentNotice("仅支持 PNG、JPEG、WEBP 或 GIF 截图。");
        continue;
      }
      if (file.size > MAX_AGENT_IMAGE_BYTES) {
        setAgentNotice("单张截图不能超过 8 MB。");
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
        setAgentNotice("读取截图失败，请重试。");
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
      setAgentNotice("");
    }
    if (items.length > remaining) setAgentNotice(`最多添加 ${MAX_AGENT_IMAGE_ATTACHMENTS} 张截图，超出的图片未添加。`);
  }, []);

  const handleComposerPaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imageItems = Array.from(event.clipboardData.items).filter((item) => item.kind === "file" && item.type.toLowerCase().startsWith("image/"));
    if (imageItems.length === 0) return;
    event.preventDefault();
    void addClipboardImages(imageItems);
  }, [addClipboardImages]);

  const sendDraft = useCallback(async () => {
    const question = draft.trim();
    if (!question || activeRunRef.current) return;
    const passage = attachedPassage;
    const imageAttachments = attachments;
    const result = await askAgent(question, passage, imageAttachments);
    if (result?.ok) {
      pendingComposerRef.current = { runId: result.runId, question, passage, attachments: imageAttachments };
    }
  }, [askAgent, attachedPassage, attachments, draft]);

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
                {visibleBackgroundJob.status === "paused" && (
                  <IconButton label="继续后台任务" onClick={() => void mutateBackgroundJob("resume")}><Play /></IconButton>
                )}
                {(visibleBackgroundJob.status === "running" || visibleBackgroundJob.status === "queued" || visibleBackgroundJob.status === "paused") && (
                  <IconButton label="取消后台任务" onClick={() => void mutateBackgroundJob("cancel")}><X /></IconButton>
                )}
            </div>
          )}
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
          {ocrNotice && <div className="reader-notice" role="status"><span>{ocrNotice}</span><button aria-label="关闭识别提示" onClick={() => setOcrNotice("")}><X size={14} /></button></div>}
          {viewerError ? <div className="viewer-error"><strong>无法打开 PDF 书籍</strong><span>{viewerError}</span></div> : <PdfViewer ref={viewerRef} book={book} panMode={panMode} recognizedPage={recognizedPage} onStateChange={handleViewerState} onSelectionChange={handleViewerSelection} onError={setViewerError} />}
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
                          {message.evidence && message.evidence.length > 0 && (
                            <div className="evidence-tags">
                              {[...new Set(message.evidence.map((item) => item.page))].map((page) => (
                                <button
                                  className="evidence-tag"
                                  key={page}
                                  title={message.evidence!.find((item) => item.page === page)?.snippet}
                                  onClick={() => viewerRef.current?.goToPage(page)}
                                >
                                  本书第 {page} 页
                                </button>
                              ))}
                            </div>
                          )}
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
                      {toolStatus && <div className="tool-status" role="status"><Search size={12} className="spin" />{toolStatus}</div>}
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
              {pendingApproval && (
                <section className="memory-proposals approval-request" aria-label="等待确认">
                  <div className="memory-proposals-title">智能体请求保存一条本书记忆</div>
                  <p>确认后会创建待审核候选，仍需在下方再次审核后才会进入本书记忆。</p>
                  <div className="memory-proposal-actions">
                    <button aria-label="允许智能体提议记忆" title="允许" onClick={() => void resolveAgentApproval(true)}><Check size={13} />允许</button>
                    <button aria-label="拒绝智能体提议记忆" title="拒绝" onClick={() => void resolveAgentApproval(false)}><X size={13} />拒绝</button>
                  </div>
                </section>
              )}
              {memoryProposals.length > 0 && (
                <section className="memory-proposals" aria-label="待确认的本书记忆">
                  <div className="memory-proposals-title">待确认的本书记忆</div>
                  {memoryProposals.map((proposal) => (
                    <article className="memory-proposal" key={proposal.id}>
                      <p title={proposal.content}>{proposal.content}</p>
                      <small>{proposal.source === "pdf" ? "PDF 原文" : proposal.source === "conversation" ? "较早对话" : proposal.source === "summary" ? "会话摘要" : "网页资料"} · 待核实</small>
                      <div className="memory-proposal-actions">
                        <button aria-label="确认记忆" title="确认记忆" onClick={() => void reviewMemoryProposal(proposal.id, "approve")}><Check size={13} />确认</button>
                        <button aria-label="拒绝记忆" title="拒绝记忆" onClick={() => void reviewMemoryProposal(proposal.id, "reject")}><X size={13} />拒绝</button>
                      </div>
                    </article>
                  ))}
                </section>
              )}
              {bookMemories.length > 0 && (
                <section className="book-memories" aria-label="本书记忆">
                  <div className="memory-proposals-title">本书记忆</div>
                  {bookMemories.map((memory) => (
                    <article className="book-memory" key={memory.id}>
                      <p title={memory.content}>{memory.content}</p>
                      <small>{memory.source === "pdf" ? "PDF 原文" : memory.source === "conversation" ? "较早对话" : memory.source === "summary" ? "会话摘要" : "网页资料"} · {memory.trust === "trusted" ? "已确认" : "待核实"}</small>
                      <button aria-label="撤销本条记忆" title="撤销本条记忆" onClick={() => void revokeBookMemory(memory.id)}><X size={12} />撤销</button>
                    </article>
                  ))}
                </section>
              )}
              {memoryAudit.length > 0 && (
                <details className="memory-audit">
                  <summary>记忆变更记录</summary>
                  {memoryAudit.slice(0, 8).map((entry) => (
                    <div className="memory-audit-row" key={entry.id}>
                      <span>{entry.action === "proposal_created" ? "创建候选" : entry.action === "proposal_approved" ? "确认记忆" : entry.action === "proposal_rejected" ? "拒绝候选" : entry.action === "memory_revoked" ? "撤销记忆" : entry.action}</span>
                      <time>{new Date(entry.createdAt).toLocaleString("zh-CN")}</time>
                    </div>
                  ))}
                </details>
              )}
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
                {streamingReply
                  ? <button className="send-button stop" aria-label="停止回答" onClick={() => void stopAgent()}><Square size={14} /></button>
                  : <button className="send-button" aria-label="发送问题" disabled={!draft.trim()} onClick={() => void sendDraft()}><Send size={17} /></button>}
              </div>
              <div className="composer-meta" title={`粘贴截图，最多 ${MAX_AGENT_IMAGE_ATTACHMENTS} 张`} aria-label={`截图附件 ${attachments.length}/${MAX_AGENT_IMAGE_ATTACHMENTS}`}><ImagePlus size={12} />{attachments.length > 0 && <span>{attachments.length}/{MAX_AGENT_IMAGE_ATTACHMENTS}</span>}</div>
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
