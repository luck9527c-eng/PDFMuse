import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openPdfMuseDatabase } from "./database.js";

describe("openPdfMuseDatabase", () => {
  let dataHome: string;

  beforeEach(async () => {
    dataHome = await mkdtemp(path.join(os.tmpdir(), "pdfmuse-db-"));
  });

  afterEach(async () => {
    await rm(dataHome, { recursive: true, force: true });
  });

  it("统一设置 WAL、busy_timeout 与 foreign_keys", () => {
    const database = openPdfMuseDatabase(dataHome);
    expect((database.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
    expect((database.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(5000);
    expect((database.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
    database.close();
  });

  it("同一文件的多条连接各自带齐 pragma（busy_timeout/foreign_keys 是连接级设置）", () => {
    const first = openPdfMuseDatabase(dataHome);
    const second = openPdfMuseDatabase(dataHome);
    for (const database of [first, second]) {
      expect((database.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
      expect((database.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(5000);
      expect((database.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
    }
    first.close();
    second.close();
  });

  it("打开的是 dataHome 下的 pdfmuse.db", () => {
    const database = openPdfMuseDatabase(dataHome);
    expect((database.prepare("PRAGMA database_list").get() as { file: string }).file)
      .toBe(path.join(dataHome, "pdfmuse.db"));
    database.close();
  });
});
