import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const workerPath = path.resolve(import.meta.dirname, "../../resources/mineru-worker/mineru_worker.py");
const runtimePython = path.resolve(import.meta.dirname, "../../resources/mineru-runtime/python.exe");
const runtimeSchema = path.resolve(import.meta.dirname, "../../resources/mineru-runtime/Lib/site-packages/docvortex/schema.py");
// 钉版 runtime 不随仓库分发：无 runtime 的环境（CI 等）跳过，不打红全量。
const runtimeAvailable = existsSync(runtimePython);

// 伪 docvortex 包里的「原文」片段——与 docvortex 0.4.12 的 TextSpan 校验器逐字一致。
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

/** 以指定 package_dir 调 worker 的补丁函数（复用其注入缝，不跑 main）。 */
function runPatch(packageDir: string) {
  execFileSync(runtimePython, [
    "-c",
    [
      "import importlib.util, sys",
      `spec = importlib.util.spec_from_file_location("mineru_worker", sys.argv[1])`,
      "mod = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(mod)",
      "mod.patch_docvortex_script_conflict(package_dir=sys.argv[2])",
    ].join("\n"),
    workerPath,
    packageDir,
  ], { stdio: ["ignore", "ignore", "pipe"] });
}

describe.skipIf(!runtimeAvailable)("mineru worker docvortex patch", () => {
  const tempDirs: string[] = [];

  async function makeFakePackage(schemaBody: string) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pdfmuse-docvortex-"));
    tempDirs.push(dir);
    await writeFile(path.join(dir, "schema.py"), schemaBody, "utf-8");
    return dir;
  }

  afterAll(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("rewrites the conflicting validator, stays idempotent, and leaves unknown schemas untouched", async () => {
    const schemaBody = `SCHEMA_HEAD = "docvortex fake"\n\n\ndef _normalize_styles(value):\n${ORIGINAL_VALIDATOR}\n`;
    const dir = await makeFakePackage(schemaBody);
    const schemaPath = path.join(dir, "schema.py");

    runPatch(dir);
    const patched = await readFile(schemaPath, "utf-8");
    expect(patched).toContain(PATCHED_VALIDATOR);
    expect(patched).not.toContain("raise ValueError");

    // 已打过：再次运行不改文件、不报错。
    runPatch(dir);
    await expect(readFile(schemaPath, "utf-8")).resolves.toBe(patched);

    // 上游已改（两种模式都不在）：原样跳过。
    const unknownDir = await makeFakePackage("STYLES = \"upstream changed\"\n");
    runPatch(unknownDir);
    await expect(readFile(path.join(unknownDir, "schema.py"), "utf-8")).resolves.toBe("STYLES = \"upstream changed\"\n");
  });

  it("keeps matching the shipped runtime schema (original or already patched)", async () => {
    // 哨兵：钉版 runtime 升级后若两种模式都不匹配，说明上游改了校验器——
    // 届时补丁自然失效（跳过），此测试提醒重新核对而非静默漂移。
    const source = await readFile(runtimeSchema, "utf-8");
    const recognized = source.includes(ORIGINAL_VALIDATOR) || source.includes(PATCHED_VALIDATOR);
    expect(recognized).toBe(true);
  });
});
