import { describe, expect, it, vi } from "vitest";

import { scheduleEmbeddingJobIfConfigured } from "./embedding-job-scheduler.js";

const BOOK_ID = "a".repeat(64);

describe("optional embedding job scheduling", () => {
  it("does not create a failed semantic job when embedding is not configured", async () => {
    const schedule = vi.fn();

    await expect(scheduleEmbeddingJobIfConfigured(
      { bookId: BOOK_ID, total: 12, priority: 5 },
      { loadConfig: async () => ({ version: 2 }), schedule },
    )).resolves.toBe(false);

    expect(schedule).not.toHaveBeenCalled();
  });

  it("schedules semantic indexing when embedding is configured", async () => {
    const schedule = vi.fn();

    await expect(scheduleEmbeddingJobIfConfigured(
      { bookId: BOOK_ID, total: 12, priority: 5 },
      {
        loadConfig: async () => ({
          version: 2,
          embedding: { baseUrl: "https://embedding.example.com/v1", model: "text-embedding" },
        }),
        schedule,
      },
    )).resolves.toBe(true);

    expect(schedule).toHaveBeenCalledOnce();
    expect(schedule).toHaveBeenCalledWith({
      bookId: BOOK_ID,
      kind: "embedding",
      priority: 5,
      total: 12,
    });
  });

  it("keeps OCR successful when optional configuration cannot be read", async () => {
    const schedule = vi.fn();
    const reportError = vi.fn();

    await expect(scheduleEmbeddingJobIfConfigured(
      { bookId: BOOK_ID, total: 12, priority: 5 },
      {
        loadConfig: async () => { throw new Error("invalid config"); },
        schedule,
        reportError,
      },
    )).resolves.toBe(false);

    expect(schedule).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith("读取嵌入模型配置失败，已跳过语义索引。", expect.any(Error));
  });
});
