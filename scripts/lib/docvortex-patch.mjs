import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// docvortex 0.4.12 的 TextSpan 校验对同一 span 同时声明上下标直接抛 ValueError——
// 原生 PDF 数学页（x_i^2 型公式行）样式物化会合出该组合，整页解析报废。按 mineru 自家
// legacy 适配器的消解方式丢弃 subscript。与 mineru_worker.py 的运行时回退补丁保持同一
// 三态语义与同一对模式串：构建期（prepare:mineru）先打，worker 启动只读校验。
export const DOCVORTEX_SCRIPT_CONFLICT_ORIGINAL = [
  "        unique = set(value)",
  '        if "superscript" in unique and "subscript" in unique:',
  '            raise ValueError("text span cannot be both superscript and subscript")',
  "        return [style for style in INLINE_STYLE_ORDER if style in unique]",
].join("\n");

export const DOCVORTEX_SCRIPT_CONFLICT_PATCHED = [
  "        unique = set(value)",
  '        if "superscript" in unique:',
  '            unique.discard("subscript")',
  "        return [style for style in INLINE_STYLE_ORDER if style in unique]",
].join("\n");

/**
 * 对暂存完成的 runtime 打 docvortex 上下标冲突补丁（构建期主路径）。
 * 三态：applied（原文在，已改写）/ already-patched（已打过，零写入）/
 * unrecognized（两种模式都不在，上游可能已改——不碰文件，调用方告警）；
 * docvortex 包缺失时 absent。写侧固定 LF；CRLF 读入先归一再匹配。
 */
export async function applyDocvortexScriptConflictPatch(sitePackagesDir) {
  const schemaPath = path.join(sitePackagesDir, "docvortex", "schema.py");
  let source;
  try {
    source = await readFile(schemaPath, "utf8");
  } catch {
    return { state: "absent", schemaPath };
  }
  const normalized = source.replace(/\r\n/g, "\n");
  if (normalized.includes(DOCVORTEX_SCRIPT_CONFLICT_PATCHED)) {
    return { state: "already-patched", schemaPath };
  }
  if (!normalized.includes(DOCVORTEX_SCRIPT_CONFLICT_ORIGINAL)) {
    return { state: "unrecognized", schemaPath };
  }
  await writeFile(schemaPath, normalized.replace(DOCVORTEX_SCRIPT_CONFLICT_ORIGINAL, DOCVORTEX_SCRIPT_CONFLICT_PATCHED), "utf8");
  return { state: "applied", schemaPath };
}
