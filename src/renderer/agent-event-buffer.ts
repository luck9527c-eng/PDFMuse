import type { AgentStreamEvent } from "../shared/contracts";

/** 缓冲 startAgentRun 返回 runId 之前到达的 IPC 事件，避免首批流式内容丢失。 */
export function createAgentEventBuffer() {
  let starting = false;
  let pending: AgentStreamEvent[] = [];

  return {
    beginStart() {
      starting = true;
      pending = [];
    },

    route(event: AgentStreamEvent, activeRunId: string | undefined): AgentStreamEvent[] {
      if (activeRunId && event.runId === activeRunId) return [event];
      if (starting) pending.push(event);
      return [];
    },

    activate(runId: string): AgentStreamEvent[] {
      starting = false;
      const replay = pending.filter((event) => event.runId === runId);
      pending = [];
      return replay;
    },

    cancelStart() {
      starting = false;
      pending = [];
    },
  };
}
