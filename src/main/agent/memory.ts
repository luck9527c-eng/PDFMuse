import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  BookMemory,
  MemoryProposal,
  MemoryProposalReviewInput,
  MemoryProposalStatus,
  MemorySearchResult,
  MemorySource,
  MemoryTrust,
  ProposeMemoryInput,
  MemoryMutationResult,
  MemoryAuditEntry,
} from "../../shared/contracts.js";

const CONTENT_MAX_LENGTH = 4_000;
const QUERY_MAX_LENGTH = 200;
const BOOK_ID_PATTERN = /^[a-f0-9]{64}$/;
const SOURCES: MemorySource[] = ["pdf", "conversation", "summary", "web"];

type MemoryRow = {
  id: string;
  book_id: string;
  content: string;
  source: MemorySource;
  source_id: string | null;
  page: number | null;
  trust: MemoryTrust;
  created_at: string;
  confirmed_at: string;
  revoked_at: string | null;
};

type ProposalRow = {
  id: string;
  book_id: string;
  content: string;
  source: MemorySource;
  source_id: string | null;
  page: number | null;
  trust: MemoryTrust;
  status: MemoryProposalStatus;
  created_at: string;
  reviewed_at: string | null;
  memory_id: string | null;
  provenance: ProposeMemoryInput["provenance"] | null;
};

function now() {
  return new Date().toISOString();
}

function normalizeContent(content: string) {
  return content.trim().replace(/\s+/g, " ");
}

function toMemory(row: MemoryRow): BookMemory {
  return {
    id: row.id,
    bookId: row.book_id,
    content: row.content,
    source: row.source,
    ...(row.source_id ? { sourceId: row.source_id } : {}),
    ...(row.page ? { page: row.page } : {}),
    trust: row.trust,
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at,
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
  };
}

function toProposal(row: ProposalRow): MemoryProposal {
  return {
    id: row.id,
    bookId: row.book_id,
    content: row.content,
    source: row.source,
    ...(row.source_id ? { sourceId: row.source_id } : {}),
    ...(row.page ? { page: row.page } : {}),
    trust: row.trust,
    status: row.status,
    createdAt: row.created_at,
    ...(row.reviewed_at ? { reviewedAt: row.reviewed_at } : {}),
    ...(row.memory_id ? { memoryId: row.memory_id } : {}),
  };
}

function validBookId(value: string) {
  return BOOK_ID_PATTERN.test(value);
}

function validSource(value: unknown): value is MemorySource {
  return typeof value === "string" && SOURCES.includes(value as MemorySource);
}

