import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createReaderProfileModule } from "./reader-profile.js";

describe("reader profile module", () => {
  let dataHome: string;

  beforeEach(async () => {
    dataHome = await mkdtemp(path.join(os.tmpdir(), "pdfmuse-profile-"));
  });

  afterEach(async () => {
    await rm(dataHome, { recursive: true, force: true });
  });

  it("returns an empty profile before first save", async () => {
    const module = createReaderProfileModule(dataHome);
    expect(await module.get()).toEqual({ content: "" });
  });

  it("saves and reloads trimmed content with a timestamp", async () => {
    const module = createReaderProfileModule(dataHome);
    const result = await module.save({ content: "  我是工程师，偏好先结论后展开。  " });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.content).toBe("我是工程师，偏好先结论后展开。");
    expect(result.profile.updatedAt).toBeTruthy();

    const reloaded = await createReaderProfileModule(dataHome).get();
    expect(reloaded.content).toBe("我是工程师，偏好先结论后展开。");
    expect(reloaded.updatedAt).toBe(result.profile.updatedAt);
  });

  it("rejects oversized or invalid input", async () => {
    const module = createReaderProfileModule(dataHome);
    expect((await module.save({ content: "x".repeat(4_001) })).ok).toBe(false);
    expect((await module.save(null)).ok).toBe(false);
    expect((await module.save({ content: 42 as unknown as string })).ok).toBe(false);
  });

  it("keeps a damaged profile file untouched and behaves as empty", async () => {
    const profilePath = path.join(dataHome, "reader-profile.json");
    await writeFile(profilePath, "{ not json", "utf8");
    const module = createReaderProfileModule(dataHome);
    expect(await module.get()).toEqual({ content: "" });
    expect(await readFile(profilePath, "utf8")).toBe("{ not json");
    const saved = await module.save({ content: "修复后的偏好" });
    expect(saved.ok).toBe(true);
    expect(await createReaderProfileModule(dataHome).get()).toEqual({
      content: "修复后的偏好",
      updatedAt: (saved as { profile: { updatedAt: string } }).profile.updatedAt,
    });
  });
});
