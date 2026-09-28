// OCR 整书任务执行器（从装配根提取）：线性页序批量扫描、弹性池动态派页、断点前沿
// 与整书收尾都收在这里——装配根只注入依赖，断点/续跑可模块级测试。
// T58 修订：目录产出与 OCR 不并跑、不让位；扫描书目录等整书完成后由收尾重排产出。

import type { JobExecutor } from "./background-jobs.js";
import { linearPageOrder } from "./ocr-page-order.js";
import type { BackgroundJob, MineruBlock, OcrPageRequest, OcrPageResult } from "../shared/contracts.js";

export type OcrJobDependencies = {
  /** 书本元信息查找（页数）；找不到书时任务失败。 */
  loadBook(bookId: string): { pageCount: number } | undefined;
  /** 批量执行前的兼容检查：已识别且引擎/模型/输入版本一致的页跳过。 */
  isPageCompatible(bookId: string, page: number): boolean;
  recognizePage(input: OcrPageRequest, signal: AbortSignal): Promise<OcrPageResult>;
  /** 一页识别完成后的联动（进索引、失效目录页候选等）。 */
  ingestPage(bookId: string, page: number, blocks: readonly MineruBlock[]): Promise<void> | void;
  /** 整书收尾：重排目录任务（证据闸门此时已过，页码投票与锚点全量就绪）。 */
  completeBook(bookId: string): void;
  decodeCheckpoint(raw: string | undefined): { completed: number };
  encodeCheckpoint(completed: number): string;
  createFrontier(base: number): { frontier(): number; complete(orderIndex: number): number };
  /** 弹性池并发上限。 */
  concurrency: number;
};

export function createOcrJobExecutor(deps: OcrJobDependencies): JobExecutor {
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
