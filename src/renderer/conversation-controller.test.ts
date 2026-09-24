import type { AgentStreamEvent, ConversationMessage, SelectedPassage } from "../shared/contracts";
import { describe, expect, it } from "vitest";
import { createConversationController } from "./conversation-controller";

const RUN_ID = "run-1";
const SESSION_ID = "session-1";

function assistantDelta(runId: string, delta: string): AgentStreamEvent {
  return { stream: "assistant", runId, sessionId: SESSION_ID, delta };
}

function lifecycleEvent(runId: string, phase: "end" | "cancelled" | "error"): AgentStreamEvent {
  return { stream: "lifecycle", phase, runId, sessionId: SESSION_ID };
}

const PASSAGE: SelectedPassage = {
  bookId: "book-1",
  page: 7,
  text: "选中原文",
  rects: [],
};

describe("conversation controller", () => {
  it("buffers events that arrive before the run id is known and replays them in order", () => {
    const controller = createConversationController();
    controller.beginStart();
    controller.dispatch({ type: "agent-event", event: assistantDelta(RUN_ID, "你") });
    controller.dispatch({ type: "agent-event", event: assistantDelta(RUN_ID, "好") });
    expect(controller.getState().streaming).toBeUndefined();

    controller.dispatch({ type: "run-started", runId: RUN_ID, sessionId: SESSION_ID, question: "问题" });
    const state = controller.getState();
    expect(state.streaming?.body).toBe("你好");
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ role: "reader", body: "问题", status: "complete", runId: RUN_ID });
  });

  it("keeps the selected passage on the optimistic reader message", () => {
    const controller = createConversationController();
    controller.dispatch({ type: "run-started", runId: RUN_ID, sessionId: SESSION_ID, question: "解释", passage: PASSAGE });
    expect(controller.getState().messages[0]?.passage).toMatchObject({ page: 7, text: "选中原文" });
  });

  it("accumulates assistant deltas into the streaming reply", () => {
    const controller = createConversationController();
    controller.dispatch({ type: "run-started", runId: RUN_ID, sessionId: SESSION_ID, question: "问题" });
    controller.dispatch({ type: "agent-event", event: assistantDelta(RUN_ID, "第一段") });
    controller.dispatch({ type: "agent-event", event: assistantDelta(RUN_ID, "第二段") });
    expect(controller.getState().streaming?.body).toBe("第一段第二段");
  });

  it("maps tool events to readable status text", () => {
    const controller = createConversationController();
    controller.dispatch({ type: "run-started", runId: RUN_ID, sessionId: SESSION_ID, question: "问题" });
    controller.dispatch({ type: "agent-event", event: { stream: "tool", phase: "start", runId: RUN_ID, callId: "c1", name: "book_search" } });
    expect(controller.getState().toolStatus).toBe("检索本书中...");
    controller.dispatch({ type: "agent-event", event: { stream: "tool", phase: "end", runId: RUN_ID, callId: "c1", name: "book_search" } });
    expect(controller.getState().toolStatus).toBe("检索本书完成");
  });

  it("clears streaming and tool status on terminal lifecycle events", () => {
    const controller = createConversationController();
    controller.dispatch({ type: "run-started", runId: RUN_ID, sessionId: SESSION_ID, question: "问题" });
    controller.dispatch({ type: "agent-event", event: { stream: "tool", phase: "start", runId: RUN_ID, callId: "c1", name: "book_search" } });
    expect(controller.getState().toolStatus).toBe("检索本书中...");

    const result = controller.dispatch({ type: "agent-event", event: lifecycleEvent(RUN_ID, "end") });
    expect(result.terminalRunId).toBe(RUN_ID);
    expect(controller.getState().streaming).toBeUndefined();
    expect(controller.getState().toolStatus).toBeUndefined();
  });

  it("drops events that belong to a different run", () => {
    const controller = createConversationController();
    controller.dispatch({ type: "run-started", runId: RUN_ID, sessionId: SESSION_ID, question: "问题" });
    const result = controller.dispatch({ type: "agent-event", event: assistantDelta("stale-run", "旧运行") });
    expect(result.terminalRunId).toBeUndefined();
    expect(controller.getState().streaming?.body).toBe("");
  });

  it("cancelStart drops buffered events so they never leak into the next run", () => {
    const controller = createConversationController();
    controller.beginStart();
    controller.dispatch({ type: "agent-event", event: assistantDelta(RUN_ID, "旧") });
    controller.dispatch({ type: "run-start-failed" });
    expect(controller.getState().notice).toBe("无法发起回答，请重试。");

    controller.dispatch({ type: "run-started", runId: "run-2", sessionId: SESSION_ID, question: "新问题" });
    expect(controller.getState().streaming?.body).toBe("");
  });

  it("replaces optimistic messages when the persisted conversation loads", () => {
    const controller = createConversationController();
    controller.dispatch({ type: "conversation-loading" });
    expect(controller.getState().loading).toBe(true);
    const persisted: ConversationMessage[] = [
      {
        id: "m1",
        sessionId: SESSION_ID,
        runId: RUN_ID,
        role: "assistant",
        body: "已持久化回答",
        status: "complete",
        createdAt: new Date().toISOString(),
      },
    ];
    controller.dispatch({ type: "conversation-loaded", messages: persisted });
    expect(controller.getState().loading).toBe(false);
    expect(controller.getState().messages).toEqual(persisted);
  });

  it("notifies subscribers on every transition and resets to the initial state", () => {
    const controller = createConversationController();
    let notifications = 0;
    const unsubscribe = controller.subscribe(() => { notifications += 1; });

    controller.dispatch({ type: "run-started", runId: RUN_ID, sessionId: SESSION_ID, question: "问题" });
    controller.dispatch({ type: "clear-succeeded" });
    expect(notifications).toBe(2);
    expect(controller.getState().messages).toEqual([]);
    expect(controller.getState().notice).toBe("本书会话已清空。");

    controller.dispatch({ type: "reset" });
    expect(controller.getState().notice).toBe("");
    expect(controller.isBusy()).toBe(false);
    unsubscribe();
  });

  it("merges the run exit reason and rounds from terminal lifecycle events into diagnostics (T50)", () => {
    const controller = createConversationController();
    controller.dispatch({ type: "run-started", runId: RUN_ID, sessionId: SESSION_ID, question: "预算问题" });
    controller.dispatch({
      type: "agent-event",
      event: {
        stream: "lifecycle",
        phase: "end",
        runId: RUN_ID,
        sessionId: SESSION_ID,
        exit: { exitReason: "max_iterations_reached", roundsUsed: 50, roundsTotal: 50 },
      },
    });

    const run = controller.getState().diagnostics[RUN_ID];
    expect(run?.exitReason).toBe("max_iterations_reached");
    expect(run?.roundsUsed).toBe(50);
    expect(run?.roundsTotal).toBe(50);
  });
});
