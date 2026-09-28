import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { BookOutlineNode, BookOutlineStrategy } from "../../shared/contracts";

type OutlineNode = BookOutlineNode;

const STRATEGY_LABEL: Record<Exclude<BookOutlineStrategy, "empty">, string> = {
  embedded: "来源：内嵌书签",
  ai_toc: "来源：AI 识别",
  body_headings: "来源：正文识别",
};

function flattenOutline(nodes: OutlineNode[]): OutlineNode[] {
  return nodes.flatMap((node) => [node, ...flattenOutline(node.children)]);
}

function findOutlinePath(nodes: OutlineNode[], targetId: string): string[] {
  for (const node of nodes) {
    if (node.id === targetId) return [node.id];
    const childPath = findOutlinePath(node.children, targetId);
    if (childPath.length > 0) return [node.id, ...childPath];
  }
  return [];
}

function OutlineTree({
  nodes,
  activeId,
  expanded,
  onToggle,
  onGoToPage,
}: {
  nodes: OutlineNode[];
  activeId?: string;
  expanded: Set<string>;
  onToggle(id: string): void;
  onGoToPage(page: number, anchorTop?: number): void;
}) {
  if (nodes.length === 0) {
    return <p className="outline-empty">未检测到可用章节。</p>;
  }

  return (
    <div className="outline-tree">
      {nodes.map((node) => (
        <div className="outline-group" key={node.id}>
          <div className={`outline-row ${node.id === activeId ? "current" : ""}`} data-outline-id={node.id}>
            {node.children.length > 0 ? (
              <button className="outline-toggle" aria-label={expanded.has(node.id) ? "折叠章节" : "展开章节"} onClick={() => onToggle(node.id)}>
                {expanded.has(node.id) ? <ChevronDown /> : <ChevronRight />}
              </button>
            ) : <span className="outline-spacer" />}
            <button className="outline-item" disabled={!node.page} onClick={() => node.page && onGoToPage(node.page, node.anchor?.top)}>
              <span>{node.label}</span>
              {node.page && <span className="outline-page">{node.page}</span>}
            </button>
          </div>
          {node.children.length > 0 && expanded.has(node.id) && (
            <OutlineTree nodes={node.children} activeId={activeId} expanded={expanded} onToggle={onToggle} onGoToPage={onGoToPage} />
          )}
        </div>
      ))}
    </div>
  );
}

export function OutlinePanel({ nodes, strategy, page, emptyMessage, onGoToPage }: { nodes: OutlineNode[]; strategy: BookOutlineStrategy; page: number; emptyMessage: string; onGoToPage(page: number, anchorTop?: number): void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const activeId = useMemo(() => {
    let active: OutlineNode | undefined;
    for (const node of flattenOutline(nodes)) {
      if (node.page !== undefined && node.page <= page && (!active?.page || node.page >= active.page)) active = node;
    }
    return active?.id;
  }, [nodes, page]);
  const structureKey = useMemo(() => flattenOutline(nodes).map((node) => node.id).join("\n"), [nodes]);
  const lastScrolledIdRef = useRef<string | undefined>(undefined);

  // 只在目录结构真正变化（换书/生成完成）时重置全展开；后台任务轮询带来的同内容新数组不重置，保留用户折叠。
  useEffect(() => {
    lastScrolledIdRef.current = undefined;
    setExpanded(new Set(flattenOutline(nodes).filter((node) => node.children.length > 0).map((node) => node.id)));
  }, [structureKey]);

  // 只在当前章节变化（翻页）时定位滚动，且只滚动侧栏容器——否则 1.5s 任务轮询会不停把用户滚走的面板拽回当前章节。
  useEffect(() => {
    if (!activeId || lastScrolledIdRef.current === activeId) return;
    lastScrolledIdRef.current = activeId;
    setExpanded((current) => new Set([...current, ...findOutlinePath(nodes, activeId)]));
    requestAnimationFrame(() => {
      const root = rootRef.current;
      const row = root?.querySelector<HTMLElement>(`[data-outline-id="${activeId}"]`);
      const container = root?.closest<HTMLElement>(".left-sidebar-content") ?? root;
      if (!row || !container) return;
      const rowRect = row.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      if (rowRect.top < containerRect.top) container.scrollTop -= containerRect.top - rowRect.top;
      else if (rowRect.bottom > containerRect.bottom) container.scrollTop += rowRect.bottom - containerRect.bottom;
    });
  }, [activeId, nodes]);

  if (nodes.length === 0) return <p className="outline-empty">{emptyMessage}</p>;

  return (
    <div className="outline-panel" ref={rootRef}>
      {strategy !== "empty" && <p className="outline-source">{STRATEGY_LABEL[strategy]}</p>}
      <OutlineTree
        nodes={nodes}
        activeId={activeId}
        expanded={expanded}
        onToggle={(id) => setExpanded((current) => {
          const next = new Set(current);
          if (next.has(id)) next.delete(id); else next.add(id);
          return next;
        })}
        onGoToPage={onGoToPage}
      />
    </div>
  );
}
