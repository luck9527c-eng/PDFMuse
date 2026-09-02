import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createLibraryModule } from "./library.js";

const workspaces: string[] = [];
const fixturePath = path.resolve("data", "qa-sample.pdf");

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

  it("可以从书库再次打开，并在原文件不可用时保留记录", async () => {
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
    });
    expect(library.list()).toHaveLength(1);
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

  it("保存并限制书库显示的最近页码", async () => {
    const { workspace, dataHome } = await createWorkspace();
    const sourcePath = path.join(workspace, "页码.pdf");
    await copyFile(fixturePath, sourcePath);
    const library = createLibraryModule(dataHome);
    const added = await library.openPath(sourcePath);
    if (!added.ok) throw new Error(added.message);

    library.updateCurrentPage(added.book.id, 99);

    expect(library.list()[0]?.currentPage).toBe(1);
    library.close();
  });
});
