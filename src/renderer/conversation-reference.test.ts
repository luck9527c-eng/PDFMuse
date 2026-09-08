import { describe, expect, it } from "vitest";

import type { ConversationMessage } from "../shared/contracts";
import { getConversationReferencePage } from "./conversation-reference";

const message: ConversationMessage = {
  id: "message-1",
  sessionId: "session-1",
  runId: "run-1",
  role: "assistant",
  body: "回答",
  status: "complete",
  evidence: [
    { source: "pdf", page: 141, snippet: "第一条证据", trust: "trusted" },
    { source: "pdf", page: 142, snippet: "第二条证据", trust: "trusted" },
  ],
  createdAt: "2026-09-08T00:00:00.000Z",
};

describe("conversation reference", () => {
  it("uses the selected passage page before retrieved evidence", () => {
    expect(getConversationReferencePage(message, 120)).toBe(120);
  });

  it("falls back to the first evidence page", () => {
    expect(getConversationReferencePage(message)).toBe(141);
  });
});
