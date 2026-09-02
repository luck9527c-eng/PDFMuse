import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { preflightDataHome } from "./data-home.js";

const workspaces: string[] = [];

async function createWorkspace() {
  const workspace = await mkdtemp(path.join(tmpdir(), "pdfmuse-data-home-"));
  workspaces.push(workspace);
  return workspace;
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => rm(workspace, { recursive: true })));
});

describe("preflightDataHome", () => {
  it("creates the complete portable data root beside the application", async () => {
    const applicationDirectory = await createWorkspace();

    const result = await preflightDataHome(applicationDirectory);

    expect(result).toEqual({
      ok: true,
      dataHome: path.join(applicationDirectory, "data"),
      warnings: ["尚未安装 OCR 工作进程资源。"],
    });
    await expect(readFile(path.join(result.dataHome, "READER_PROFILE.md"), "utf8")).resolves.toContain(
      "# 读者画像",
    );
  });

  it("reports a damaged configuration without overwriting it", async () => {
    const applicationDirectory = await createWorkspace();
    const dataHome = path.join(applicationDirectory, "data");
    await writeFile(path.join(applicationDirectory, "keep.txt"), "source");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(dataHome));
    await writeFile(path.join(dataHome, "config.json"), "{not-json", "utf8");

    const result = await preflightDataHome(applicationDirectory);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_CONFIG");
      expect(result.dataHome).toBe(dataHome);
    }
    await expect(readFile(path.join(dataHome, "config.json"), "utf8")).resolves.toBe("{not-json");
  });
});
