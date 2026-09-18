import type { MineruWorkerResponse } from "../shared/contracts.js";

/**
 * MinerU 桥接协议路由：跟踪在途请求、按取消丢弃迟到响应、过滤第三方日志行。
 * 取消不杀 Python 进程（常驻模型重载代价太高），迟到的结果在这里静默丢弃。
 */
export function createMineruResponseRouter(post: (response: MineruWorkerResponse) => void) {
  const pending = new Set<string>();
  const cancelled = new Set<string>();

  return {
    track(id: string) {
      pending.add(id);
    },
    cancel(id: string) {
      if (pending.delete(id)) cancelled.add(id);
    },
    /** 处理子进程一行输出；非协议行（第三方日志）静默忽略。 */
    handleLine(line: string) {
      const trimmed = line.trim();
      if (!trimmed) return;
      let response: MineruWorkerResponse;
      try {
        response = JSON.parse(trimmed) as MineruWorkerResponse;
      } catch {
        return;
      }
      if (!response || typeof response.id !== "string" || typeof response.ok !== "boolean") return;
      if (cancelled.delete(response.id)) return;
      pending.delete(response.id);
      post(response);
    },
    /** 子进程异常退出：拒绝全部在途请求并复位路由（下次请求会重启子进程）。 */
    rejectAll(message: string) {
      for (const id of pending) post({ id, ok: false, message });
      pending.clear();
      cancelled.clear();
    },
  };
}

export type MineruResponseRouter = ReturnType<typeof createMineruResponseRouter>;
