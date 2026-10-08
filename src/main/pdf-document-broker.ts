import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

/** 书源加载：按 bookId 取原文件字节与已存密码；原文件只读，永不修改。 */
export type PdfDocumentSource = (bookId: string) => Promise<{ bytes: Uint8Array; password?: string }>;

export type PdfDocument = Awaited<ReturnType<typeof getDocument>["promise"]>;

/** 一次持有的共享句柄：用毕必须 release；引用清零前句柄不会被回收。 */
export type PdfDocumentHandle = {
  document: PdfDocument;
  release(): void;
};

type BrokerEntry = {
  loading: Promise<PdfDocument>;
  /** 加载任务：销毁句柄的唯一通道（pdfjs 6.x 的文档代理没有 destroy）。 */
  task?: ReturnType<typeof getDocument>;
  document?: PdfDocument;
  refs: number;
};

/**
 * PDF 文档句柄中介（T60）：进程级 per-book 共享 pdfjs 文档，消灭「每渲一页 = 重读整个
 * PDF 文件 + 全量解析 + destroy」——view_page 一次 4 页叠加超限降采样重试会放大到约
 * 12 次全文件解析，索引与目录 AI 又各自开一遍。
 * 回收双机制：LRU 容量（在飞引用计数保护，全忙时允许暂时超容量）+ 空闲超时（全部
 * 空闲句柄退场）；语义参考 MinerU 弹性池。bookId 即内容指纹，同书句柄恒可复用。
 */
export function createPdfDocumentBroker(options: {
  loadBook: PdfDocumentSource;
  /** 同时驻留的书数上限（LRU）；缺省 2。 */
  capacity?: number;
  /** 空闲回收毫秒；最后一次活动后无在飞引用即回收全部句柄；0 关闭；缺省 5 分钟。 */
  idleTimeoutMs?: number;
}) {
  const capacity = Math.max(1, options.capacity ?? 2);
  const idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60_000;
  // Map 迭代序即 LRU 序：每次 acquire 删后重插把该书移到尾（最新端）。
  const entries = new Map<string, BrokerEntry>();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  function touch() {
    if (idleTimeoutMs <= 0 || disposed) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(reapIdle, idleTimeoutMs);
  }

  function destroyEntry(bookId: string, entry: BrokerEntry) {
    if (entries.get(bookId) !== entry) return;
    entries.delete(bookId);
    // 迟到的加载任务没有 task 句柄：其 IIFE 尾部自毁（entries 已不含该条目）。
    void entry.task?.destroy().catch(() => undefined);
  }

  /** 容量修剪：从最旧开始驱逐空闲句柄；全忙时停止（暂时超容量，release 时再修）。 */
  function trim() {
    while (entries.size > capacity) {
      let evicted = false;
      for (const [bookId, entry] of entries) {
        if (entry.refs > 0) continue;
        destroyEntry(bookId, entry);
        evicted = true;
        break;
      }
      if (!evicted) return;
    }
  }

  function reapIdle() {
    if (disposed) return;
    for (const [bookId, entry] of [...entries]) {
      if (entry.refs === 0) destroyEntry(bookId, entry);
    }
  }

  function releaseEntry(bookId: string) {
    const entry = entries.get(bookId);
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
    // 加载尚未完成且已无等待者：条目不再可信（成功产物无人认领、失败会重试），直接移除；
    // 迟到的加载结果在 IIFE 尾部自毁。
    if (entry.refs === 0 && entry.document === undefined) entries.delete(bookId);
    trim();
    touch();
  }

  return {
    /** 取书句柄：同书复用（加载中去重，并发等待共享同一次加载）；失败自动归还引用。 */
    async acquire(bookId: string): Promise<PdfDocumentHandle> {
      if (disposed) throw new Error("PDF 文档句柄中介已关闭。");
      touch();
      let entry = entries.get(bookId);
      if (!entry) {
        const created: BrokerEntry = { loading: Promise.resolve({} as PdfDocument), refs: 0 };
        created.loading = (async () => {
          const source = await options.loadBook(bookId);
          const loadingTask = getDocument({
            data: source.bytes.slice(),
            ...(source.password ? { password: source.password } : {}),
          });
          const document = await loadingTask.promise;
          created.task = loadingTask;
          created.document = document;
          // 等待期间条目被移除（最后一个等待者放弃）：产物无人认领，自毁防泄漏。
          if (entries.get(bookId) !== created) void loadingTask.destroy().catch(() => undefined);
          return document;
        })();
        created.loading.catch(() => {
          if (created.refs <= 0) destroyEntry(bookId, created);
        });
        entry = created;
        entries.set(bookId, entry);
      }
      // LRU 触碰移到最新端；先计引用再修剪——新建/在飞条目不会被容量压力误驱逐。
      entries.delete(bookId);
      entries.set(bookId, entry);
      entry.refs += 1;
      trim();
      try {
        const document = await entry.loading;
        return { document, release: () => releaseEntry(bookId) };
      } catch (error) {
        releaseEntry(bookId);
        throw error;
      }
    },

    /** 关停：销毁全部句柄与空闲计时器；此后 acquire 抛错、在飞引用的 release 变 no-op。 */
    dispose() {
      disposed = true;
      if (idleTimer) clearTimeout(idleTimer);
      for (const [bookId, entry] of [...entries]) destroyEntry(bookId, entry);
    },
  };
}

export type PdfDocumentBroker = ReturnType<typeof createPdfDocumentBroker>;
