import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// 构建期补丁模块是裸 Node ESM（prepare:mineru 直接跑源码），无类型声明——测试经动态 import 消费。
// @ts-expect-error JS 模块无 .d.mts
const { applyDocvortexScriptConflictPatch } = await import("../../scripts/lib/docvortex-patch.mjs") as {
  applyDocvortexScriptConflictPatch(sitePackagesDir: string): Promise<{ state: string; schemaPath: string }>;
};

// 伪 docvortex 包里的「原文」片段——与 docvortex 0.4.12 的 TextSpan 校验器逐字一致
// （与 mineru-worker-patch.test.ts 同款哨兵：上游漂移时两处测试同时提醒核对）。
const ORIGINAL_VALIDATOR = [
  "        unique = set(value)",
  '        if "superscript" in unique and "subscript" in unique:',
  '            raise ValueError("text span cannot be both superscript and subscript")',
  "        return [style for style in INLINE_STYLE_ORDER if style in unique]",
].join("\n");
const PATCHED_VALIDATOR = [
  "        unique = set(value)",
  '        if "superscript" in unique:',
  '            unique.discard("subscript")',
  "        return [style for style in INLINE_STYLE_ORDER if style in unique]",
].join("\n");

describe("applyDocvortexScriptConflictPatch（构建期补丁，T65）", () => {
  const tempDirs: string[] = [];

  async function makeSitePackages(schemaBody?: string) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pdfmuse-docvortex-build-"));
    tempDirs.push(dir);
    if (schemaBody !== undefined) {
      await mkdir(path.join(dir, "docvortex"), { recursive: true });
      await writeFile(path.join(dir, "docvortex", "schema.py"), schemaBody, "utf8");
    }
    return dir;
  }

  afterAll(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("原文在：改写校验器（丢弃 subscript）、幂等重跑零改写", async () => {
    const dir = await makeSitePackages(`SCHEMA_HEAD = "docvortex fake"\n\n\ndef _normalize_styles(value):\n${ORIGINAL_VALIDATOR}\n`);
    const first = await applyDocvortexScriptConflictPatch(dir);
    expect(first.state).toBe("applied");
    const patched = await readFile(path.join(dir, "docvortex", "schema.py"), "utf8");
    expect(patched).toContain(PATCHED_VALIDATOR);
    expect(patched).not.toContain("raise ValueError");

    const second = await applyDocvortexScriptConflictPatch(dir);
    expect(second.state).toBe("already-patched");
    await expect(readFile(path.join(dir, "docvortex", "schema.py"), "utf8")).resolves.toBe(patched);
  });

  it("CRLF 读入同样命中并整体落为 LF", async () => {
    const crlf = `def _normalize_styles(value):\n${ORIGINAL_VALIDATOR}\n`.replace(/\r?\n/g, "\r\n");
    const dir = await makeSitePackages(crlf);
    const result = await applyDocvortexScriptConflictPatch(dir);
    expect(result.state).toBe("applied");
    const written = await readFile(path.join(dir, "docvortex", "schema.py"), "utf8");
    expect(written).toContain(PATCHED_VALIDATOR);
    expect(written).not.toContain("\r");
  });

  it("上游已改：两种模式都不在时原样跳过（unrecognized）", async () => {
    const dir = await makeSitePackages('STYLES = "upstream changed"\n');
    const result = await applyDocvortexScriptConflictPatch(dir);
    expect(result.state).toBe("unrecognized");
    await expect(readFile(path.join(dir, "docvortex", "schema.py"), "utf8")).resolves.toBe('STYLES = "upstream changed"\n');
  });

  it("docvortex 包缺失：absent，不抛错", async () => {
    const dir = await makeSitePackages();
    await expect(applyDocvortexScriptConflictPatch(dir)).resolves.toMatchObject({ state: "absent" });
  });
});
