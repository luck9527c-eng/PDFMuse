import type { MineruWorkerResponse } from "../shared/contracts.js";

export type MineruRouterOptions = {
  /** 单请求看门狗超时毫秒；0 或缺省关闭。触发时回调 onTimeout（桥接层杀掉挂死的子进程）。 */
  timeoutMs?: number;
  onTimeout?: () => void;
};

/**
 * MinerU 桥接协议路由：跟踪在途请求、按取消丢弃迟到响应、过滤第三方日志行。
 * 取消不杀 Python 进程（常驻模型重载代价太高），迟到的结果在这里静默丢弃；
 * 但看门狗超时意味着子进程已挂死，由 onTimeout 触发杀进程重建。
 */
export function createMineruResponseRouter(post: (response: MineruWorkerResponse) => void, options: MineruRouterOptions = {}) {
  const pending = new Set<string>();
  const cancelled = new Set<string>();
  const watchdogs = new Map<string, ReturnType<typeof setTimeout>>();
  const timeoutMs = options.timeoutMs ?? 0;

  function disarm(id: string) {
    const timer = watchdogs.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      watchdogs.delete(id);
    }
  }

  return {
    track(id: string) {
      pending.add(id);
      if (timeoutMs <= 0) return;
      watchdogs.set(id, setTimeout(() => {
        // 串行子进程一个请求挂死 = 其余在途请求同样无响应：拆掉全部看门狗，
        // 本请求按超时失败，其余由桥接杀进程后的 close 拒绝路径收尾。
        for (const timer of watchdogs.values()) clearTimeout(timer);
        watchdogs.clear();
        pending.delete(id);
        post({ id, ok: false, message: `MinerU 识别超时（${Math.round(timeoutMs / 1000)} 秒无响应），已自动重启识别进程。` });
        options.onTimeout?.();
      }, timeoutMs));
    },
    cancel(id: string) {
      disarm(id);
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
      if (cancelled.delete(response.id)) {
        disarm(response.id);
        return;
      }
      pending.delete(response.id);
      disarm(response.id);
      post(response);
    },
    /** 子进程异常退出：拒绝全部在途请求并复位路由（下次请求会重启子进程）。 */
    rejectAll(message: string) {
      for (const id of pending) post({ id, ok: false, message });
      for (const timer of watchdogs.values()) clearTimeout(timer);
      watchdogs.clear();
      pending.clear();
      cancelled.clear();
    },
  };
}

export type MineruResponseRouter = ReturnType<typeof createMineruResponseRouter>;
