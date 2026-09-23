import { describe, expect, it, vi } from "vitest";

import { createMineruResponseRouter } from "./mineru-protocol.js";

function makeRouter(options?: { timeoutMs?: number; onTimeout?: () => void }) {
  const posted: unknown[] = [];
  const router = createMineruResponseRouter((response) => posted.push(response), options);
  return { router, posted };
}

const OK_LINE = JSON.stringify({
  id: "r1",
  ok: true,
  result: { blocks: [{ type: "text", text: "文字", bbox: [0, 0, 100, 40] }], markdown: "# 文字" },
});

describe("MinerU response router", () => {
  it("forwards protocol responses for tracked requests and ignores unrelated lines", () => {
    const { router, posted } = makeRouter();
    router.track("r1");
    router.handleLine("[INFO] 第三方日志不应穿透协议");
    router.handleLine("");
    router.handleLine("{broken json");
    router.handleLine(OK_LINE);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ id: "r1", ok: true, result: { blocks: [{ type: "text", text: "文字" }] } });
  });

  it("drops the late response of a cancelled request", () => {
    const { router, posted } = makeRouter();
    router.track("r1");
    router.cancel("r1");
    router.handleLine(OK_LINE);
    expect(posted).toHaveLength(0);
  });

  it("rejects all pending requests when the child process exits", () => {
    const { router, posted } = makeRouter();
    router.track("r1");
    router.track("r2");
    router.cancel("r2");
    router.rejectAll("MinerU 工作进程意外退出。");
    expect(posted).toEqual([{ id: "r1", ok: false, message: "MinerU 工作进程意外退出。" }]);
    // 复位后路由重新可用：取消集合一并清空，同 id 的迟到响应不再被吞。
    router.track("r2");
    router.handleLine(JSON.stringify({ id: "r2", ok: true, result: { blocks: [], markdown: "" } }));
    expect(posted).toHaveLength(2);
  });

  it("看门狗超时按超时失败并触发子进程重建回调", () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const { router, posted } = makeRouter({ timeoutMs: 180_000, onTimeout });
      router.track("r1");
      vi.advanceTimersByTime(180_000);
      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect(posted).toEqual([{ id: "r1", ok: false, message: "MinerU 识别超时（180 秒无响应），已自动重启识别进程。" }]);
      // 触发时已拆掉全部看门狗：时间继续流逝不会重复触发。
      vi.advanceTimersByTime(500_000);
      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect(posted).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("响应与取消都会拆除看门狗，正常路径不误杀", () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const { router, posted } = makeRouter({ timeoutMs: 180_000, onTimeout });
      router.track("ok-id");
      router.handleLine(JSON.stringify({ id: "ok-id", ok: true, result: { blocks: [], markdown: "" } }));
      router.track("cancelled-id");
      router.cancel("cancelled-id");
      vi.advanceTimersByTime(1_000_000);
      expect(onTimeout).not.toHaveBeenCalled();
      expect(posted).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejectAll 清空看门狗：子进程退出后不会再触发超时回调", () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const { router } = makeRouter({ timeoutMs: 180_000, onTimeout });
      router.track("r1");
      router.rejectAll("MinerU 工作进程意外退出。");
      vi.advanceTimersByTime(1_000_000);
      expect(onTimeout).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
