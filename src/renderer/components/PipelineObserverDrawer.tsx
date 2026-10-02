import { Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  AiCallTraceData,
  BackgroundJob,
  MineruBlock,
  PipelineTraceKind,
  PipelineTraceRecord,
  TraceWindowSnapshot,
} from "../../shared/contracts";
import { PIPELINE_TRACE_KINDS } from "../../shared/contracts";

const KIND_LABELS: Record<PipelineTraceKind, string> = {
  embedded_gate: "内嵌闸门",
  locate: "目录定位",
  ai_call: "AI 提取",
  assemble_arm: "装配臂",
  offset_vote: "偏移投票",
  persist: "目录落库",
  tier_one_adjudicated: "一档裁决",
  ocr_start: "识别开始",
  ocr_yield: "OCR 让位",
  ocr_complete: "整书收尾",
  ocr_fail: "识别失败",
};

const OUTCOME_LABELS: Record<AiCallTraceData["outcome"], string> = {
  ok: "成功",
  aborted: "中止",
  failed: "失败",
  cache: "缓存命中",
};

const ARM_LABELS: Record<string, string> = {
  "native-majority": "原生书全精度",
  "all-blocks": "整书扫满全精度",
  calibrated: "校准态页级",
  wait: "等待整书",
};

type ObserverTab = "timeline" | "payload" | "jobs" | "blocks";

const TABS: Array<{ id: ObserverTab; label: string }> = [
  { id: "timeline", label: "决策时间线" },
  { id: "payload", label: "AI 载荷" },
  { id: "jobs", label: "任务流水" },
  { id: "blocks", label: "MinerU 块" },
];

/** 每条事件一行的摘要（点开看完整 JSON）：switch 沿 kind 收窄，data 形状由契约保证。 */
function summarizeEvent(record: PipelineTraceRecord): string {
  switch (record.kind) {
    case "embedded_gate":
      return `${record.data.accepted ? "接受" : "拒绝"} · 条目 ${record.data.entryCount} · 可解析 ${record.data.resolvableCount} · 去重页 ${record.data.distinctPages}`;
    case "locate": {
      const hits = record.data.hits.join("、") || "无";
      return `index 命中：${hits} · 候选 ${record.data.pages.length} 页 · 原生多数 ${record.data.nativeMajority ? "是" : "否"} · 目录区已裁定 ${record.data.tocRegionAdjudicated ? "是" : "否"}`;
    }
    case "ai_call": {
      const ai = record.data;
      if (ai.outcome === "cache") return `缓存命中 · 条目 ${ai.entriesCount ?? 0} · 目录页 ${(ai.tocPages ?? []).length}`;
      const batches = ai.exchanges.length > 0 ? ` · ${ai.exchanges.length} 次调用` : "";
      const entries = ai.entriesCount !== undefined ? ` · 条目 ${ai.entriesCount}` : "";
      return `${OUTCOME_LABELS[ai.outcome]}${entries} · 目录页 ${(ai.tocPages ?? []).length}${batches}${ai.errorMessage ? ` · ${ai.errorMessage}` : ""}`;
    }
    case "assemble_arm":
      return `臂：${ARM_LABELS[record.data.arm] ?? record.data.arm} · 有目录结论 ${record.data.hasTocConclusion ? "是" : "否"}`;
    case "offset_vote": {
      const count = (distribution: Record<string, number>) => Object.values(distribution).reduce((total, votes) => total + votes, 0);
      return `胜者 ${record.data.winner !== undefined ? `+${record.data.winner}` : "无"} · 锚点 ${count(record.data.votes.anchor)}/正文 ${count(record.data.votes.body)}/目录 ${count(record.data.votes.toc)} · 闸门 ${record.data.confirmed ? "通过" : "不过"}（≥${record.data.threshold} 票）`;
    }
    case "persist":
      return `${record.data.strategy} · ${record.data.calibrated ? "已校准" : "校准态"} · ${record.data.nodeCount} 节点 · v${record.data.version}`;
    case "tier_one_adjudicated":
      return "内嵌档已裁决（无书签或垃圾书签）";
    case "ocr_start":
      return `从第 ${record.data.fromPage} 页续扫`;
    case "ocr_yield": {
      const indexPages = record.data.probe.filter((entry) => entry.hasIndexBlock).map((entry) => entry.page);
      return `${record.data.trigger} · 扫到 ${record.data.scannedCount} 页 · index 页 ${indexPages.length > 0 ? indexPages.join("、") : "无"}`;
    }
    case "ocr_complete":
      return `整书识别完成 · ${record.data.totalPages} 页`;
    case "ocr_fail":
      return `${record.data.message}（${record.data.progress}/${record.data.total}）`;
  }
}

