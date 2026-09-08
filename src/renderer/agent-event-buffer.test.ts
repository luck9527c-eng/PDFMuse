import { describe, expect, it } from "vitest";

import type { AgentStreamEvent } from "../shared/contracts";
import { createAgentEventBuffer } from "./agent-event-buffer";

const earlyDelta: AgentStreamEvent = {
  stream: "assistant",
  runId: "run-1",
  sessionId: "session-1",
  delta: "先到达的内容",
};

describe("agent event buffer", () => {
  it("replays events that arrive before startAgentRun returns the run id", () => {
    const buffer = createAgentEventBuffer();

    buffer.beginStart();
    expect(buffer.route(earlyDelta, undefined)).toEqual([]);
    expect(buffer.activate("run-1")).toEqual([earlyDelta]);
  });

  it("drops buffered events from another run", () => {
    const buffer = createAgentEventBuffer();

    buffer.beginStart();
    buffer.route(earlyDelta, undefined);
    expect(buffer.activate("run-2")).toEqual([]);
  });
});
