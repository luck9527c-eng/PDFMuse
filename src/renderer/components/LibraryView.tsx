import * as Tooltip from "@radix-ui/react-tooltip";
import * as Dialog from "@radix-ui/react-dialog";
import {
  BookMinus,
  BookOpen,
  EllipsisVertical,
  FilePlus2,
  Trash2,
  Upload,
} from "lucide-react";
import { useState, type DragEvent } from "react";

import type { AppearanceSettings, LibraryBook } from "../../shared/contracts";
import { IconButton } from "./IconButton";
import { SettingsDialog } from "./SettingsDialog";

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
  appearance: AppearanceSettings;
  onAppearancePreview(settings: AppearanceSettings): void;
  onAppearanceSaved(settings: AppearanceSettings): void;
  onChoose(): Promise<void>;
  onDropFile(file?: File): Promise<void>;
  onOpenBook(bookId: string): Promise<void>;
  onRelocate(bookId: string): Promise<void>;
  onRemove(bookId: string): Promise<void>;
  onDeleteData(bookId: string): Promise<void>;
};

export function LibraryView({
  books,
  error,
  loading,
  unavailableBookId,
  warnings,
  appearance,
  onAppearancePreview,
  onAppearanceSaved,
  onChoose,
  onDropFile,
  onOpenBook,
  onRelocate,
  onRemove,
  onDeleteData,
}: LibraryViewProps) {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [managedBook, setManagedBook] = useState<LibraryBook>();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length !== 1) return void run(() => onDropFile());
    void run(() => onDropFile(files[0]!));
  };

  const closeBookManager = () => {
    setManagedBook(undefined);
    setConfirmDelete(false);
  };

  const runBookMutation = async (action: () => Promise<void>) => {
    await run(action);
    closeBookManager();
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
          <SettingsDialog warnings={warnings} appearance={appearance} onAppearancePreview={onAppearancePreview} onAppearanceSaved={onAppearanceSaved} />
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
                <div
                  className="library-book"
                  key={item.id}
                >
                  <button
                    className="library-book-open"
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
                  <IconButton
                    label={`管理《${item.title}》`}
                    disabled={busy}
                    onClick={() => { setManagedBook(item); setConfirmDelete(false); }}
                  ><EllipsisVertical /></IconButton>
                </div>
              ))}
            </div>
          )}

          <div className="library-drop-hint"><Upload size={15} />也可以将一个 PDF 文件拖到窗口中</div>
        </section>
        {dragging && <div className="drop-overlay"><Upload size={30} /><strong>松开以加入书库</strong><span>仅接受一个 PDF 文件</span></div>}
        <Dialog.Root open={Boolean(managedBook)} onOpenChange={(open) => { if (!open && !busy) closeBookManager(); }}>
          <Dialog.Portal>
            <Dialog.Overlay className="dialog-overlay" />
            <Dialog.Content className="library-manage-dialog" aria-describedby="library-manage-description">
              {confirmDelete ? (
                <>
                  <Dialog.Title>确认删除本书数据</Dialog.Title>
                  <Dialog.Description id="library-manage-description">
                    PDFMuse 将永久删除《{managedBook?.title}》的阅读位置、对话、OCR 结果、目录和索引。PDF 原文件不会被修改或删除。
                  </Dialog.Description>
                  <div className="library-manage-warning">此操作无法撤销。</div>
                  <div className="library-manage-actions">
                    <button className="secondary-command" disabled={busy} onClick={() => setConfirmDelete(false)}>返回</button>
                    <button className="danger-command" disabled={busy} onClick={() => managedBook && void runBookMutation(() => onDeleteData(managedBook.id))}><Trash2 size={16} />永久删除本书数据</button>
                  </div>
                </>
              ) : (
                <>
                  <Dialog.Title>管理《{managedBook?.title}》</Dialog.Title>
                  <Dialog.Description id="library-manage-description">选择如何处理这本书。两种操作都不会修改或删除 PDF 原文件。</Dialog.Description>
                  <div className="library-manage-option">
                    <div><strong>移出书库</strong><p>从当前书库隐藏，阅读位置、对话和索引继续保留。以后重新打开同一 PDF 即可恢复。</p></div>
                    <button className="secondary-command" disabled={busy} onClick={() => managedBook && void runBookMutation(() => onRemove(managedBook.id))}><BookMinus size={16} />移出</button>
                  </div>
                  <div className="library-manage-option destructive">
                    <div><strong>删除本书数据</strong><p>删除 PDFMuse 保存的本书阅读数据，PDF 原文件保持原样。</p></div>
                    <button className="danger-command" disabled={busy} onClick={() => setConfirmDelete(true)}><Trash2 size={16} />删除数据</button>
                  </div>
                  <div className="library-manage-actions"><button className="secondary-command" disabled={busy} onClick={closeBookManager}>关闭</button></div>
                </>
              )}
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </main>
    </Tooltip.Provider>
  );
}
