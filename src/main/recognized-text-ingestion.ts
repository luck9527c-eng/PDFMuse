import type { ScheduleJobInput } from "./background-jobs.js";
import type {
  BackgroundJobKind,
  BackgroundJobStatus,
  ScheduleBackgroundJobInput,
} from "../shared/contracts.js";

export type IngestSource = "background" | "interactive";

export type OcrBookCheckpoint = { focusPage: number; completed: number };

export type RecognizedTextIngestionDependencies = {
  indexRecognizedPage(bookId: string, page: number, lines: readonly { text: string }[]): void;
  scheduleEmbedding(input: Omit<ScheduleBackgroundJobInput, "kind">): Promise<boolean> | boolean;
  invalidateOutline(bookId: string, page: number): void;
  loadPageCount(bookId: string): number;
  listJobs(bookId: string): Array<{ id: string; kind: BackgroundJobKind; status: BackgroundJobStatus }>;
  cancelJob(id: string): unknown;
  scheduleJob(input: ScheduleJobInput): unknown;
};
// 手动识别需要目录立即跟上当前页；后台整书流程只在收尾重排一次。
const INTERACTIVE_OUTLINE_PRIORITY = 20;
const BACKGROUND_OUTLINE_PRIORITY = 5;
const EMBEDDING_PRIORITY = 5;
const ACTIVE_JOB_STATUSES: BackgroundJobStatus[] = ["queued", "running", "paused"];

export function createRecognizedTextIngestion(dependencies: RecognizedTextIngestionDependencies) {
  return {
    /** 一页 Recognized Text 变更后的全部联动：进索引、按配置排语义索引、失效目录；手动来源额外按交互优先级重排目录。 */
    async ingestRecognizedPage(bookId: string, page: number, lines: readonly { text: string }[], source: IngestSource) {
      dependencies.indexRecognizedPage(bookId, page, lines);
      await dependencies.scheduleEmbedding({ bookId, priority: EMBEDDING_PRIORITY, total: dependencies.loadPageCount(bookId) });
      dependencies.invalidateOutline(bookId, page);
      if (source === "interactive") {
        for (const job of dependencies.listJobs(bookId)) {
          if (job.kind === "outline" && ACTIVE_JOB_STATUSES.includes(job.status)) dependencies.cancelJob(job.id);
        }
        dependencies.scheduleJob({
          bookId,
          kind: "outline",
          priority: INTERACTIVE_OUTLINE_PRIORITY,
          total: dependencies.loadPageCount(bookId),
        });
      }
    },
    /** 整书识别收尾：OCR 全书完成后正文锚点才齐，重排目录任务（AI 结论与页候选已缓存，重建只重跑装配）。 */
    completeBookOcr(bookId: string) {
      dependencies.scheduleJob({
        bookId,
        kind: "outline",
        priority: BACKGROUND_OUTLINE_PRIORITY,
        total: dependencies.loadPageCount(bookId),
      });
    },
    encodeOcrCheckpoint(focusPage: number, completed: number) {
      return `ocr-order:${focusPage}:${completed}`;
    },
    decodeOcrCheckpoint(raw: string | undefined): OcrBookCheckpoint {
      const order = raw?.match(/^ocr-order:(\d+):(\d+)$/);
      const legacy = raw?.match(/^(?:start|page):(\d+)$/);
      return {
        focusPage: Math.max(1, Number(order?.[1] ?? legacy?.[1] ?? 1) || 1),
        completed: Math.max(0, Number(order?.[2] ?? 0) || 0),
      };
    },
  };
}

export type RecognizedTextIngestion = ReturnType<typeof createRecognizedTextIngestion>;
