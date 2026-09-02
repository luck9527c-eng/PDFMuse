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
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { OpenedPdfBook, StartupPreflight } from "../shared/contracts";
import { IconButton } from "./components/IconButton";
import { SettingsDialog } from "./components/SettingsDialog";
import { PdfViewer, type OutlineNode, type PdfViewerHandle, type ViewerState } from "./pdf/PdfViewer";

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

function EmptyLibrary({ onOpen, warnings }: { onOpen(): void; warnings: string[] }) {
  return (
    <Tooltip.Provider>
      <main className="empty-library">
        <div className="empty-brand"><span>PM</span><strong>PDFMuse</strong><div className="empty-brand-actions"><SettingsDialog warnings={warnings} /></div></div>
        <section className="empty-content">
          <div className="empty-icon"><BookOpen size={30} /></div>
          <h1>打开一本 PDF 书籍</h1>
          <p>阅读位置、对话与后续索引都会保存在程序旁的数据目录。</p>
          <button className="primary-command" onClick={onOpen}><FilePlus2 size={17} />选择 PDF</button>
        </section>
        <div className="empty-footer"><Library size={14} /> 打开第一本书后，它会出现在书库中</div>
      </main>
    </Tooltip.Provider>
  );
}

export function App() {
  const viewerRef = useRef<PdfViewerHandle>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [preflight, setPreflight] = useState<StartupPreflight>();
  const [book, setBook] = useState<OpenedPdfBook>();
  const [viewerState, setViewerState] = useState<ViewerState>({ page: 1, pages: 0, scale: 100, outline: [] });
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

  useEffect(() => {
    const demoRequested = import.meta.env.DEV && new URLSearchParams(window.location.search).has("demo");
    if (window.pdfMuse || !demoRequested) return;

    void fetch("/data/qa-sample.pdf")
      .then(async (response) => {
        if (!response.ok) throw new Error(`QA PDF returned ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        setBook({ name: "PDFMuse 界面测试文档", path: "data/qa-sample.pdf", bytes });
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

  const openBook = useCallback(async () => {
    if (!window.pdfMuse) return;
    const selected = await window.pdfMuse.choosePdfBook();
    if (selected) {
      setBook(selected);
      setViewerError("");
      setMessages([]);
    }
  }, []);

  const explain = useCallback((text: string) => {
    setAttachedPassage(text);
    setMessages([
      { role: "reader", body: "请解释这段内容。" },
      { role: "assistant", body: "已选原文已进入阅读上下文。模型连接将在阶段 2 接入；当前不会生成虚构答案。" },
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
  if (!book) return <EmptyLibrary onOpen={openBook} warnings={preflight.warnings} />;

  return (
    <Tooltip.Provider>
      <div className={`workspace ${leftOpen ? "left-open" : ""} ${rightOpen ? "right-open" : ""}`}>
        <header className="topbar">
          <div className="brand"><span className="brand-mark">PM</span><strong>PDFMuse</strong></div>
          <div className="document-bar">
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
          {viewerError ? <div className="viewer-error"><strong>无法打开 PDF 书籍</strong><span>{viewerError}</span></div> : <PdfViewer ref={viewerRef} book={book} onStateChange={setViewerState} onError={setViewerError} />}
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
