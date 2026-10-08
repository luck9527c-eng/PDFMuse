import type { BookOutlineNode } from "../../shared/contracts.js";

/** 展平条目：DFS 序 + 深度；章节范围解析的唯一事实源。 */
type FlatEntry = { node: BookOutlineNode; depth: number };

function flattenOutline(nodes: readonly BookOutlineNode[], depth = 0, out: FlatEntry[] = []): FlatEntry[] {
  for (const node of nodes) {
    out.push({ node, depth });
    flattenOutline(node.children, depth + 1, out);
  }
  return out;
}

/** 条目自身或其子树里第一个带页码的节点页码（章节起始页）；整段无页码返回 undefined。 */
function effectiveStartPage(flat: FlatEntry[], index: number): number | undefined {
  const depth = flat[index]!.depth;
  for (let k = index; k < flat.length && (k === index || flat[k]!.depth > depth); k += 1) {
    const page = flat[k]!.node.page;
    if (page !== undefined) return page;
  }
  return undefined;
}

export type SectionRange = {
  label: string;
  /** 章节起始页（自身或子树第一个带页码节点）；无页码时 undefined。 */
  from: number | undefined;
  /** 章节结束页（含端点）：下一同级或更浅章节起始页 − 1；后面没有可定位章节时取 totalPages。 */
  to: number | undefined;
};

/**
 * 按目录节点 id 解析章节的连续页码范围（含全部子节；T63 read_section 的寻址基础）。
 * 纯函数——同树同 id 恒同结果；未知 id 返回 undefined（调用方给诚实文案）。
 */
export function resolveSectionRange(nodes: readonly BookOutlineNode[], id: string, totalPages: number): SectionRange | undefined {
  const flat = flattenOutline(nodes);
  const index = flat.findIndex((entry) => entry.node.id === id);
  if (index < 0) return undefined;
  const depth = flat[index]!.depth;
  const from = effectiveStartPage(flat, index);
  if (from === undefined) return { label: flat[index]!.node.label, from: undefined, to: undefined };
  let to = totalPages;
  for (let k = index + 1; k < flat.length; k += 1) {
    if (flat[k]!.depth > depth) continue;
    const nextStart = effectiveStartPage(flat, k);
    if (nextStart !== undefined) {
      to = Math.max(from, nextStart - 1);
      break;
    }
    // 同级节点自身与其子树都无页码：不是有效边界，继续找下一个同级。
  }
  return { label: flat[index]!.node.label, from, to };
}
