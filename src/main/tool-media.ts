import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * 工具媒体文件（T44）：view_page 的原图转存 book 数据目录，会话库只存相对路径引用。
 * 目录按 bookId 隔离，删除书籍数据时整目录移除；清空会话不回收文件（不做 GC，绑定书籍生命周期）。
 */
export function createToolMedia(dataHome: string) {
  const mediaRoot = path.join(dataHome, "media");

  async function savePageImage(bookId: string, page: number, pngBase64: string): Promise<{ relativePath: string }> {
    const dir = path.join(mediaRoot, bookId);
    await mkdir(dir, { recursive: true });
    const fileName = `p${page}-${randomUUID().slice(0, 8)}.png`;
    await writeFile(path.join(dir, fileName), Buffer.from(pngBase64, "base64"));
    return { relativePath: `${bookId}/${fileName}` };
  }

  /** 同问复用（T50）按相对路径读回媒体字节；缺失返回 null（调用方回退重新渲染）。 */
  async function loadPageImage(relativePath: string): Promise<string | null> {
    try {
      return (await readFile(path.join(mediaRoot, relativePath))).toString("base64");
    } catch {
      return null;
    }
  }

  async function deleteBookData(bookId: string): Promise<void> {
    await rm(path.join(mediaRoot, bookId), { recursive: true, force: true });
  }

  return {
    savePageImage,
    loadPageImage,
    deleteBookData,
  };
}

export type ToolMedia = ReturnType<typeof createToolMedia>;
