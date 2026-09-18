import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

/** 页面渲染产物：PNG base64 与像素尺寸。 */
export type RenderedPageImage = { imageData: string; width: number; height: number };

/** 书源加载：按 bookId 取原文件字节与已存密码；原文件只读，永不修改。 */
export type PageBookSource = (bookId: string) => Promise<{ bytes: Uint8Array; password?: string }>;

/**
 * 页面渲染（架构深化 T34）：canvas 依赖只在本模块出现，检索模块不再牵连渲染改动。
 * 无状态、不加缓存；每页独立打开与销毁文档，渲染内部保持既有实现。
 */
export function createPageRenderer(loadBook: PageBookSource) {
  async function renderPage(bookId: string, pageNumber: number, scale: number): Promise<RenderedPageImage> {
    const { createCanvas } = await import("@napi-rs/canvas");
    const source = await loadBook(bookId);
    const loadingTask = getDocument({
      data: source.bytes.slice(),
      ...(source.password ? { password: source.password } : {}),
    });
    try {
      const document = await loadingTask.promise;
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext("2d");
      await page.render({ canvas: canvas as never, canvasContext: context as never, viewport }).promise;
      return { imageData: canvas.toBuffer("image/png").toString("base64"), width: canvas.width, height: canvas.height };
    } finally {
      await loadingTask.destroy();
    }
  }

  return {
    /** 渲染指定页为 PNG（base64）；视觉工具与目录 AI 按需传倍率。 */
    renderPage,
  };
}

export type PageRenderer = ReturnType<typeof createPageRenderer>;
