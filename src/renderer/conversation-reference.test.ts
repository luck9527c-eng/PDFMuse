import { describe, expect, it } from "vitest";

import type { ConversationMessage } from "../shared/contracts";
import { getConversationReferencePages } from "./conversation-reference";

const message: ConversationMessage = {
  id: "message-1",
  sessionId: "session-1",
  runId: "run-1",
  role: "assistant",
  body: "回答",
  status: "complete",
  evidence: [
    { source: "pdf", page: 142, snippet: "第一条证据", trust: "trusted" },
    { source: "pdf", page: 141, snippet: "第二条证据", trust: "trusted" },
    { source: "pdf", page: 141, snippet: "重复页码的证据", trust: "trusted" },
  ],
  createdAt: "2026-09-08T00:00:00.000Z",
};

describe("conversation reference pages", () => {
  it("dedupes and sorts the selected passage page together with all evidence pages", () => {
    expect(getConversationReferencePages(message, 145)).toEqual([141, 142, 145]);
  });

  it("falls back to evidence pages alone, deduped and ordered", () => {
    expect(getConversationReferencePages(message)).toEqual([141, 142]);
  });

  it("returns nothing without passage or evidence", () => {
    expect(getConversationReferencePages({ ...message, evidence: undefined })).toEqual([]);
  });
});
