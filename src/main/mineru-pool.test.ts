import { describe, expect, it, vi } from "vitest";

import { createMineruPool, type MineruPoolSlot, type MineruPoolSlotHandlers } from "./mineru-pool.js";

type FakeSlot = MineruPoolSlot & {
  handlers: MineruPoolSlotHandlers;
  sent: Array<{ id: string; input: { page: number; pdfPath: string } }>;
  cancelled: string[];
  warmed: number;
  disposed: boolean;
};

function makePool(options: { size: number; idleTimeoutMs?: number }) {
  const slots: FakeSlot[] = [];
  const pool = createMineruPool({
    size: options.size,
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
    createSlot: (handlers) => {
      const slot: FakeSlot = {
        handlers,
        sent: [],
        cancelled: [],
        warmed: 0,
        disposed: false,
        send: (id, input) => slot.sent.push({ id, input }),
        cancel: (id) => slot.cancelled.push(id),
        warmup: () => {
          slot.warmed += 1;
        },
        dispose: () => {
          slot.disposed = true;
        },
      };
      slots.push(slot);
      return slot;
    },
  });
  return { pool, slots };
}

const INPUT = (page: number) => ({ page, pdfPath: "book.pdf" });
const OK = (page: number) => ({ ok: true as const, result: { blocks: [], markdown: `p${page}` } });