function EventRow({ record }: { record: PipelineTraceRecord }) {
  return (
    <details className="observer-event" data-kind={record.kind}>
      <summary>
        <time>{record.ts.slice(11, 23)}</time>
        <span className={`observer-kind ${record.kind}`}>{KIND_LABELS[record.kind]}</span>
        <em>{summarizeEvent(record)}</em>
      </summary>
      <pre className="observer-json">{JSON.stringify(record, null, 2)}</pre>
    </details>
  );
}

function SnapshotPanel({ snapshot }: { snapshot: TraceWindowSnapshot | undefined }) {
  if (!snapshot) return <p className="observer-empty">窗口快照加载中...</p>;
  const indexPages = snapshot.pages.filter((page) => page.hasIndexBlock).map((page) => page.page);
  return (
    <section className="observer-snapshot" aria-label="探测窗口快照">
      <header>
        探测窗口 1–{snapshot.windowEnd} · 已扫 {snapshot.scannedCount} 页
        · index 命中 {indexPages.length > 0 ? indexPages.join("、") : "无"}
        · gap 观测 {snapshot.gapObserved ? "目录区已结束" : "未成立"}
        · 交棒就绪 {snapshot.yieldReady ? "是" : "否"}
      </header>
      <div className="observer-pages">
        {snapshot.pages.map((page) => (
          <span
            key={page.page}
            className={`observer-page ${page.hasIndexBlock ? "index" : page.covered ? "covered" : "pending"}`}
            title={`第 ${page.page} 页${page.hasIndexBlock ? " · index 块" : page.covered ? " · 已识别" : " · 未识别"}`}
          >{page.page}</span>
        ))}
      </div>
    </section>
  );
}

