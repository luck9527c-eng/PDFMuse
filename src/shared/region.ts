/**
 * 归一化页面区域（识别块 bbox 坐标系，0-1）与像素裁剪换算：主进程的 view_page 插图
 * 裁剪（page-render）与渲染端的块级原图对照（PdfViewer）共用同一份数学——同一幅图
 * 在模型视图与人工校对视图下裁剪一致。
 */

/** 0-1 归一化页面区域（MinerU 识别块 bbox 坐标系）。 */
export type RegionBbox = [number, number, number, number];

export type RegionPixelRect = { left: number; top: number; width: number; height: number };

/** 归一化 bbox → 钳制在页面内的像素矩形；坐标非有限、零尺寸或整块出界时返回 null。 */
export function regionPixelRect(bbox: RegionBbox, width: number, height: number): RegionPixelRect | null {
  const [x0, y0, x1, y1] = bbox;
  if (![x0, y0, x1, y1].every((value) => Number.isFinite(value)) || x1 <= x0 || y1 <= y0) return null;
  const left = Math.max(0, Math.floor(x0 * width));
  const top = Math.max(0, Math.floor(y0 * height));
  const right = Math.min(width, Math.ceil(x1 * width));
  const bottom = Math.min(height, Math.ceil(y1 * height));
  const rectWidth = right - left;
  const rectHeight = bottom - top;
  if (rectWidth <= 0 || rectHeight <= 0) return null;
  return { left, top, width: rectWidth, height: rectHeight };
}
