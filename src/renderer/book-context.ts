import type { BookOutlineNode } from "../shared/contracts";

type LocatedHeading = { page: number; labels: string[] };

/** 从当前有效目录中选择当前页之前最近、且层级最具体的章节路径。 */
export function findCurrentChapter(nodes: readonly BookOutlineNode[], currentPage: number) {
  let best: LocatedHeading | undefined;

  const visit = (items: readonly BookOutlineNode[], parents: readonly string[]) => {
    for (const item of items) {
      const labels = [...parents, item.label];
      if (item.page !== undefined && item.page <= currentPage && (
        !best || item.page > best.page || (item.page === best.page && labels.length > best.labels.length)
      )) {
        best = { page: item.page, labels };
      }
      visit(item.children, labels);
    }
  };

  visit(nodes, []);
  return best?.labels.join(" > ");
}
