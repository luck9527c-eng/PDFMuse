import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createPdfDocumentBroker } from "./pdf-document-broker.js";

const FIXTURE = path.resolve(import.meta.dirname, "fixtures/navigation.pdf");

/** 计数书源：每次真实读文件（模拟重读整个 PDF 的成本点），返回累计次数。 */
async function countingSource() {
  const bytes = new Uint8Array(await readFile(FIXTURE));
  let loads = 0;
  const loadBook = async () => {
    loads += 1;
    return { bytes };
  };
  return { loadBook, loads: () => loads };
}

describe("pdf document broker（T60）", () => {
  it("同书多次获取只加载一次；释放后复用缓存句柄", async () => {
    const source = await countingSource();
    const broker = createPdfDocumentBroker({ loadBook: source.loadBook, idleTimeoutMs: 0 });
    const first = await broker.acquire("a".repeat(64));
    expect(first.document.numPages).toBe(3);
    first.release();
    const second = await broker.acquire("a".repeat(64));
    second.release();
    expect(source.loads()).toBe(1);
    broker.dispose();
  });

  it("LRU 容量：最旧空闲书被驱逐，最新书保持缓存", async () => {
    const source = await countingSource();
    const broker = createPdfDocumentBroker({ loadBook: source.loadBook, capacity: 2, idleTimeoutMs: 0 });
    const a = await broker.acquire("a".repeat(64));
    a.release();
    const b = await broker.acquire("b".repeat(64));
    b.release();
    const c = await broker.acquire("c".repeat(64));
    c.release();
    expect(source.loads()).toBe(3); // a、b、c 各一次
    // b 仍在缓存（a 已被 c 挤出）。
    await broker.acquire("b".repeat(64)).then((handle) => handle.release());
    expect(source.loads()).toBe(3);
    // a 需要重新加载。
    await broker.acquire("a".repeat(64)).then((handle) => handle.release());
    expect(source.loads()).toBe(4);
    broker.dispose();
  });

  it("引用计数保护：在飞引用的书不被容量压力驱逐，允许暂时超容量", async () => {
    const source = await countingSource();
    const broker = createPdfDocumentBroker({ loadBook: source.loadBook, capacity: 2, idleTimeoutMs: 0 });
    const a = await broker.acquire("a".repeat(64)); // 未 release
    const b = await broker.acquire("b".repeat(64));
    b.release();
    const c = await broker.acquire("c".repeat(64)); // 容量 2 + a 在飞 → 暂时 3 本
    c.release();
    // a 仍在飞：句柄必须可用（未被销毁）。
    expect((await a.document.getPage(1)).pageNumber).toBe(1);
    a.release();
    // 释放后下一次 acquire 触发修剪：最旧的 a（空闲）被驱逐。
    await broker.acquire("d".repeat(64)).then((handle) => handle.release());
    await broker.acquire("a".repeat(64)).then((handle) => handle.release());
    expect(source.loads()).toBe(5); // a、b、c、d 各一次 + a 重载一次
    broker.dispose();
  });

  it("空闲超时回收：到期后空闲句柄退场，下次获取重新加载", async () => {
    const source = await countingSource();
    const broker = createPdfDocumentBroker({ loadBook: source.loadBook, idleTimeoutMs: 30 });
    await broker.acquire("a".repeat(64)).then((handle) => handle.release());
    expect(source.loads()).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 90));
    await broker.acquire("a".repeat(64)).then((handle) => handle.release());
    expect(source.loads()).toBe(2);
    broker.dispose();
  });

  it("并发同书获取共享同一次加载", async () => {
    const source = await countingSource();
    const broker = createPdfDocumentBroker({ loadBook: source.loadBook, idleTimeoutMs: 0 });
    const handles = await Promise.all([
      broker.acquire("a".repeat(64)),
      broker.acquire("a".repeat(64)),
      broker.acquire("a".repeat(64)),
    ]);
    expect(source.loads()).toBe(1);
    for (const handle of handles) handle.release();
    broker.dispose();
  });

  it("加载失败不留在缓存：修复书源后重新获取成功", async () => {
    const bytes = new Uint8Array(await readFile(FIXTURE));
    let failing = true;
    const broker = createPdfDocumentBroker({
      loadBook: async () => {
        if (failing) throw new Error("文件暂不可读");
        return { bytes };
      },
      idleTimeoutMs: 0,
    });
    await expect(broker.acquire("a".repeat(64))).rejects.toThrow("文件暂不可读");
    failing = false;
    const handle = await broker.acquire("a".repeat(64));
    expect(handle.document.numPages).toBe(3);
    handle.release();
    broker.dispose();
  });

  it("dispose 后获取抛错", async () => {
    const source = await countingSource();
    const broker = createPdfDocumentBroker({ loadBook: source.loadBook, idleTimeoutMs: 0 });
    broker.dispose();
    await expect(broker.acquire("a".repeat(64))).rejects.toThrow("已关闭");
  });
});
