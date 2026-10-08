import { describe, expect, it } from "vitest";

import type { AgentTool, AgentToolResult } from "./openclaw-core.js";
import { createRunGuards } from "./run-guards.js";
import { createToolCallPipeline, type ToolCallSink } from "./tool-middleware.js";
import type { PersistedToolCall } from "./session-store.js";
import type { RunDiagnosticsToolCall } from "../../shared/contracts.js";

function fakeTool(name: string, execute: AgentTool["execute"]): AgentTool {
  return { name, label: name, description: "", parameters: undefined as never, execute };
}

/** 落库/诊断出口的假件：行、工具事件与时间线全量留痕供断言。 */
function fakeSink() {
  const rows: Array<Omit<PersistedToolCall, "runId">> = [];
  const toolCalls: RunDiagnosticsToolCall[] = [];
  const timeline: Array<{ phase: string; detail: string }> = [];
  let snapshots = 0;
  const sink: ToolCallSink = {
    appendRow: (row) => rows.push(row),
    observeToolStart: (frame) => timeline.push({ phase: "tool-start", detail: frame.tool.name }),
    observeToolCall: (toolCall, entry) => {
      toolCalls.push(toolCall);
      timeline.push(entry);
    },
    snapshotDiagnostics: () => { snapshots += 1; },
  };
  return { sink, rows, toolCalls, timeline, snapshots: () => snapshots };
}

function pipelineWith(overrides: {
  guards?: ReturnType<typeof createRunGuards>;
  webQuota?: { matches(toolName: string): boolean; limit: number; used(): number; onAttempt(): void };
  sink?: ToolCallSink;
} = {}) {
  const sink = overrides.sink ?? fakeSink().sink;
  const singleFlight = new Map<string, Promise<AgentToolResult<unknown>>>();
  const pipeline = createToolCallPipeline({
    sink,
    guards: overrides.guards ?? createRunGuards(),
    webQuota: overrides.webQuota ?? { matches: () => false, limit: 5, used: () => 0, onAttempt: () => undefined },
    singleFlight,
  });
  return { pipeline, singleFlight };
}

/** 经公开 API 把守卫推入软收尾（enterSoftFinal 不导出）：预算 1 圈，第二圈到顶即进入。 */
function softFinalGuards() {
  const guards = createRunGuards({ budgetTotal: 1 });
  guards.beginModelCall({ messages: [] } as never);
  guards.beginModelCall({ messages: [] } as never);
  return guards;
}