describe("MinerU worker pool", () => {
  it("并发请求懒建槽位并动态派发：size=2 时两个在途各占一个槽位", async () => {
    const { pool, slots } = makePool({ size: 2 });
    const d1 = pool.dispatch(INPUT(1));
    const d2 = pool.dispatch(INPUT(2));
    await Promise.resolve();
    expect(slots).toHaveLength(2);
    expect(slots[0]!.sent).toEqual([{ id: expect.any(String), input: INPUT(1) }]);
    expect(slots[1]!.sent).toEqual([{ id: expect.any(String), input: INPUT(2) }]);
    slots[1]!.handlers.onResponse(slots[1]!.sent[0]!.id, OK(2));
    await expect(d2).resolves.toMatchObject({ markdown: "p2" });
    slots[0]!.handlers.onResponse(slots[0]!.sent[0]!.id, OK(1));
    await expect(d1).resolves.toMatchObject({ markdown: "p1" });
  });

  it("size=1 时后续请求排队，槽位空闲后按 FIFO 接续", async () => {
    const { pool, slots } = makePool({ size: 1 });
    const d1 = pool.dispatch(INPUT(1), { priority: "bulk" });
    const d2 = pool.dispatch(INPUT(2), { priority: "bulk" });
    const d3 = pool.dispatch(INPUT(3), { priority: "bulk" });
    await Promise.resolve();
    expect(slots).toHaveLength(1);
    expect(slots[0]!.sent).toHaveLength(1);
    slots[0]!.handlers.onResponse(slots[0]!.sent[0]!.id, OK(1));
    await expect(d1).resolves.toMatchObject({ markdown: "p1" });
    await Promise.resolve();
    expect(slots[0]!.sent).toHaveLength(2);
    expect(slots[0]!.sent[1]!.input).toEqual(INPUT(2));
    slots[0]!.handlers.onResponse(slots[0]!.sent[1]!.id, OK(2));
    slots[0]!.handlers.onResponse(slots[0]!.sent[2]!.id, OK(3));
    await expect(d2).resolves.toMatchObject({ markdown: "p2" });
    await expect(d3).resolves.toMatchObject({ markdown: "p3" });
  });

  it("交互请求插队：批量排队时交互先于更早的批量请求被派发", async () => {
    const { pool, slots } = makePool({ size: 1 });
    void pool.dispatch(INPUT(1), { priority: "bulk" });
    void pool.dispatch(INPUT(2), { priority: "bulk" });
    void pool.dispatch(INPUT(3), { priority: "bulk" });
    const interactive = pool.dispatch(INPUT(9), { priority: "interactive" });
    await Promise.resolve();
    slots[0]!.handlers.onResponse(slots[0]!.sent[0]!.id, OK(1));
    await Promise.resolve();
    expect(slots[0]!.sent[1]!.input).toEqual(INPUT(9));
    slots[0]!.handlers.onResponse(slots[0]!.sent[1]!.id, OK(9));
    await expect(interactive).resolves.toMatchObject({ markdown: "p9" });
  });

  it("槽位崩溃：在途请求按崩溃消息拒绝，后续请求在重建的槽位上继续", async () => {
    const { pool, slots } = makePool({ size: 1 });
    const d1 = pool.dispatch(INPUT(1));
    await Promise.resolve();
    slots[0]!.handlers.onDown("MinerU 工作进程意外退出。");
    await expect(d1).rejects.toThrow("MinerU 工作进程意外退出。");
    const d2 = pool.dispatch(INPUT(2));
    await Promise.resolve();
    expect(slots).toHaveLength(2);
    expect(slots[1]!.sent).toHaveLength(1);
    slots[1]!.handlers.onResponse(slots[1]!.sent[0]!.id, OK(2));
    await expect(d2).resolves.toMatchObject({ markdown: "p2" });
  });

  it("排队中的请求可取消：不占用槽位也不派发", async () => {
    const { pool, slots } = makePool({ size: 1 });
    const controller = new AbortController();
    void pool.dispatch(INPUT(1));
    const queued = pool.dispatch(INPUT(2), { priority: "bulk", signal: controller.signal });
    controller.abort();
    await expect(queued).rejects.toThrow("识别已取消。");
    slots[0]!.handlers.onResponse(slots[0]!.sent[0]!.id, OK(1));
    await Promise.resolve();
    expect(slots[0]!.sent).toHaveLength(1);
  });

  it("在途请求取消：转发 cancel 到槽位并拒绝，迟到响应不反噬", async () => {
    const { pool, slots } = makePool({ size: 1 });
    const controller = new AbortController();
    const d1 = pool.dispatch(INPUT(1), { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(d1).rejects.toThrow("识别已取消。");
    expect(slots[0]!.cancelled).toHaveLength(1);
    // 迟到的真实响应到达：请求已拒绝，池不再派发也不崩溃。
    slots[0]!.handlers.onResponse(slots[0]!.cancelled[0]!, OK(1));
    const d2 = pool.dispatch(INPUT(2));
    await Promise.resolve();
    expect(slots[0]!.sent).toHaveLength(2);
    slots[0]!.handlers.onResponse(slots[0]!.sent[1]!.id, OK(2));
    await expect(d2).resolves.toMatchObject({ markdown: "p2" });
  });

  it("空闲超时收回全部槽位，新请求重新建槽", async () => {
    vi.useFakeTimers();
    try {
      const { pool, slots } = makePool({ size: 2, idleTimeoutMs: 300_000 });
      const d1 = pool.dispatch(INPUT(1));
      const d2 = pool.dispatch(INPUT(2));
      await Promise.resolve();
      // 在途期不回收：空闲计时被派发与完成不断重置。
      vi.advanceTimersByTime(299_999);
      slots[0]!.handlers.onResponse(slots[0]!.sent[0]!.id, OK(1));
      slots[1]!.handlers.onResponse(slots[1]!.sent[0]!.id, OK(2));
      await d1;
      await d2;
      expect(slots[0]!.disposed).toBe(false);
      expect(slots[1]!.disposed).toBe(false);
      vi.advanceTimersByTime(300_000);
      expect(slots[0]!.disposed).toBe(true);
      expect(slots[1]!.disposed).toBe(true);
      const d3 = pool.dispatch(INPUT(3));
      await Promise.resolve();
      expect(slots).toHaveLength(3);
      slots[2]!.handlers.onResponse(slots[2]!.sent[0]!.id, OK(3));
      await expect(d3).resolves.toMatchObject({ markdown: "p3" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("warmup 预建首个槽位，后续请求复用", async () => {
    const { pool, slots } = makePool({ size: 2 });
    pool.warmup();
    expect(slots).toHaveLength(1);
    expect(slots[0]!.warmed).toBe(1);
    const d1 = pool.dispatch(INPUT(1));
    await Promise.resolve();
    expect(slots).toHaveLength(1);
    expect(slots[0]!.sent).toHaveLength(1);
    slots[0]!.handlers.onResponse(slots[0]!.sent[0]!.id, OK(1));
    await d1;
  });
});
