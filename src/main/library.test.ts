import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createBookIndex } from "./agent/book-index.js";
import { createSessionStore } from "./agent/session-store.js";
import { createBackgroundJobModule } from "./background-jobs.js";
import { createBookOutlineModule } from "./book-outline.js";
import { createLibraryModule } from "./library.js";
import { createOcrModule } from "./ocr.js";
import type { MineruEngine } from "./mineru.js";

const workspaces: string[] = [];
const fixturePath = path.resolve("data", "qa-sample.pdf");
const multiPageFixturePath = path.resolve("src", "main", "fixtures", "three-page.pdf");
const encryptedFixturePath = path.resolve("src", "main", "fixtures", "encrypted.pdf");

async function createWorkspace() {
  const workspace = await mkdtemp(path.join(tmpdir(), "pdfmuse-library-"));
  const dataHome = path.join(workspace, "data");
  await mkdir(dataHome);
  workspaces.push(workspace);
  return { workspace, dataHome };
}

function digest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => rm(workspace, { recursive: true })));
});

describe("Library Module", () => {
  it("验证 PDF 后按内容指纹加入 SQLite 书库且不复制原文件", async () => {
    const { workspace, dataHome } = await createWorkspace();
    const sourcePath = path.join(workspace, "测试书籍.pdf");
    await copyFile(fixturePath, sourcePath);
    const sourceBefore = await readFile(sourcePath);
    const library = createLibraryModule(dataHome);

    const result = await library.openPath(sourcePath);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.book).toMatchObject({
        id: digest(sourceBefore),
        name: "测试书籍",
        path: sourcePath,
        pageCount: 1,
        currentPage: 1,
        readingState: {
          page: 1,
          scrollTop: 0,
          zoomMode: "page-width",
          zoomScale: 100,
          leftSidebarOpen: true,
          rightSidebarOpen: true,
        },
      });
      expect(result.book.bytes).toEqual(new Uint8Array(sourceBefore));
    }
    expect(library.list()).toEqual([
      expect.objectContaining({
        id: digest(sourceBefore),
        title: "测试书籍",
        fileName: "测试书籍.pdf",
        path: sourcePath,
        pageCount: 1,
        currentPage: 1,
      }),
    ]);
    expect(await readFile(sourcePath)).toEqual(sourceBefore);
    expect(await readdir(dataHome)).not.toContain("测试书籍.pdf");
    expect(await readdir(dataHome)).toContain("pdfmuse.db");
    library.close();
  });

  it("相同内容从不同路径打开时更新原记录而不创建重复书籍", async () => {
    const { workspace, dataHome } = await createWorkspace();
    const firstPath = path.join(workspace, "第一名称.pdf");
    const secondPath = path.join(workspace, "第二名称.PDF");
    await Promise.all([copyFile(fixturePath, firstPath), copyFile(fixturePath, secondPath)]);
    const library = createLibraryModule(dataHome);

    const first = await library.openPath(firstPath);
    if (!first.ok) throw new Error(first.message);
    library.updateReadingState(first.book.id, {
      page: 1,
      scrollTop: 240,
      zoomMode: "custom",
      zoomScale: 140,
      leftSidebarOpen: false,
      rightSidebarOpen: true,
    });
    const second = await library.openPath(secondPath);

    expect(second.ok && first.book.id).toBe(second.ok ? second.book.id : undefined);
    expect(second).toMatchObject({
      ok: true,
      book: { readingState: { scrollTop: 240, zoomMode: "custom", zoomScale: 140, leftSidebarOpen: false } },
    });
    expect(library.list()).toHaveLength(1);
    expect(library.list()[0]).toMatchObject({
      title: "第二名称",
      fileName: "第二名称.PDF",
      path: secondPath,
    });
    library.close();
  });

  it("拒绝非 PDF 和损坏 PDF 且不写入书库", async () => {
    const { workspace, dataHome } = await createWorkspace();
    const textPath = path.join(workspace, "notes.txt");
    const damagedPath = path.join(workspace, "damaged.pdf");
    await Promise.all([
      writeFile(textPath, "not a pdf"),
      writeFile(damagedPath, "%PDF-1.7\ninvalid"),
    ]);
    const library = createLibraryModule(dataHome);

    await expect(library.openPath(textPath)).resolves.toMatchObject({
      ok: false,
      code: "INVALID_FILE_TYPE",
    });
    await expect(library.openPath(damagedPath)).resolves.toMatchObject({
      ok: false,
      code: "INVALID_PDF",
    });
    expect(library.list()).toEqual([]);
    library.close();
  });

  it("原文件不可用时保留记录，并只允许用相同内容重新定位", async () => {
    const { workspace, dataHome } = await createWorkspace();
    const sourcePath = path.join(workspace, "可恢复.pdf");
    await copyFile(fixturePath, sourcePath);
    const library = createLibraryModule(dataHome);
    const added = await library.openPath(sourcePath);
    if (!added.ok) throw new Error(added.message);

    await expect(library.openKnown(added.book.id)).resolves.toMatchObject({
      ok: true,
      book: { id: added.book.id, path: sourcePath },
    });
    await unlink(sourcePath);
    await expect(library.openKnown(added.book.id)).resolves.toMatchObject({
      ok: false,
      code: "FILE_UNAVAILABLE",
      bookId: added.book.id,
    });
    expect(library.list()).toHaveLength(1);

    const wrongPath = path.join(workspace, "错误文件.pdf");
    const relocatedPath = path.join(workspace, "重新定位.pdf");
    await Promise.all([
      writeFile(wrongPath, "%PDF-1.7\nother"),
      copyFile(fixturePath, relocatedPath),
    ]);
    await expect(library.relocate(added.book.id, wrongPath)).resolves.toMatchObject({
      ok: false,
      code: "CONTENT_CHANGED",
      bookId: added.book.id,
    });
    await expect(library.relocate(added.book.id, relocatedPath)).resolves.toMatchObject({
      ok: true,
      book: { id: added.book.id, path: relocatedPath },
    });
    expect(library.list()).toHaveLength(1);
    expect(library.list()[0]?.path).toBe(relocatedPath);
    library.close();
  });

  it("检测原路径内容变化并保持原有书库身份", async () => {
    const { workspace, dataHome } = await createWorkspace();
    const sourcePath = path.join(workspace, "内容变化.pdf");
    await copyFile(fixturePath, sourcePath);
    const library = createLibraryModule(dataHome);
    const added = await library.openPath(sourcePath);
    if (!added.ok) throw new Error(added.message);

    await writeFile(sourcePath, "%PDF-1.7\nchanged");
    await expect(library.openKnown(added.book.id)).resolves.toMatchObject({
      ok: false,
      code: "CONTENT_CHANGED",
    });
    expect(library.list()[0]?.id).toBe(added.book.id);
    library.close();
  });

  it("同一路径换成另一份有效 PDF 时建立新身份且不沿用旧状态", async () => {
    const { workspace, dataHome } = await createWorkspace();
    const sourcePath = path.join(workspace, "会更新的书.pdf");
    await copyFile(multiPageFixturePath, sourcePath);
    const library = createLibraryModule(dataHome);
    const original = await library.openPath(sourcePath);
    if (!original.ok) throw new Error(original.message);
    library.updateReadingState(original.book.id, {
      page: 3,
      scrollTop: 500,
      zoomMode: "custom",
      zoomScale: 175,
      leftSidebarOpen: false,
      rightSidebarOpen: false,
    });

    await copyFile(fixturePath, sourcePath);
    const replacement = await library.openPath(sourcePath);

    expect(replacement.ok).toBe(true);
    if (replacement.ok) {
      expect(replacement.book.id).not.toBe(original.book.id);
      expect(replacement.book.readingState).toMatchObject({ page: 1, scrollTop: 0, zoomScale: 100 });
    }
    expect(library.list()).toHaveLength(2);
    expect(library.list().map((book) => book.id)).toEqual(expect.arrayContaining([original.book.id, replacement.ok ? replacement.book.id : ""]));
    library.close();
  });

  it("移出书库后保留本书数据并在重新打开时恢复", async () => {
    const { workspace, dataHome } = await createWorkspace();
    const sourcePath = path.join(workspace, "暂时移出.pdf");
    await copyFile(multiPageFixturePath, sourcePath);
    const sourceBefore = await readFile(sourcePath);
    const library = createLibraryModule(dataHome);
    const opened = await library.openPath(sourcePath);
    if (!opened.ok) throw new Error(opened.message);
    library.updateReadingState(opened.book.id, {
      page: 2,
      scrollTop: 320,
      zoomMode: "custom",
      zoomScale: 125,
      leftSidebarOpen: true,
      rightSidebarOpen: false,
    });

    expect(library.removeFromLibrary(opened.book.id)).toEqual({ ok: true, bookId: opened.book.id });
    expect(library.list()).toEqual([]);
    await expect(library.openKnown(opened.book.id)).resolves.toMatchObject({ ok: false, code: "FILE_UNAVAILABLE" });

    const restored = await library.openPath(sourcePath);
    expect(restored).toMatchObject({
      ok: true,
      book: { id: opened.book.id, readingState: { page: 2, scrollTop: 320, zoomScale: 125, rightSidebarOpen: false } },
    });
    expect(await readFile(sourcePath)).toEqual(sourceBefore);
    library.close();
  });

  it("删除本书产品数据时清理所有模块记录但不触碰 PDF 原文件", async () => {
    const { workspace, dataHome } = await createWorkspace();
    const sourcePath = path.join(workspace, "彻底清理.pdf");
    await copyFile(multiPageFixturePath, sourcePath);
    const sourceBefore = await readFile(sourcePath);
    const library = createLibraryModule(dataHome);
    const opened = await library.openPath(sourcePath);
    if (!opened.ok) throw new Error(opened.message);
    const bookId = opened.book.id;
    const sessionStore = createSessionStore(dataHome);
    const bookIndex = createBookIndex(dataHome, { getBookSource: (id) => library.getBookSource(id) });
    const ocrEngine: MineruEngine = {
      name: "测试引擎",
      model: "测试模型",
      async recognizePage() {
        return { blocks: [], markdown: "" };
      },
    };
    const ocr = createOcrModule(dataHome, ocrEngine, {
      resolvePdfPath: (id) => (id === bookId ? { path: sourcePath, encrypted: false } : undefined),
    });
    const outline = createBookOutlineModule(dataHome, {
      openDocument: async () => ({ pageCount: 1, getEmbeddedNodes: async () => [], getNativeLines: async () => [], close: async () => undefined }),
    });
    const jobs = createBackgroundJobModule(dataHome, { index: async () => undefined });
    // 与 main 组装根一致的注册顺序：各模块清理自己的表，Library 只遍历注册者（ADR 0007）。
    library.registerBookDataCleaner(bookIndex.deleteBookData);
    library.registerBookDataCleaner(sessionStore.deleteBookData);
    library.registerBookDataCleaner(outline.deleteBookData);
    library.registerBookDataCleaner(ocr.deleteBookData);
    library.registerBookDataCleaner(jobs.deleteBookData);

    const session = sessionStore.ensureSession(bookId);
    sessionStore.appendMessage({ sessionId: session.id, runId: "run-1", role: "reader", body: "保留到删除前", status: "complete" });
    // Book Memory 已移除（ADR 0006）；手工放入遗留表行，验证删除数据时一并清理。
    const legacyDb = new DatabaseSync(path.join(dataHome, "pdfmuse.db"));
    legacyDb.exec("CREATE TABLE IF NOT EXISTS book_memories (id TEXT PRIMARY KEY, book_id TEXT NOT NULL)");
    legacyDb.prepare("INSERT INTO book_memories (id, book_id) VALUES ('m1', ?)").run(bookId);
    legacyDb.close();
    await bookIndex.ensureIndexed(bookId, async () => ({ bytes: opened.book.bytes }));
    await ocr.recognizePage({ bookId, page: 1, imageData: "AA==", width: 10, height: 10 });
    await outline.rebuild(bookId, async () => ({ bytes: opened.book.bytes }));
    jobs.schedule({ bookId, kind: "index" });

    expect(library.deleteBookData(bookId)).toEqual({ ok: true, bookId });
    expect(library.list()).toEqual([]);
    expect(sessionStore.findSession(bookId)).toBeUndefined();
    const legacyAfter = new DatabaseSync(path.join(dataHome, "pdfmuse.db"));
    expect((legacyAfter.prepare("SELECT count(*) AS count FROM book_memories WHERE book_id = ?").get(bookId) as { count: number }).count).toBe(0);
    legacyAfter.close();
    expect(bookIndex.stats(bookId)).toEqual({ indexedPages: 0, totalPages: 0 });
    expect(ocr.getPage(bookId, 1)).toBeUndefined();
    expect(outline.get(bookId)).toBeUndefined();
    expect(jobs.list(bookId)).toEqual([]);
    expect(await readFile(sourcePath)).toEqual(sourceBefore);

    jobs.close();
    outline.close();
    ocr.close();
    bookIndex.close();
    sessionStore.close();
    library.close();
  });

  it("按注册顺序遍历清理钩子并在同一事务连接上执行", async () => {
    const { workspace, dataHome } = await createWorkspace();
    const sourcePath = path.join(workspace, "注册清理.pdf");
    await copyFile(fixturePath, sourcePath);
    const library = createLibraryModule(dataHome);
    const opened = await library.openPath(sourcePath);
    if (!opened.ok) throw new Error(opened.message);
    const calls: string[] = [];
    const connections: DatabaseSync[] = [];
    library.registerBookDataCleaner((bookId, database) => {
      calls.push(`first:${bookId === opened.book.id}`);
      connections.push(database);
    });
    library.registerBookDataCleaner(() => calls.push("second"));

    expect(library.deleteBookData(opened.book.id)).toEqual({ ok: true, bookId: opened.book.id });
    expect(calls).toEqual(["first:true", "second"]);
    expect(connections).toHaveLength(1);
    expect(library.list()).toEqual([]);
    library.close();
  });

  it("清理钩子失败时回滚全部删除并返回写入失败", async () => {
    const { workspace, dataHome } = await createWorkspace();
    const sourcePath = path.join(workspace, "回滚清理.pdf");
    await copyFile(fixturePath, sourcePath);
    const library = createLibraryModule(dataHome);
    const opened = await library.openPath(sourcePath);
    if (!opened.ok) throw new Error(opened.message);
    const probe = new DatabaseSync(path.join(dataHome, "pdfmuse.db"));
    probe.exec("CREATE TABLE cleanup_probe (book_id TEXT NOT NULL)");
    probe.close();
    library.registerBookDataCleaner((bookId, database) => {
      database.prepare("INSERT INTO cleanup_probe (book_id) VALUES (?)").run(bookId);
    });
    library.registerBookDataCleaner(() => {
      throw new Error("模拟清理失败");
    });

    const result = library.deleteBookData(opened.book.id);

    expect(result).toMatchObject({ ok: false, code: "WRITE_ERROR" });
    expect(library.list()).toHaveLength(1);
    const verified = new DatabaseSync(path.join(dataHome, "pdfmuse.db"), { readOnly: true });
    expect((verified.prepare("SELECT COUNT(*) AS count FROM cleanup_probe").get() as { count: number }).count).toBe(0);
    verified.close();
    library.close();
  });

  it("未知书籍不触发任何清理钩子", async () => {
    const { dataHome } = await createWorkspace();
    const library = createLibraryModule(dataHome);
    const calls: string[] = [];
    library.registerBookDataCleaner(() => calls.push("cleaner"));

    expect(library.deleteBookData("f".repeat(64))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(calls).toEqual([]);
    library.close();
  });

  it("持久化完整阅读状态并在重启后恢复最近书籍", async () => {
    const { workspace, dataHome } = await createWorkspace();
    const sourcePath = path.join(workspace, "页码.pdf");
    await copyFile(multiPageFixturePath, sourcePath);
    let library = createLibraryModule(dataHome);
    const added = await library.openPath(sourcePath);
    if (!added.ok) throw new Error(added.message);

    library.updateReadingState(added.book.id, {
      page: 2,
      scrollTop: 428.5,
      zoomMode: "custom",
      zoomScale: 137.5,
      leftSidebarOpen: false,
      rightSidebarOpen: true,
    });
    library.close();

    library = createLibraryModule(dataHome);
    const recent = await library.openRecent();

    expect(library.list()[0]?.currentPage).toBe(2);
    expect(recent).toMatchObject({
      ok: true,
      book: {
        id: added.book.id,
        readingState: {
          page: 2,
          scrollTop: 428.5,
          zoomMode: "custom",
          zoomScale: 137.5,
          leftSidebarOpen: false,
          rightSidebarOpen: true,
        },
      },
    });
    library.close();
  });

  it("错误密码不写入书库，正确密码可以选择不保存", async () => {
    const { workspace, dataHome } = await createWorkspace();
    const sourcePath = path.join(workspace, "加密书籍.pdf");
    await copyFile(encryptedFixturePath, sourcePath);
    const library = createLibraryModule(dataHome);

    const challenged = await library.openPath(sourcePath);
    expect(challenged).toMatchObject({ ok: false, code: "PASSWORD_REQUIRED" });
    if (challenged.ok || challenged.code !== "PASSWORD_REQUIRED") throw new Error("没有创建密码请求");

    await expect(library.unlock(challenged.challengeId, "wrong", true)).resolves.toMatchObject({
      ok: false,
      code: "PASSWORD_REQUIRED",
      challengeId: challenged.challengeId,
      message: "密码错误，请重新输入。",
    });
    expect(library.list()).toEqual([]);

    const opened = await library.unlock(challenged.challengeId, "muse-test", false);
    expect(opened).toMatchObject({
      ok: true,
      book: { name: "PDFMuse Navigation Fixture", pageCount: 3, password: "muse-test" },
    });
    const database = new DatabaseSync(path.join(dataHome, "pdfmuse.db"), { readOnly: true });
    expect(database.prepare("SELECT saved_password FROM library_books").get()).toEqual({ saved_password: null });
    database.close();
    library.close();
  });

  it("记住正确密码后可在重启时自动解锁", async () => {
    const { workspace, dataHome } = await createWorkspace();
    const sourcePath = path.join(workspace, "记住密码.pdf");
    await copyFile(encryptedFixturePath, sourcePath);
    let library = createLibraryModule(dataHome);
    const challenged = await library.openPath(sourcePath);
    if (challenged.ok || challenged.code !== "PASSWORD_REQUIRED") throw new Error("没有创建密码请求");
    const opened = await library.unlock(challenged.challengeId, "muse-test", true);
    if (!opened.ok) throw new Error(opened.message);
    library.close();

    library = createLibraryModule(dataHome);
    await expect(library.openRecent()).resolves.toMatchObject({
      ok: true,
      book: { id: opened.book.id, password: "muse-test", pageCount: 3 },
    });
    await expect(library.openPath(sourcePath)).resolves.toMatchObject({
      ok: true,
      book: { id: opened.book.id, password: "muse-test" },
    });
    library.close();
  });

});
