// OCR 整书任务执行器（从装配根提取）：线性页序批量扫描、弹性池动态派页、断点前沿、
// 整书收尾与「目录数据就绪即交棒」的数据触发器（T58-03 统一目录流）都收在这里——
// 装配根只注入依赖，触发/断点/续跑可模块级测试。

import type { JobExecutor } from "./background-jobs.js";
import { linearPageOrder } from "./ocr-page-order.js";
import {
  outlineYieldProbe,
  shouldYieldToOutline,
  TOC_YIELD_GAP_PAGES,
  tocWindowEnd,
} from "./book-outline.js";
import type { BackgroundJob, MineruBlock, OcrPageRequest, OcrPageResult } from "../shared/contracts.js";

export type OcrJobDependencies = {
  /** 书本元信息查找（页数）；找不到书时任务失败。 */
  loadBook(bookId: string): { pageCount: number } | undefined;
  /** 识别块直读（触发探针只看块库状态，不触发识别）。 */
  getPageBlocks(bookId: string, page: number): ReadonlyArray<MineruBlock> | undefined;
  /** 批量执行前的兼容检查：已识别且引擎/模型/输入版本一致的页跳过。 */
  isPageCompatible(bookId: string, page: number): boolean;
  recognizePage(input: OcrPageRequest, signal: AbortSignal): Promise<OcrPageResult>;
  /** 一页识别完成后的联动（进索引、失效目录页候选等）。 */
  ingestPage(bookId: string, page: number, blocks: readonly MineruBlock[]): Promise<void> | void;
  /** 目录数据就绪时重排目录任务（交棒前先调度，泵空闲即接跑）。 */
  scheduleOutlineRerank(bookId: string): void;
  /** 整书收尾：重排目录任务（证据齐备，产出转正目录）。 */
  completeBook(bookId: string): void;
  decodeCheckpoint(raw: string | undefined): { completed: number };
  encodeCheckpoint(completed: number): string;
  createFrontier(base: number): { frontier(): number; complete(orderIndex: number): number };
  /** 弹性池并发上限。 */
  concurrency: number;
};

export function createOcrJobExecutor(deps: OcrJobDependencies): JobExecutor {
  // 交棒一次性登记（按任务 id）：判定只看块库状态，同任务续跑后条件仍成立，
  // 不登记会让「交棒 → 续跑 → 再交棒」成为循环。会话内每次交棒留一个 id、单调累积
  // （量级 = 会话内交棒过的任务数，可忽略），换不引入跨模块清理缝。
  const yieldedOcrJobs = new Set<string>();
  return async (job: BackgroundJob, context) => {
    const book = deps.loadBook(job.bookId);
    if (!book) throw new Error("当前 PDF 书籍不可用。");
    const { completed } = deps.decodeCheckpoint(job.checkpoint);
    const pages = linearPageOrder(book.pageCount);
    // 弹性池动态派页（T49）：至多 N 页在途；断点只推进连续前沿——前沿之前必然已落库，
    // 前沿之后的在途页崩溃后按缓存缺失自然重扫。线性页序（T57-02）下断点即「已扫到第几页」。
    const limit = deps.concurrency;
    const frontier = deps.createFrontier(completed);
    let written = completed;
    let nextIndex = completed;
    let failure: string | undefined;
    const inFlight = new Set<Promise<void>>();
    // 目录数据就绪即交棒（T58-03）：run-end（目录区结束）或探测窗口扫满，二者取先；
    // 判定只在前沿推进后做一次性检查，越过窗口 + gap 后不可能再触发（启动即检除外）。
    const windowEnd = tocWindowEnd(book.pageCount);
    const maybeYieldToOutline = (reached: number, allowPastWindow = false) => {
      if (yieldedOcrJobs.has(job.id)) return;
      if (!allowPastWindow && reached > windowEnd + TOC_YIELD_GAP_PAGES) return;
      const probe = outlineYieldProbe(windowEnd, (page) => deps.getPageBlocks(job.bookId, page));
      if (shouldYieldToOutline(probe, reached, book.pageCount)) {
        yieldedOcrJobs.add(job.id);
        // 先调度后交棒：目录任务入队后 OCR 自暂停，串行泵让目录先行、空闲后自动恢复。
        deps.scheduleOutlineRerank(job.bookId);
        context.yieldOnce();
      }
    };
    // 启动即检：崩溃恢复从窗口之后续跑（checkpoint ≥ 窗口末）时，块库里窗口状态已齐，
    // 触发承诺不因换过一次进程失效——此时越过窗口的守卫放行一次。
    maybeYieldToOutline(completed, true);
    const pump = () => {
      while (!failure && !context.signal.aborted && inFlight.size < limit && nextIndex < pages.length) {
        const index = nextIndex;
        nextIndex += 1;
        const task = (async () => {
          if (context.signal.aborted) return;
          const page = pages[index]!;
          if (!deps.isPageCompatible(job.bookId, page)) {
            const result = await deps.recognizePage({ bookId: job.bookId, page, priority: "bulk" }, context.signal);
            if (!result.ok) {
              if (!context.signal.aborted) failure = result.message;
              return;
            }
            await deps.ingestPage(job.bookId, page, result.page.blocks);
          }
          const reached = frontier.complete(index);
          if (reached > written) {
            written = reached;
            context.checkpoint(deps.encodeCheckpoint(reached), reached, book.pageCount);
            maybeYieldToOutline(reached);
          }
        })().finally(() => {
          inFlight.delete(task);
          pump();
        });
        inFlight.add(task);
      }
    };
    pump();
    while (inFlight.size > 0) await Promise.all([...inFlight]);
    if (context.signal.aborted) throw new Error("OCR 任务已暂停或取消。");
    if (failure) throw new Error(failure);
    if (!context.signal.aborted) deps.completeBook(job.bookId);
  };
}
