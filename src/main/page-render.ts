import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import { regionPixelRect, type RegionBbox } from "../shared/region.js";

/** 页面渲染产物：PNG base64 与像素尺寸。 */
export type RenderedPageImage = { imageData: string; width: number; height: number };

/** 书源加载：按 bookId 取原文件字节与已存密码；原文件只读，永不修改。 */
export type PageBookSource = (bookId: string) => Promise<{ bytes: Uint8Array; password?: string }>;

/**
 * 页面渲染（架构深化 T34）：canvas 依赖只在本模块出现，检索模块不再牵连渲染改动。
 * 无状态、不加缓存；每页独立打开与销毁文档，渲染内部保持既有实现。
 */
export function createPageRenderer(loadBook: PageBookSource) {
  /** 渲染整页到独立 canvas；调用方负责 cleanup（销毁 pdfjs 文档）。 */
  async function openPageCanvas(bookId: string, pageNumber: number, scale: number) {
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
      return { canvas, cleanup: () => loadingTask.destroy() };
    } catch (error) {
      await loadingTask.destroy();
      throw error;
    }
  }

  async function renderPage(bookId: string, pageNumber: number, scale: number): Promise<RenderedPageImage> {
    const { canvas, cleanup } = await openPageCanvas(bookId, pageNumber, scale);
    try {
      return { imageData: canvas.toBuffer("image/png").toString("base64"), width: canvas.width, height: canvas.height };
    } finally {
      await cleanup();
    }
  }

  /**
   * 渲染页面的归一化 bbox 区域（T53 插图级寻址）：整页按倍率渲出后裁剪——同样的渲染
   * 倍率下，裁剪交付的小图不被 provider 降采样，有效 DPI 高于整页图。像素换算与渲染端
   * 块级对照共用 regionPixelRect。
   */
  async function renderRegion(bookId: string, pageNumber: number, bbox: RegionBbox, scale: number): Promise<RenderedPageImage> {
    const { canvas, cleanup } = await openPageCanvas(bookId, pageNumber, scale);
    try {
      const rect = regionPixelRect(bbox, canvas.width, canvas.height);
      if (!rect) throw new Error("裁剪区域无效或落在页面之外。");
      const { createCanvas } = await import("@napi-rs/canvas");
      const crop = createCanvas(rect.width, rect.height);
      crop.getContext("2d").drawImage(canvas, rect.left, rect.top, rect.width, rect.height, 0, 0, rect.width, rect.height);
      return { imageData: crop.toBuffer("image/png").toString("base64"), width: rect.width, height: rect.height };
    } finally {
      await cleanup();
    }
  }

  return {
    /** 渲染指定页为 PNG（base64）；视觉工具与目录 AI 按需传倍率。 */
    renderPage,
    /** 渲染指定页的归一化 bbox 区域为 PNG（base64）；插图级查看与块级对照共用。 */
    renderRegion,
  };
}

export type PageRenderer = ReturnType<typeof createPageRenderer>;
