import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMemoryModule } from "./memory.js";

const BOOK_ID = "a".repeat(64);

describe("memory module", () => {
  let dataHome: string;
  let memory: ReturnType<typeof createMemoryModule>;

  beforeEach(async () => {
    dataHome = await mkdtemp(path.join(os.tmpdir(), "pdfmuse-memory-"));
    memory = createMemoryModule(dataHome);
  });

  afterEach(async () => {
    memory?.close();
    await rm(dataHome, { recursive: true, force: true });
  });

  it("keeps proposals pending until Reader approval, then makes trusted memory searchable", () => {
    const proposed = memory.propose({ bookId: BOOK_ID, content: "CAP 讨论的是一致性、可用性和分区容错之间的取舍。", source: "pdf", sourceId: "evidence:p1", page: 8, provenance: "pdf-evidence" });
    expect(proposed.ok).toBe(true);
    expect(proposed.proposal?.status).toBe("pending");
    expect(proposed.proposal?.trust).toBe("untrusted");
    const proposalId = proposed.proposal!.id;

    const approved = memory.review({ bookId: BOOK_ID, proposalId, action: "approve" });
    expect(approved.ok).toBe(true);
    expect(approved.memory?.trust).toBe("trusted");
    expect(memory.search(BOOK_ID, "一致性")).toMatchObject([{ content: expect.stringContaining("CAP"), trust: "trusted", page: 8 }]);
  });

  it("keeps external web memories untrusted even after explicit approval", () => {
    const proposed = memory.propose({ bookId: BOOK_ID, content: "网页中的补充观点", source: "web", sourceId: "https://example.com/a" });
    expect(proposed.ok).toBe(true);
    const approved = memory.review({ bookId: BOOK_ID, proposalId: proposed.proposal!.id, action: "approve" });
    expect(approved.memory?.trust).toBe("untrusted");
  });

  it("supports rejection, revocation and duplicate proposal idempotency", () => {
    const first = memory.propose({ bookId: BOOK_ID, content: "可撤销的知识", source: "conversation" });
    const duplicate = memory.propose({ bookId: BOOK_ID, content: "可撤销的知识", source: "conversation" });
    expect(duplicate).toEqual(first);
    expect(memory.review({ bookId: BOOK_ID, proposalId: first.proposal!.id, action: "reject" }).ok).toBe(true);
    expect(memory.review({ bookId: BOOK_ID, proposalId: first.proposal!.id, action: "reject" })).toMatchObject({ ok: false, code: "CONFLICT" });

    const second = memory.propose({ bookId: BOOK_ID, content: "另一条知识", source: "summary" });
    const approved = memory.review({ bookId: BOOK_ID, proposalId: second.proposal!.id, action: "approve" });
    expect(approved.memory).toBeDefined();
    expect(memory.revoke(approved.memory!.id)).toMatchObject({ ok: true, memory: { revokedAt: expect.any(String) } });
    expect(memory.search(BOOK_ID, "另一条知识")).toEqual([]);
    expect(memory.revoke(approved.memory!.id)).toMatchObject({ ok: false, code: "CONFLICT" });
  });

  it("isolates memories by book and rejects invalid proposals", () => {
    expect(memory.propose({ bookId: "bad", content: "x" })).toMatchObject({ ok: false, code: "VALIDATION_ERROR" });
    expect(memory.propose({ bookId: BOOK_ID, content: "   " })).toMatchObject({ ok: false, code: "VALIDATION_ERROR" });
    const proposed = memory.propose({ bookId: BOOK_ID, content: "只属于一本书", source: "pdf" });
    memory.review({ bookId: BOOK_ID, proposalId: proposed.proposal!.id, action: "approve" });
    expect(memory.search("b".repeat(64), "只属于一本书")).toEqual([]);
  });
});
