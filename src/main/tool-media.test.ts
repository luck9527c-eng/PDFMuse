import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createToolMedia } from "./tool-media.js";

const BOOK_ID = "a".repeat(64);
const OTHER_BOOK_ID = "b".repeat(64);
const PNG_BASE64 = Buffer.from("png-bytes").toString("base64");

describe("tool media", () => {
  let dataHome: string;
  let media: ReturnType<typeof createToolMedia>;

  beforeEach(async () => {
    dataHome = await mkdtemp(path.join(os.tmpdir(), "pdfmuse-media-"));
    media = createToolMedia(dataHome);
  });

  afterEach(async () => {
    await rm(dataHome, { recursive: true, force: true });
  });

  it("saves page images under the book media directory and returns the relative path", async () => {
    const saved = await media.savePageImage(BOOK_ID, 3, PNG_BASE64);

    expect(saved.relativePath).toBe(`${BOOK_ID}/${path.basename(saved.relativePath)}`);
    expect(path.basename(saved.relativePath).startsWith("p3-")).toBe(true);
    const stored = await readFile(path.join(dataHome, "media", saved.relativePath));
    expect(stored.toString("base64")).toBe(PNG_BASE64);
  });

  it("keeps books isolated and removes a book's media directory on book data deletion", async () => {
    await media.savePageImage(BOOK_ID, 1, PNG_BASE64);
    await media.savePageImage(OTHER_BOOK_ID, 2, PNG_BASE64);

    await media.deleteBookData(BOOK_ID);

    const mediaRoot = path.join(dataHome, "media");
    expect(await readdir(mediaRoot)).toEqual([OTHER_BOOK_ID]);
    expect(await readdir(path.join(mediaRoot, OTHER_BOOK_ID))).toHaveLength(1);
    // 重复删除（目录已不存在）不抛错。
    await expect(media.deleteBookData(BOOK_ID)).resolves.toBeUndefined();
  });
});
