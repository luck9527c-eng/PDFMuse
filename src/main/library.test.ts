import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createLibraryModule } from "./library.js";

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
    const second = await library.openPath(secondPath);

    expect(first.ok && second.ok && first.book.id).toBe(second.ok ? second.book.id : undefined);
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
