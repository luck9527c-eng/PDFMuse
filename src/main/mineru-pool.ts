import { randomUUID } from "node:crypto";

import type { MineruPageData, MineruPageRequest, OcrDispatchPriority } from "../shared/contracts.js";

export type MineruPoolPriority = OcrDispatchPriority;

export type MineruPoolSlot = {
  send(id: string, input: MineruPageRequest): void;
  cancel(id: string): void;
  warmup(): void;
  dispose(): void;
};

export type MineruPoolSlotResponse =
  | { ok: true; result: MineruPageData }
  | { ok: false; message: string };

export type MineruPoolSlotHandlers = {
  onResponse(id: string, response: MineruPoolSlotResponse): void;
  onDown(message: string): void;
};

export type MineruPoolOptions = {
  size: number;
  createSlot(handlers: MineruPoolSlotHandlers): MineruPoolSlot;
  /** 空闲回收毫秒：最后一次活动（派发/完成/预热）后计时，到期全部槽位退场；0 或缺省关闭。 */
  idleTimeoutMs?: number;
};

type Waiter = {
  id: string;
  input: MineruPageRequest;
  priority: MineruPoolPriority;
  slot?: SlotState;
  resolve: (value: MineruPageData) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
};

type SlotState = { slot: MineruPoolSlot; busyId?: string };

/**
 * MinerU 弹性进程池：动态派页（空闲槽位领下一页）、交互插队、空闲回收、槽位崩溃自动重建。
 * 槽位串行（一条 Python 子进程同一时刻只领一页）；取消不杀子进程，迟到的结果按取消丢弃，
 * 与单 worker 时代的语义一致——只有崩溃（onDown）才整槽退役并让在途请求失败。
 */
export function createMineruPool(options: MineruPoolOptions) {
  const slots: SlotState[] = [];
  const interactiveQueue: Waiter[] = [];
  const bulkQueue: Waiter[] = [];
  const inflight = new Map<string, Waiter>();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;

  function touch() {
    if (!options.idleTimeoutMs || options.idleTimeoutMs <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    if (destroyed) return;
    idleTimer = setTimeout(reap, options.idleTimeoutMs);
  }

  function reap() {
    if (destroyed || inflight.size > 0) return;
    for (const state of slots) state.slot.dispose();
    slots.length = 0;
  }

  function createSlotState(): SlotState {
    const state = {} as SlotState;
    state.slot = options.createSlot({
      onResponse: (id, response) => settle(id, response),
      onDown: (message) => markDown(state, message),
    });
    slots.push(state);
    return state;
  }

  function settle(id: string, response: MineruPoolSlotResponse) {
    const waiter = inflight.get(id);
    if (!waiter) return;
    inflight.delete(id);
    detach(waiter);
    const state = waiter.slot;
    if (state && state.busyId === id) state.busyId = undefined;
    if (response.ok) waiter.resolve(response.result);
    else waiter.reject(new Error(response.message));
    touch();
    pump();
  }

  function markDown(state: SlotState, message: string) {
    const index = slots.indexOf(state);
    if (index >= 0) slots.splice(index, 1);
    for (const [id, waiter] of [...inflight]) {
      if (waiter.slot !== state) continue;
      inflight.delete(id);
      detach(waiter);
      waiter.reject(new Error(message));
    }
    pump();
  }

  function queueOf(waiter: Waiter) {
    return waiter.priority === "interactive" ? interactiveQueue : bulkQueue;
  }

  const abortListeners = new Map<Waiter, () => void>();

  /** 请求离场（完成/失败/取消/关池）的统一清理：摘掉 abort 监听并删除监听器登记，防泄漏。 */
  function detach(waiter: Waiter) {
    const onAbort = abortListeners.get(waiter);
    if (onAbort) waiter.signal?.removeEventListener("abort", onAbort);
    abortListeners.delete(waiter);
  }

  function abort(waiter: Waiter) {
    const queue = queueOf(waiter);
    const index = queue.indexOf(waiter);
    if (index >= 0) queue.splice(index, 1);
    const state = waiter.slot;
    if (state) {
      inflight.delete(waiter.id);
      waiter.slot = undefined;
      if (state.busyId === waiter.id) state.busyId = undefined;
      state.slot.cancel(waiter.id);
      pump();
    }
    detach(waiter);
    waiter.reject(new Error("识别已取消。"));
  }

  function pump() {
    if (destroyed) return;
    for (;;) {
      const queue = interactiveQueue.length > 0 ? interactiveQueue : bulkQueue;
      const next = queue[0];
      if (!next) return;
      let state = slots.find((candidate) => !candidate.busyId);
      if (!state) {
        if (slots.length >= options.size) return;
        state = createSlotState();
      }
      queue.shift();
      state.busyId = next.id;
      next.slot = state;
      inflight.set(next.id, next);
      try {
        state.slot.send(next.id, next.input);
      } catch (error) {
        markDown(state, error instanceof Error ? error.message : "MinerU 工作进程不可用。");
        return;
      }
    }
  }

  return {
    dispatch(
      input: MineruPageRequest,
      opts: { priority?: MineruPoolPriority; signal?: AbortSignal } = {},
    ): Promise<MineruPageData> {
      return new Promise((resolve, reject) => {
        if (destroyed) {
          reject(new Error("MinerU 工作进程池已关闭。"));
          return;
        }
        if (opts.signal?.aborted) {
          reject(new Error("识别已取消。"));
          return;
        }
        const waiter: Waiter = {
          id: randomUUID(),
          input,
          priority: opts.priority ?? "bulk",
          slot: undefined,
          resolve,
          reject,
          signal: opts.signal,
        };
        const onAbort = () => abort(waiter);
        abortListeners.set(waiter, onAbort);
        opts.signal?.addEventListener("abort", onAbort, { once: true });
        queueOf(waiter).push(waiter);
        touch();
        pump();
      });
    },
    warmup() {
      if (destroyed) return;
      if (slots.find((state) => !state.busyId)) return;
      if (slots.length >= options.size) return;
      createSlotState().slot.warmup();
      touch();
    },
    dispose() {
      destroyed = true;
      if (idleTimer) clearTimeout(idleTimer);
      for (const state of slots) state.slot.dispose();
      slots.length = 0;
      for (const waiter of [...interactiveQueue, ...bulkQueue, ...inflight.values()]) {
        detach(waiter);
        waiter.reject(new Error("MinerU 工作进程池已关闭。"));
      }
      interactiveQueue.length = 0;
      bulkQueue.length = 0;
      inflight.clear();
    },
  };
}

export type MineruPool = ReturnType<typeof createMineruPool>;