describe("tool middleware pipeline（T62 行为冻结重构）", () => {
  it("透传形态：正常执行落 executed 行、时间线首尾成对、诊断快照一次", async () => {
    const harness = fakeSink();
    const { pipeline } = pipelineWith({ sink: harness.sink });
    const tool = fakeTool("read_pages", async () => ({ content: [{ type: "text", text: "原文" }], details: { displaySummary: "ok" } }));

    const result = await pipeline.execute(tool, "call-1", { pages: [1] });

    expect((result.content[0] as { text: string }).text).toBe("原文");
    expect(result.details).toEqual({ displaySummary: "ok" });
    expect(harness.rows).toHaveLength(1);
    expect(harness.rows[0]).toMatchObject({ callId: "call-1", toolName: "read_pages", status: "executed", isError: false, resultText: "原文" });
    expect(harness.toolCalls[0]).toMatchObject({ callId: "call-1", name: "read_pages" });
    expect(harness.toolCalls[0]!.blocked).toBeUndefined();
    expect(harness.timeline.map((entry) => entry.phase)).toEqual(["tool-start", "tool-end"]);
    expect(harness.snapshots()).toBe(1);
  });

  it("拒绝形态（守卫闸门）：软收尾短拒——rejected 行 + blocked 诊断 + 不执行核心", async () => {
    const harness = fakeSink();
    const guards = softFinalGuards();
    const { pipeline } = pipelineWith({ guards, sink: harness.sink });
    let coreRuns = 0;
    const tool = fakeTool("search_book", async () => {
      coreRuns += 1;
      return { content: [{ type: "text", text: "不应执行" }], details: undefined };
    });

    const result = await pipeline.execute(tool, "call-2", { query: "x" });

    expect(coreRuns).toBe(0);
    expect((result.content[0] as { text: string }).text).toContain("已达上限");
    expect(harness.rows[0]).toMatchObject({ status: "rejected", isError: true });
    expect(harness.toolCalls[0]).toMatchObject({ blocked: true });
    expect(harness.timeline.at(-1)?.detail).toContain("拒绝执行");
    expect(harness.snapshots()).toBe(0);
  });

  it("拒绝形态（联网额度）：先扣后判，超限短拒；非联网工具不扣", async () => {
    const harness = fakeSink();
    let used = 0;
    const { pipeline } = pipelineWith({
      sink: harness.sink,
      webQuota: { matches: (name) => name === "search_web", limit: 1, used: () => used, onAttempt: () => { used += 1; } },
    });
    const tool = fakeTool("search_web", async () => ({ content: [{ type: "text", text: "结果" }], details: undefined }));

    await pipeline.execute(tool, "call-3", { query: "a" });
    expect(harness.rows[0]).toMatchObject({ status: "executed" });
    await pipeline.execute(tool, "call-4", { query: "b" });
    expect(harness.rows[1]).toMatchObject({ status: "rejected" });
    expect((harness.rows[1]!.resultText)).toContain("联网额度已用完（1 次）");
  });

  it("替换形态（Result Stub）：指纹判定换掉全部内容块，落库为合成文本、details 保留", async () => {
    const harness = fakeSink();
    const guards = createRunGuards();
    const original = guards.recordExecution;
    guards.recordExecution = (input) => {
      const verdict = original(input);
      return { ...verdict, delivery: "stub", stubText: "this result is byte-identical to the earlier one." };
    };
    const { pipeline } = pipelineWith({ guards, sink: harness.sink });
    const tool = fakeTool("view_page", async () => ({
      content: [
        { type: "text", text: "以下是第 1 页的原图" },
        { type: "image", data: "aGk=", mimeType: "image/png" },
      ],
      details: { media: [{ page: 1, path: "book/r-p1@2.png" }] },
    }));

    const result = await pipeline.execute(tool, "call-5", { pages: [1] });

    expect(result.content).toEqual([{ type: "text", text: "this result is byte-identical to the earlier one." }]);
    // details 按真实执行保留（媒体引用不丢）。
    expect(result.details).toEqual({ media: [{ page: 1, path: "book/r-p1@2.png" }] });
    expect(harness.rows[0]).toMatchObject({ status: "executed", resultText: "this result is byte-identical to the earlier one." });
  });

  it("注解与警告合成：注解头部队列不进指纹文本、警告拼在全文尾部", async () => {
    const harness = fakeSink();
    const guards = createRunGuards();
    const original = guards.recordExecution;
    guards.recordExecution = (input) => ({ ...original(input), delivery: "full" as const, warningText: "别重复了" });
    const { pipeline } = pipelineWith({ guards, sink: harness.sink });
    const tool = fakeTool("search_book", async () => ({
      content: [{ type: "text", text: "命中" }],
      details: { annotations: ["注解一"] },
    }));

    const result = await pipeline.execute(tool, "call-6", { query: "q" });

    expect((result.content[0] as { text: string }).text).toBe("注解一\n命中\n\n别重复了");
    expect(harness.rows[0]).toMatchObject({ resultText: "注解一\n命中\n\n别重复了" });
  });

  it("执行出错：落 error 行后原样上抛；single-flight 兄弟各自落行", async () => {
    const harness = fakeSink();
    const { pipeline } = pipelineWith({ sink: harness.sink });
    const tool = fakeTool("search_book", async () => {
      throw new Error("检索失败");
    });

    await expect(pipeline.execute(tool, "call-7", { query: "x" })).rejects.toThrow("检索失败");
    await expect(pipeline.execute(tool, "call-8", { query: "x" })).rejects.toThrow("检索失败");
    expect(harness.rows.map((row) => row.status)).toEqual(["error", "error"]);
    expect(harness.rows.map((row) => row.resultText)).toEqual(["检索失败", "检索失败"]);
  });

  it("single-flight 收敛：并行同（工具, 参数）只执行一次核心", async () => {
    const harness = fakeSink();
    const { pipeline, singleFlight } = pipelineWith({ sink: harness.sink });
    let coreRuns = 0;
    const tool = fakeTool("search_book", async () => {
      coreRuns += 1;
      return { content: [{ type: "text", text: "命中" }], details: undefined };
    });

    const [first, second] = await Promise.all([
      pipeline.execute(tool, "call-9", { query: "同参" }),
      pipeline.execute(tool, "call-10", { query: "同参" }),
    ]);

    expect(coreRuns).toBe(1);
    expect((first.content[0] as { text: string }).text).toBe("命中");
    expect((second.content[0] as { text: string }).text).toBe("命中");
    expect(singleFlight.size).toBe(0);
    expect(harness.rows).toHaveLength(2);
  });

  it("顺序钉死：守卫闸门先于联网额度（软收尾期连额度也不扣）、额度先于核心执行", async () => {
    const events: string[] = [];
    let used = 0;
    const guards = softFinalGuards();
    const harness = fakeSink();
    const { pipeline } = pipelineWith({
      guards,
      sink: harness.sink,
      webQuota: {
        matches: (name) => name === "search_web",
        limit: 5,
        used: () => used,
        onAttempt: () => { used += 1; events.push("quota-attempt"); },
      },
    });
    const tool = fakeTool("search_web", async () => {
      events.push("core");
      return { content: [{ type: "text", text: "不应到达" }], details: undefined };
    });

    await pipeline.execute(tool, "call-11", { query: "q" });
    expect(events).toEqual([]);
    expect(used).toBe(0);
  });
});
