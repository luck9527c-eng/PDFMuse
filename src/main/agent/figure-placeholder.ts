/**
 * 插图占位（T53）：image 块 text 恒为空、在页文本中不可见——装配层为每个插图块发一行
 * 自描述占位（编号 + 尺寸），升级方式落在图所在的位置，取代 read_pages 的整批模态注记。
 * 占位只进 readPages 文本，不进 FTS 与语义切片（防「插图」二字污染检索）。
 */

/** 装配输入的宽松块形状：真识别块全字段，测试夹具可只给 text。 */
export type RecognizedBlockLike = {
  text: string;
  type?: string;
  bbox?: [number, number, number, number];
};

/** 占位行的稳定前缀与后缀：识别谓词只认我们自己生成的形状。 */
const FIGURE_PLACEHOLDER_PREFIX = "[插图 ";

/** 插图块在页文本中的占位行：编号为页内第 N 个插图块（1 起），尺寸为 bbox 面积占比。 */
export function figurePlaceholderLine(page: number, figure: number, bbox: [number, number, number, number]): string {
  const [x0, y0, x1, y1] = bbox;
  const area = Math.max(0, Math.min(1, (x1 - x0))) * Math.max(0, Math.min(1, (y1 - y0)));
  const percent = Math.max(1, Math.min(100, Math.round(area * 100)));
  return `[插图 ${figure}·约占页面 ${percent}%：内容不可见，可用 view_page 查看第 ${page} 页插图 ${figure}]`;
}

/** 行是否为插图占位（FTS 与语义切片按此剔除）。 */
export function isFigurePlaceholderLine(line: string): boolean {
  return line.startsWith(FIGURE_PLACEHOLDER_PREFIX) && line.endsWith("]");
}

/** 去除文本中的全部占位行，保留其余行与换行结构。 */
export function stripFigurePlaceholderLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !isFigurePlaceholderLine(line))
    .join("\n");
}

function isFiniteBbox(bbox: [number, number, number, number]): boolean {
  return bbox.every((value) => Number.isFinite(value)) && bbox[2] > bbox[0] && bbox[3] > bbox[1];
}

/** 页内有效插图块（有限 bbox 的 image 块，按出现顺序）：占位编号与 view_page 插图寻址共用同一序。 */
export function figureBlocks<T extends RecognizedBlockLike>(blocks: ReadonlyArray<T>): T[] {
  return blocks.filter((block) => block.type === "image" && block.bbox !== undefined && isFiniteBbox(block.bbox));
}

export type AssembledPageText = {
  /** 页全文（含占位行）：read_pages 的交付形态。 */
  text: string;
  /** 可检索文本（占位行已剔除）：FTS 与语义切片的输入。 */
  indexableText: string;
};

/**
 * 把识别块装配为页文本：插图块（含空文本）出占位行，其余块出原文；非有限 bbox 的块
 * 整体跳过（无法裁剪渲染，占位只会误导）。两套文本共用一次装配，保证逐行对应。
 */
export function assembleBlockText(blocks: ReadonlyArray<RecognizedBlockLike>, page: number): AssembledPageText {
  let figureOrdinal = 0;
  const lines = blocks.map((block) => {
    if (block.type === "image" && block.bbox !== undefined && isFiniteBbox(block.bbox)) {
      figureOrdinal += 1;
      return figurePlaceholderLine(page, figureOrdinal, block.bbox);
    }
    return typeof block.text === "string" ? block.text : "";
  });
  const text = lines.filter(Boolean).join("\n").replace(/[^\S\n]+/g, " ").trim();
  return { text, indexableText: stripFigurePlaceholderLines(text) };
}
