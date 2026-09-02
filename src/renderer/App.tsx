import * as Tooltip from "@radix-ui/react-tooltip";
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
  Library,
  MessageSquareText,
  Minus,
  PanelLeftClose,
  PanelRightClose,
  Plus,
  Search,
  Send,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  LibraryBook,
  OpenedPdfBook,
  OpenPdfBookResult,
  ReadingState,
  StartupPreflight,
} from "../shared/contracts";
import { IconButton } from "./components/IconButton";
import { SettingsDialog } from "./components/SettingsDialog";
import { PdfViewer, type OutlineNode, type PdfViewerHandle, type ViewerState } from "./pdf/PdfViewer";
import { createReadingStateWriter } from "./reading-state-persistence";

type Passage = { text: string; x: number; y: number };
type Message = { role: "reader" | "assistant"; body: string };

const browserPreflight: StartupPreflight = {
  ok: true,
  dataHome: "浏览器预览模式",
  warnings: ["桌面文件访问仅在 Electron 中启用。"],
};

function OutlineTree({ nodes, onGoToPage }: { nodes: OutlineNode[]; onGoToPage(page: number): void }) {
  if (nodes.length === 0) {
    return <p className="outline-empty">此 PDF 书籍没有内置目录。后续 OCR 阶段将补全章节。</p>;
  }

  return (
    <div className="outline-tree">
      {nodes.map((node) => (
        <div className="outline-group" key={node.id}>
          <button className="outline-item" disabled={!node.page} onClick={() => node.page && onGoToPage(node.page)}>
            <span>{node.label}</span>
            {node.page && <span className="outline-page">{node.page}</span>}
          </button>
          {node.children.length > 0 && <OutlineTree nodes={node.children} onGoToPage={onGoToPage} />}
        </div>
      ))}
    </div>
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
  });
  const [viewerError, setViewerError] = useState("");
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [passage, setPassage] = useState<Passage>();
  const [draft, setDraft] = useState("");
  const [attachedPassage, setAttachedPassage] = useState<string>();
  const [messages, setMessages] = useState<Message[]>([]);

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
    const handleSelection = () => {
      const selection = window.getSelection();
      const text = selection?.toString().trim();
      if (!selection || !text || selection.rangeCount === 0) {
        setPassage(undefined);
        return;
      }
      const anchor = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement;
      if (!anchor?.closest(".pdfViewer")) return;
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      setPassage({ text, x: rect.left + rect.width / 2, y: rect.top });
    };
    document.addEventListener("mouseup", handleSelection);
    return () => document.removeEventListener("mouseup", handleSelection);
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
    });
    setLeftOpen(openedBook.readingState.leftSidebarOpen);
    setRightOpen(openedBook.readingState.rightSidebarOpen);
    setBook(openedBook);
    setViewerError("");
    setLibraryError("");
    setUnavailableBookId(undefined);
    setMessages([]);
  }, []);

  const handleOpenResult = useCallback((result: OpenPdfBookResult, attemptedBookId?: string) => {
    if (result.ok) activateBook(result.book);
    else {
      setLibraryError(result.message);
      const canRelocate = result.code === "FILE_UNAVAILABLE" || result.code === "CONTENT_CHANGED";
      setUnavailableBookId(canRelocate ? result.bookId ?? attemptedBookId : undefined);
    }
  }, [activateBook]);

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
    void refreshLibrary();
  }, [refreshLibrary]);

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

  const explain = useCallback((text: string) => {
    setAttachedPassage(text);
    setMessages([
      { role: "reader", body: "请解释这段内容。" },
      { role: "assistant", body: "已选原文已进入阅读上下文。真实回答将在后续任务中接入；当前不会生成虚构答案。" },
    ]);
    setRightOpen(true);
    setPassage(undefined);
    window.getSelection()?.removeAllRanges();
  }, []);

  const askAboutPassage = useCallback((text: string) => {
    setAttachedPassage(text);
    setRightOpen(true);
    setPassage(undefined);
    window.getSelection()?.removeAllRanges();
    requestAnimationFrame(() => composerRef.current?.focus());
  }, []);

  const sendDraft = useCallback(() => {
    const question = draft.trim();
    if (!question) return;
    setMessages((current) => [
      ...current,
      { role: "reader", body: question },
      { role: "assistant", body: "问题草稿和阅读焦点已保留。配置对话模型后即可从这里开始流式回答。" },
    ]);
    setDraft("");
  }, [draft]);

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
    return <LibraryView books={libraryBooks} error={libraryError} loading={libraryLoading} unavailableBookId={unavailableBookId} warnings={preflight.warnings} onChoose={openBook} onDropFile={openDroppedBook} onOpenBook={openLibraryBook} onRelocate={relocateLibraryBook} />;
  }

  return (
    <Tooltip.Provider>
      <div className={`workspace ${leftOpen ? "left-open" : ""} ${rightOpen ? "right-open" : ""}`}>
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
            <div className="book-summary">
              <div className="mini-cover">PDF<br />MUSE</div>
              <div><strong>{book.name}</strong><span>第 {viewerState.page} / {viewerState.pages || "-"} 页</span></div>
            </div>
            <div className="sidebar-tabs"><button className="active">目录</button><button disabled>缩略图</button></div>
            <OutlineTree nodes={viewerState.outline} onGoToPage={(page) => viewerRef.current?.goToPage(page)} />
          </aside>
        )}

        <main className="reader">
          {libraryError && (
            <div className="reader-notice" role="alert">
              <span>{libraryError}</span>
              <button aria-label="关闭错误提示" onClick={() => setLibraryError("")}><X size={14} /></button>
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
            <IconButton label="在 PDF 中查找" onClick={() => setFindOpen((value) => !value)}><Search /></IconButton>
          </div>
          {findOpen && (
            <form className="find-bar" onSubmit={(event) => { event.preventDefault(); viewerRef.current?.find(findQuery); }}>
              <Search size={15} />
              <input autoFocus value={findQuery} onChange={(event) => setFindQuery(event.target.value)} placeholder="查找文字" />
              <IconButton type="button" label="上一个结果" onClick={() => viewerRef.current?.find(findQuery, true)}><ChevronLeft /></IconButton>
              <IconButton type="submit" label="下一个结果"><ChevronRight /></IconButton>
              <IconButton type="button" label="关闭查找" onClick={() => { viewerRef.current?.find(""); setFindQuery(""); setFindOpen(false); }}><X /></IconButton>
            </form>
          )}
          {viewerError ? <div className="viewer-error"><strong>无法打开 PDF 书籍</strong><span>{viewerError}</span></div> : <PdfViewer ref={viewerRef} book={book} onStateChange={handleViewerState} onError={setViewerError} />}
        </main>

        {rightOpen && (
          <aside className="assistant-panel">
            <header className="assistant-header"><div><span className="assistant-title"><Sparkles size={16} />AI 助手</span><span className="assistant-context">本书对话 · 当前 PDF 书籍</span></div></header>
            <div className="conversation">
              {messages.length === 0 ? (
                <div className="conversation-empty"><Bot size={24} /><strong>从原文开始</strong><span>选中文字后解释，或直接询问这本 PDF 书籍。</span></div>
              ) : messages.map((message, index) => (
                <article className={`message ${message.role}`} key={`${message.role}-${index}`}>
                  <div className="message-role">{message.role === "reader" ? "你" : "PDFMuse"}</div>
                  <p>{message.body}</p>
                  {message.role === "assistant" && <button className="evidence-tag" onClick={() => viewerRef.current?.goToPage(viewerState.page)}>参考：PDF 第 {viewerState.page} 页</button>}
                </article>
              ))}
            </div>
            <div className="composer-wrap">
              {attachedPassage && <div className="passage-chip"><span>已选原文</span><p>{attachedPassage}</p><button aria-label="移除已选原文" onClick={() => setAttachedPassage(undefined)}><X size={14} /></button></div>}
              <div className="composer">
                <textarea ref={composerRef} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendDraft(); } }} placeholder="询问这本 PDF 书籍..." rows={2} />
                <button className="send-button" aria-label="发送问题" disabled={!draft.trim()} onClick={sendDraft}><Send size={17} /></button>
              </div>
            </div>
          </aside>
        )}

        {passage && (
          <div className="selection-popover" style={{ left: passage.x, top: Math.max(12, passage.y - 48) }}>
            <button onClick={() => explain(passage.text)}><Sparkles size={14} />解释</button>
            <button onClick={() => askAboutPassage(passage.text)}><MessageSquareText size={14} />提问</button>
            <span />
            <button onClick={() => { void navigator.clipboard.writeText(passage.text); setPassage(undefined); }}><Copy size={14} />复制</button>
          </div>
        )}
      </div>
    </Tooltip.Provider>
  );
}
