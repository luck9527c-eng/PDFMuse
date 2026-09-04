import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
      warnings: [],
    });
    await expect(readFile(path.join(result.dataHome, "READER_PROFILE.md"), "utf8")).resolves.toContain(
      "# 读者画像",
    );
  });

  it("备份损坏配置并让 Reader 重新配置 Model Connection", async () => {
    const applicationDirectory = await createWorkspace();
    const dataHome = path.join(applicationDirectory, "data");
    await writeFile(path.join(applicationDirectory, "keep.txt"), "source");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(dataHome));
    await writeFile(path.join(dataHome, "config.json"), "{not-json", "utf8");

    const result = await preflightDataHome(applicationDirectory);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toContainEqual(expect.stringContaining("损坏的配置文件已备份"));
    }
    await expect(readFile(path.join(dataHome, "config.json"), "utf8")).resolves.toBe(
      '{\n  "version": 2\n}\n',
    );
    const backup = (await readdir(dataHome)).find((name) => name.startsWith("config.invalid-") && name.endsWith(".json"));
    expect(backup).toBeDefined();
    await expect(readFile(path.join(dataHome, backup!), "utf8")).resolves.toBe("{not-json");
  });

  it("将字段类型错误的 JSON 配置视为损坏", async () => {
    const applicationDirectory = await createWorkspace();
    const dataHome = path.join(applicationDirectory, "data");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(dataHome));
    const invalidConfig = '{"version":1,"chat":{"baseUrl":42,"model":"test"}}';
    await writeFile(path.join(dataHome, "config.json"), invalidConfig, "utf8");

    const result = await preflightDataHome(applicationDirectory);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toContainEqual(expect.stringContaining("损坏的配置文件已备份"));
    }
    const backup = (await readdir(dataHome)).find((name) => name.startsWith("config.invalid-") && name.endsWith(".json"));
    expect(backup).toBeDefined();
    await expect(readFile(path.join(dataHome, backup!), "utf8")).resolves.toBe(invalidConfig);
  });

  it("使用原子替换为旧配置补充显式版本", async () => {
    const applicationDirectory = await createWorkspace();
    const dataHome = path.join(applicationDirectory, "data");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(dataHome));
    await writeFile(
      path.join(dataHome, "config.json"),
      '{"version":1,"chat":{"baseUrl":"https://api.example.com/v1","model":"test-model"}}',
      "utf8",
    );

    const result = await preflightDataHome(applicationDirectory);

    expect(result.ok).toBe(true);
    const migrated = JSON.parse(await readFile(path.join(dataHome, "config.json"), "utf8"));
    expect(migrated).toEqual({
      version: 2,
      chat: {
        baseUrl: "https://api.example.com/v1",
        model: "test-model",
        protocol: "openai",
      },
    });
    expect(await readdir(dataHome)).not.toContainEqual(expect.stringMatching(/\.tmp$/));
  });

  it("将缺少协议的当前版本配置视为损坏", async () => {
    const applicationDirectory = await createWorkspace();
    const dataHome = path.join(applicationDirectory, "data");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(dataHome));
    const invalidConfig = '{"version":2,"chat":{"baseUrl":"https://api.example.com/v1","model":"test-model"}}';
    await writeFile(path.join(dataHome, "config.json"), invalidConfig, "utf8");

    const result = await preflightDataHome(applicationDirectory);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toContainEqual(expect.stringContaining("损坏的配置文件已备份"));
    }
    const backup = (await readdir(dataHome)).find((name) => name.startsWith("config.invalid-"));
    expect(backup).toBeDefined();
    await expect(readFile(path.join(dataHome, backup!), "utf8")).resolves.toBe(invalidConfig);
  });
});