export function createMemoryModule(dataHome: string) {
  const database = new DatabaseSync(path.join(dataHome, "pdfmuse.db"));
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS book_memories (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('pdf', 'conversation', 'summary', 'web')),
      source_id TEXT,
      page INTEGER,
      trust TEXT NOT NULL CHECK (trust IN ('trusted', 'untrusted')),
      created_at TEXT NOT NULL,
      confirmed_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS book_memories_book_active
      ON book_memories(book_id, revoked_at, created_at);
    CREATE TABLE IF NOT EXISTS memory_proposals (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('pdf', 'conversation', 'summary', 'web')),
      source_id TEXT,
      page INTEGER,
      trust TEXT NOT NULL CHECK (trust IN ('trusted', 'untrusted')),
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'revoked')),
      created_at TEXT NOT NULL,
      reviewed_at TEXT,
      memory_id TEXT REFERENCES book_memories(id),
      provenance TEXT NOT NULL DEFAULT 'agent'
    );
    CREATE INDEX IF NOT EXISTS memory_proposals_book_status
      ON memory_proposals(book_id, status, created_at);
    CREATE TABLE IF NOT EXISTS memory_audit (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL,
      proposal_id TEXT,
      memory_id TEXT,
      action TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(memory_id UNINDEXED, book_id UNINDEXED, content);
  `);
  try { database.exec("ALTER TABLE memory_proposals ADD COLUMN provenance TEXT NOT NULL DEFAULT 'agent'"); } catch { /* 已存在 */ }
  database.prepare("DELETE FROM memory_fts").run();
  for (const row of database.prepare("SELECT id, book_id, content FROM book_memories WHERE revoked_at IS NULL").all() as Array<{ id: string; book_id: string; content: string }>) {
    database.prepare("INSERT INTO memory_fts(memory_id, book_id, content) VALUES (?, ?, ?)").run(row.id, row.book_id, row.content);
  }

  const proposalRow = database.prepare(`
    SELECT id, book_id, content, source, source_id, page, trust, status, created_at, reviewed_at, memory_id, provenance
    FROM memory_proposals WHERE id = ?
  `);
  const activeMemoryRow = database.prepare(`
    SELECT id, book_id, content, source, source_id, page, trust, created_at, confirmed_at, revoked_at
    FROM book_memories WHERE id = ?
  `);

  function audit(bookId: string, action: string, proposalId?: string, memoryId?: string, details?: string) {
    database.prepare(`
      INSERT INTO memory_audit (id, book_id, proposal_id, memory_id, action, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), bookId, proposalId ?? null, memoryId ?? null, action, details ?? null, now());
  }

  return {
    propose(input: ProposeMemoryInput): MemoryMutationResult {
      const content = normalizeContent(input.content);
      const source = input.source ?? "conversation";
      const provenance = input.provenance ?? "agent";
      if (!validBookId(input.bookId) || content.length === 0 || content.length > CONTENT_MAX_LENGTH || !validSource(source)) {
        return { ok: false, code: "VALIDATION_ERROR", message: "记忆候选内容或来源无效。" };
      }
      if (input.sourceId !== undefined && (typeof input.sourceId !== "string" || input.sourceId.length > 256)) {
        return { ok: false, code: "VALIDATION_ERROR", message: "记忆来源标识无效。" };
      }
      if (input.page !== undefined && (!Number.isSafeInteger(input.page) || input.page <= 0)) {
        return { ok: false, code: "VALIDATION_ERROR", message: "记忆页码无效。" };
      }
      if (!["agent", "reader", "pdf-evidence", "conversation", "summary", "web"].includes(provenance)) {
        return { ok: false, code: "VALIDATION_ERROR", message: "记忆来源证明无效。" };
      }
      if (source === "web" && (!input.sourceId || !/^https:\/\//i.test(input.sourceId))) {
        return { ok: false, code: "VALIDATION_ERROR", message: "网页记忆必须包含 HTTPS 来源地址。" };
      }
      if (provenance === "pdf-evidence" && (source !== "pdf" || !input.sourceId || input.page === undefined)) {
        return { ok: false, code: "VALIDATION_ERROR", message: "PDF 记忆必须带有可追溯证据。" };
      }
      const duplicate = database.prepare(`
        SELECT id, book_id, content, source, source_id, page, trust, status, created_at, reviewed_at, memory_id, provenance
        FROM memory_proposals
        WHERE book_id = ? AND lower(content) = lower(?) AND status = 'pending'
        LIMIT 1
      `).get(input.bookId, content) as ProposalRow | undefined;
      if (duplicate) return { ok: true, proposal: toProposal(duplicate) };

      const id = randomUUID();
      const timestamp = now();
      // 模型产生的候选默认不可信；Reader 审核后仍保留原始来源和信任等级。
      database.prepare(`
        INSERT INTO memory_proposals
          (id, book_id, content, source, source_id, page, trust, status, created_at, provenance)
        VALUES (?, ?, ?, ?, ?, ?, 'untrusted', 'pending', ?, ?)
      `).run(id, input.bookId, content, source, input.sourceId ?? null, input.page ?? null, timestamp, provenance);
      audit(input.bookId, "proposal_created", id, undefined, source === "web" ? "external-web" : undefined);
      const row = proposalRow.get(id) as ProposalRow;
      return { ok: true, proposal: toProposal(row) };
    },

    listProposals(bookId: string): MemoryProposal[] {
      if (!validBookId(bookId)) return [];
      return (database.prepare(`
        SELECT id, book_id, content, source, source_id, page, trust, status, created_at, reviewed_at, memory_id, provenance
        FROM memory_proposals WHERE book_id = ? ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC
      `).all(bookId) as ProposalRow[]).map(toProposal);
    },

    listMemories(bookId: string): BookMemory[] {
      if (!validBookId(bookId)) return [];
      return (database.prepare(`
        SELECT id, book_id, content, source, source_id, page, trust, created_at, confirmed_at, revoked_at
        FROM book_memories WHERE book_id = ? AND revoked_at IS NULL ORDER BY confirmed_at DESC
      `).all(bookId) as MemoryRow[]).map(toMemory);
    },

    listAudit(bookId: string): MemoryAuditEntry[] {
      if (!validBookId(bookId)) return [];
      return (database.prepare(`
        SELECT id, book_id, proposal_id, memory_id, action, details, created_at
        FROM memory_audit WHERE book_id = ? ORDER BY created_at DESC LIMIT 200
      `).all(bookId) as Array<{ id: string; book_id: string; proposal_id: string | null; memory_id: string | null; action: string; details: string | null; created_at: string }>).map((row) => ({
        id: row.id,
        bookId: row.book_id,
        ...(row.proposal_id ? { proposalId: row.proposal_id } : {}),
        ...(row.memory_id ? { memoryId: row.memory_id } : {}),
        action: row.action,
        ...(row.details ? { details: row.details } : {}),
        createdAt: row.created_at,
      }));
    },

    review(input: MemoryProposalReviewInput, expectedBookId?: string): MemoryMutationResult {
      if (typeof input.proposalId !== "string" || !["approve", "reject"].includes(input.action)) {
        return { ok: false, code: "VALIDATION_ERROR", message: "记忆审核操作无效。" };
      }
      const row = proposalRow.get(input.proposalId) as ProposalRow | undefined;
      if (!row) return { ok: false, code: "NOT_FOUND", message: "记忆候选不存在。" };
      if (expectedBookId !== undefined && row.book_id !== expectedBookId) return { ok: false, code: "NOT_FOUND", message: "记忆候选不存在。" };
      if (row.status !== "pending") return { ok: false, code: "CONFLICT", message: "这条记忆候选已经审核过了。" };
      const timestamp = now();
      if (input.action === "reject") {
        database.prepare("UPDATE memory_proposals SET status = 'rejected', reviewed_at = ? WHERE id = ?").run(timestamp, row.id);
        audit(row.book_id, "proposal_rejected", row.id);
        return { ok: true, proposal: toProposal(proposalRow.get(row.id) as ProposalRow) };
      }

      const existing = database.prepare(`
        SELECT id, book_id, content, source, source_id, page, trust, created_at, confirmed_at, revoked_at
        FROM book_memories WHERE book_id = ? AND lower(content) = lower(?) AND revoked_at IS NULL LIMIT 1
      `).get(row.book_id, row.content) as MemoryRow | undefined;
      let memoryId = existing?.id ?? randomUUID();
      database.exec("BEGIN");
      try {
        if (!existing) {
          database.prepare(`
            INSERT INTO book_memories
              (id, book_id, content, source, source_id, page, trust, created_at, confirmed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(memoryId, row.book_id, row.content, row.source, row.source_id, row.page, row.provenance === "reader" || row.provenance === "pdf-evidence" ? "trusted" : "untrusted", row.created_at, timestamp);
          database.prepare("INSERT INTO memory_fts(memory_id, book_id, content) VALUES (?, ?, ?)").run(memoryId, row.book_id, row.content);
        }
        database.prepare("UPDATE memory_proposals SET status = 'approved', reviewed_at = ?, memory_id = ? WHERE id = ?").run(timestamp, memoryId, row.id);
        audit(row.book_id, "proposal_approved", row.id, memoryId, existing ? "deduplicated" : undefined);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return {
        ok: true,
        proposal: toProposal(proposalRow.get(row.id) as ProposalRow),
        memory: toMemory(activeMemoryRow.get(memoryId) as MemoryRow),
      };
    },

    revoke(memoryId: string, expectedBookId?: string): MemoryMutationResult {
      if (typeof memoryId !== "string" || memoryId.length === 0) {
        return { ok: false, code: "VALIDATION_ERROR", message: "记忆标识无效。" };
      }
      const row = activeMemoryRow.get(memoryId) as MemoryRow | undefined;
      if (!row) return { ok: false, code: "NOT_FOUND", message: "正式记忆不存在。" };
      if (expectedBookId !== undefined && row.book_id !== expectedBookId) return { ok: false, code: "NOT_FOUND", message: "正式记忆不存在。" };
      if (row.revoked_at) return { ok: false, code: "CONFLICT", message: "这条正式记忆已经撤销。" };
      const timestamp = now();
      database.prepare("UPDATE book_memories SET revoked_at = ? WHERE id = ?").run(timestamp, memoryId);
      database.prepare("DELETE FROM memory_fts WHERE memory_id = ?").run(memoryId);
      database.prepare("UPDATE memory_proposals SET status = 'revoked', reviewed_at = ? WHERE memory_id = ? AND status = 'approved'").run(timestamp, memoryId);
      audit(row.book_id, "memory_revoked", undefined, memoryId);
      return { ok: true, memory: toMemory(activeMemoryRow.get(memoryId) as MemoryRow) };
    },

    search(bookId: string, query: string, limit = 8): MemorySearchResult[] {
      const normalizedQuery = normalizeContent(query);
      if (!validBookId(bookId) || normalizedQuery.length === 0 || normalizedQuery.length > QUERY_MAX_LENGTH) return [];
      const words = normalizedQuery.toLocaleLowerCase().split(/\s+/).filter(Boolean);
      let rows: MemoryRow[] = [];
      try {
        rows = database.prepare(`
          SELECT m.id, m.book_id, m.content, m.source, m.source_id, m.page, m.trust, m.created_at, m.confirmed_at, m.revoked_at
          FROM memory_fts f JOIN book_memories m ON m.id = f.memory_id
          WHERE f.book_id = ? AND f.content MATCH ? AND m.revoked_at IS NULL
          ORDER BY bm25(memory_fts), m.confirmed_at DESC
          LIMIT ?
        `).all(bookId, normalizedQuery, Math.max(1, Math.min(20, limit))) as MemoryRow[];
      } catch { /* 特殊查询或中文分词失败时使用 LIKE 降级 */ }
      if (rows.length === 0) {
        rows = database.prepare(`
          SELECT id, book_id, content, source, source_id, page, trust, created_at, confirmed_at, revoked_at
          FROM book_memories WHERE book_id = ? AND revoked_at IS NULL
        `).all(bookId) as MemoryRow[];
      }
      return rows.map((row) => {
        const haystack = row.content.toLocaleLowerCase();
        const score = words.reduce((total, word) => total + (haystack.includes(word) ? 1 : 0), 0)
          + (haystack.includes(normalizedQuery.toLocaleLowerCase()) ? 1 : 0);
        return { ...toMemory(row), score };
      }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt)).slice(0, Math.max(1, Math.min(20, limit)));
    },

    close() {
      database.close();
    },
  };
}

export type MemoryModule = ReturnType<typeof createMemoryModule>;
