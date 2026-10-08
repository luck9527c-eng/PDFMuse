import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * 工具媒体文件（T44）：view_page 的原图转存 book 数据目录，会话库只存相对路径引用。
 * 目录按 bookId 隔离，删除书籍数据时整目录移除；清空会话不回收文件（不做 GC，绑定书籍生命周期）。
 * T61 起同目录兼放内容寻址渲染缓存（r-* 确定性文件名）：bookId 即 SHA-256 内容指纹，
 * 同 (bookId, page, figure, scale) 恒等字节，跨 run 复用零失效逻辑。
 */
export function createToolMedia(dataHome: string) {
  const mediaRoot = path.join(dataHome, "media");

  async function savePageImage(bookId: string, page: number, pngBase64: string, figure?: number): Promise<{ relativePath: string }> {
    const dir = path.join(mediaRoot, bookId);
    await mkdir(dir, { recursive: true });
    const fileName = `p${page}${figure ? `-f${figure}` : ""}-${randomUUID().slice(0, 8)}.png`;
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

  /** 内容寻址缓存文件名（T61）：确定性命名，同键覆盖写即幂等。 */
  function renderCacheFileName(page: number, figure: number | undefined, scale: number): string {
    return `r-p${page}${figure !== undefined ? `-f${figure}` : ""}@${scale}.png`;
  }

  /** 跨 run 渲染缓存读（T61）：命中返回字节与相对路径（可直接作 media 引用）；缺失/损坏返回 null。 */
  async function loadRenderedImage(
    bookId: string,
    page: number,
    figure: number | undefined,
    scale: number,
  ): Promise<{ data: string; relativePath: string } | null> {
    const relativePath = `${bookId}/${renderCacheFileName(page, figure, scale)}`;
    try {
      const data = (await readFile(path.join(mediaRoot, relativePath))).toString("base64");
      return { data, relativePath };
    } catch {
      return null;
    }
  }

  /** 跨 run 渲染缓存写（T61）：确定性文件名落盘；返回相对路径（调用方在写失败时回退 UUID 媒体文件）。 */
  async function saveRenderedImage(
    bookId: string,
    page: number,
    figure: number | undefined,
    scale: number,
    pngBase64: string,
  ): Promise<{ relativePath: string }> {
    await mkdir(path.join(mediaRoot, bookId), { recursive: true });
    const relativePath = `${bookId}/${renderCacheFileName(page, figure, scale)}`;
    await writeFile(path.join(mediaRoot, relativePath), Buffer.from(pngBase64, "base64"));
    return { relativePath };
  }

  async function deleteBookData(bookId: string): Promise<void> {
    await rm(path.join(mediaRoot, bookId), { recursive: true, force: true });
  }

  return {
    savePageImage,
    loadPageImage,
    loadRenderedImage,
    saveRenderedImage,
    deleteBookData,
  };
}

export type ToolMedia = ReturnType<typeof createToolMedia>;