function TimelineTab({ events, snapshot }: { events: PipelineTraceRecord[]; snapshot: TraceWindowSnapshot | undefined }) {
  const [hiddenKinds, setHiddenKinds] = useState<Set<PipelineTraceKind>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const kindCounts = useMemo(() => {
    const counts = new Map<PipelineTraceKind, number>();
    for (const record of events) counts.set(record.kind, (counts.get(record.kind) ?? 0) + 1);
    return counts;
  }, [events]);
  const visible = useMemo(
    () => events.filter((record) => !hiddenKinds.has(record.kind)),
    [events, hiddenKinds],
  );

  // 日志台习惯：新事件到达自动滚底；Reader 向上翻阅时停手，滚回底部即恢复跟随。
  useEffect(() => {
    const element = listRef.current;
    if (!element || !stickToBottomRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [visible, hiddenKinds]);
  const toggleKind = (kind: PipelineTraceKind) => {
    setHiddenKinds((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind); else next.add(kind);
      return next;
    });
    stickToBottomRef.current = true;
  };

  return (
    <div className="observer-timeline">
      <SnapshotPanel snapshot={snapshot} />
      {events.length > 0 && (
        <div className="observer-filters" aria-label="事件类型过滤">
          {[...PIPELINE_TRACE_KINDS].filter((kind) => kindCounts.has(kind)).map((kind) => (
            <button
              key={kind}
              className={`observer-filter ${hiddenKinds.has(kind) ? "off" : ""}`}
              onClick={() => toggleKind(kind)}
            >
              {KIND_LABELS[kind]} {kindCounts.get(kind)}
            </button>
          ))}
        </div>
      )}
      <div
        className="observer-event-list"
        ref={listRef}
        onScroll={() => {
          const element = listRef.current;
          if (element) stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
        }}
      >
        {events.length === 0
          ? <p className="observer-empty">暂无管线事件——开书或触发一次目录/识别流程后这里会出现决策记录。</p>
          : visible.length === 0
            ? <p className="observer-empty">全部类型已被过滤。</p>
            : visible.map((record, index) => <EventRow key={`${record.ts}-${index}`} record={record} />)}
      </div>
    </div>
  );
}

function PayloadTab({ events }: { events: PipelineTraceRecord[] }) {
  const calls = events.filter((record): record is Extract<PipelineTraceRecord, { kind: "ai_call" }> => record.kind === "ai_call");
  if (calls.length === 0) return <p className="observer-empty">无 AI 提取调用——本书尚未走到视觉模型这一步。</p>;
  return (
    <div className="observer-payload">
      {calls.map((record, index) => {
        const data = record.data;
        return (
          <section className={`observer-ai ${data.outcome === "cache" ? "cache" : ""}`} key={`${record.ts}-${index}`}>
            <header>
              <span className={`observer-outcome ${data.outcome}`}>{OUTCOME_LABELS[data.outcome]}</span>
              <small>
                <time>{record.ts.slice(11, 23)}</time>
                {data.entriesCount !== undefined ? ` · 条目 ${data.entriesCount}` : ""}
                {data.tocPages ? ` · 目录页 ${data.tocPages.join("、") || "无"}` : ""}
                {data.errorMessage ? ` · ${data.errorMessage}` : ""}
              </small>
            </header>
            {data.exchanges.map((exchange, exchangeIndex) => (
              <div className="observer-exchange" key={exchangeIndex}>
                <details open={data.outcome !== "cache"}>
                  <summary>Prompt 全文（第 {exchangeIndex + 1} 次调用 · {exchange.prompt.length} 字符 · {exchange.durationMs}ms）</summary>
                  <pre className="observer-json">{exchange.prompt}</pre>
                </details>
                {exchange.response !== undefined && (
                  <details>
                    <summary>模型原始返回（未解析）</summary>
                    <pre className="observer-json">{exchange.response}</pre>
                  </details>
                )}
                {exchange.errorMessage && <p className="observer-error">调用失败：{exchange.errorMessage}</p>}
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}

const JOB_KIND_LABELS: Record<BackgroundJob["kind"], string> = {
  ocr: "文字识别",
  embedding: "语义索引",
  index: "全文索引",
  outline: "目录补全",
};

const JOB_STATUS_LABELS: Record<BackgroundJob["status"], string> = {
  queued: "等待中",
  running: "处理中",
  paused: "已暂停",
  completed: "已完成",
  cancelled: "已取消",
  failed: "失败",
};

function JobsTab({ jobs }: { jobs: BackgroundJob[] }) {
  if (jobs.length === 0) return <p className="observer-empty">本书没有后台任务记录。</p>;
  return (
    <div className="observer-jobs-scroll">
      <table className="observer-jobs">
        <thead>
          <tr><th>类型</th><th>优先级</th><th>状态</th><th>进度</th><th>断点</th><th>尝试</th><th>错误</th><th>更新时间</th></tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id} data-status={job.status}>
              <td>{JOB_KIND_LABELS[job.kind]}</td>
              <td>{job.priority}</td>
              <td>{JOB_STATUS_LABELS[job.status]}</td>
              <td>{job.total > 0 ? `${job.progress}/${job.total}` : job.progress}</td>
              <td className="observer-mono">{job.checkpoint ?? "—"}</td>
              <td>{job.attempts}/{job.maxAttempts}</td>
              <td>
                {job.errorMessage
                  ? <details><summary>{job.errorMessage.length > 24 ? `${job.errorMessage.slice(0, 24)}…` : job.errorMessage}</summary><pre className="observer-json">{job.errorMessage}</pre></details>
                  : "—"}
              </td>
              <td className="observer-mono">{job.updatedAt.slice(11, 19)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BlocksTab({ bookId, page }: { bookId: string; page: number }) {
  const [follow, setFollow] = useState(true);
  const [manualPage, setManualPage] = useState(page);
  const [blocks, setBlocks] = useState<MineruBlock[] | undefined>();
  const effectivePage = follow ? page : manualPage;

  useEffect(() => {
    let cancelled = false;
    void window.pdfMuse?.getTracePageBlocks(bookId, effectivePage)
      .then((result) => { if (!cancelled) setBlocks(result); })
      .catch(() => { if (!cancelled) setBlocks([]); });
    return () => { cancelled = true; };
  }, [bookId, effectivePage]);

  return (
    <div className="observer-blocks">
      <div className="observer-blocks-controls">
        <label>
          页码
          <input
            type="number"
            min={1}
            value={effectivePage}
            disabled={follow}
            onChange={(event) => setManualPage(Math.max(1, Number(event.target.value) || 1))}
          />
        </label>
        <label className="observer-follow">
          <input
            type="checkbox"
            checked={follow}
            onChange={(event) => {
              setFollow(event.target.checked);
              // 关闭跟随时把手动页钉在当前跟随页，避免跳回更早的手动页码。
              if (!event.target.checked) setManualPage(page);
            }}
          />
          跟随当前页
        </label>
      </div>
      {blocks === undefined
        ? <p className="observer-empty">加载中...</p>
        : blocks.length === 0
          ? <p className="observer-empty">第 {effectivePage} 页尚未识别（无原始块）。</p>
          : (
            <div className="observer-block-list">
              <p className="observer-block-count">共 {blocks.length} 块</p>
              {blocks.map((block, index) => (
                <details className={`observer-block ${block.type === "index" ? "index" : ""}`} key={index}>
                  <summary>
                    <span className="observer-block-type">{block.type}</span>
                    <em>{block.text.slice(0, 60) || "（无文本）"}</em>
                  </summary>
                  <pre className="observer-json">{JSON.stringify(block, null, 2)}</pre>
                </details>
              ))}
            </div>
          )}
    </div>
  );
}

/** 管线观测抽屉（dev 专用，生产构建零残留）：只读——决策时间线、AI 载荷、任务流水、MinerU 块。
 *  打开时拉全量，background:event 通知后重拉（不做流式推送）；关闭即卸载、停刷新。 */
function ObserverDrawer({ bookId, page, onClose }: { bookId: string; page: number; onClose(): void }) {
  const [tab, setTab] = useState<ObserverTab>("timeline");
  const [events, setEvents] = useState<PipelineTraceRecord[]>([]);
  const [snapshot, setSnapshot] = useState<TraceWindowSnapshot>();
  const [jobs, setJobs] = useState<BackgroundJob[]>([]);

  const refresh = useCallback(async () => {
    if (!window.pdfMuse) return;
    try {
      const [nextEvents, nextSnapshot, nextJobs] = await Promise.all([
        window.pdfMuse.getPipelineTraceEvents(bookId),
        window.pdfMuse.getTraceWindowSnapshot(bookId),
        window.pdfMuse.getTraceJobs(bookId),
      ]);
      setEvents(nextEvents);
      setSnapshot(nextSnapshot);
      setJobs(nextJobs);
    } catch {
      // 观测面板数据拿不到就保持现状，不干扰阅读主流程。
    }
  }, [bookId]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!window.pdfMuse) return;
    return window.pdfMuse.onBackgroundEvent((event) => {
      if (event.bookId === bookId) void refresh();
    });
  }, [bookId, refresh]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside className="observer-drawer" aria-label="管线观测">
      <header className="observer-header">
        <span className="observer-title"><Search size={14} />管线观测 · {tab === "timeline" ? "决策时间线" : TABS.find((entry) => entry.id === tab)?.label}</span>
        <div className="observer-tabs" role="tablist">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              role="tab"
              aria-selected={tab === entry.id}
              className={tab === entry.id ? "active" : ""}
              onClick={() => setTab(entry.id)}
            >{entry.label}</button>
          ))}
        </div>
        <button aria-label="关闭管线观测" onClick={onClose}><X size={15} /></button>
      </header>
      <div className="observer-body">
        {tab === "timeline" && <TimelineTab events={events} snapshot={snapshot} />}
        {tab === "payload" && <PayloadTab events={events} />}
        {tab === "jobs" && <JobsTab jobs={jobs} />}
        {tab === "blocks" && <BlocksTab bookId={bookId} page={page} />}
      </div>
    </aside>
  );
}

/** DEV 门控壳：import.meta.env.DEV 在生产构建中被替换为 false，整棵子树成为死代码被剔除。 */
export function PipelineObserverDrawer(props: { bookId: string; page: number; onClose(): void }) {
  if (!import.meta.env.DEV) return null;
  return <ObserverDrawer {...props} />;
}
