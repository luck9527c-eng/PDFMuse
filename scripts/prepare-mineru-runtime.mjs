import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { applyDocvortexScriptConflictPatch } from "./lib/docvortex-patch.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resourcesRoot = path.join(projectRoot, "resources");
const tmpRoot = path.join(projectRoot, "tmp");
const downloadRoot = path.join(tmpRoot, "ocr-runtime-downloads");
const archivePath = path.join(downloadRoot, "python-3.11.9-embed-amd64.zip");
const staging = path.join(tmpRoot, "mineru-runtime-staging");
const runtime = path.join(resourcesRoot, "mineru-runtime");
const backup = path.join(tmpRoot, "mineru-runtime-backup");
const worker = path.join(resourcesRoot, "mineru-worker", "mineru_worker.py");
const lockfile = path.join(resourcesRoot, "mineru-requirements.lock");
const manifestPath = path.join(resourcesRoot, "mineru-manifest.json");
const pythonUrl = "https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip";
const pythonSha256 = "009d6bf7e3b2ddca3d784fa09f90fe54336d5b60f0e0f305c37f400bf83cfd3b";
const mineruHome = path.join(staging, "home");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
    encoding: "utf8",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} 执行失败，退出码 ${result.status ?? "未知"}。`);
}

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: projectRoot, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || capture("git", ["config", "--get", "https.proxy"]);
const proxyEnv = proxy ? { HTTPS_PROXY: proxy, HTTP_PROXY: proxy } : {};

function runPython(code, ...args) {
  run(path.join(staging, "python.exe"), ["-B", "-c", code, ...args], {
    env: {
      ...process.env,
      ...proxyEnv,
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONUTF8: "1",
      MINERU_HOME: mineruHome,
      MINERU_MODEL_SOURCE: "modelscope",
      HF_HOME: path.join(mineruHome, "hf-cache"),
    },
  });
}

async function hashFile(filePath, hash = createHash("sha256")) {
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash;
}

async function digestFile(filePath) {
  return (await hashFile(filePath)).digest("hex");
}

async function listFiles(directory, relative = "") {
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    // 字节码是派生缓存：不参与哈希，避免运行期写入导致清单永久性误报。
    if (entry.name === "__pycache__" && entry.isDirectory()) continue;
    if (entry.isDirectory()) files.push(...await listFiles(directory, child));
    else if (entry.isFile()) {
      if (entry.name.endsWith(".pyc")) continue;
      files.push(child);
    } else throw new Error(`MinerU 资源包含不支持的文件类型：${child}`);
  }
  return files;
}

async function removeBytecode(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name === "__pycache__") await rm(target, { recursive: true, force: true });
    else if (entry.isDirectory()) await removeBytecode(target);
    else if (entry.isFile() && entry.name.endsWith(".pyc")) await rm(target, { force: true });
  }
}

async function digestResource(target) {
  const info = await stat(target);
  if (info.isFile()) return digestFile(target);
  const hash = createHash("sha256");
  for (const file of (await listFiles(target)).sort((left, right) => left.localeCompare(right, "en"))) {
    if (path.basename(file) === ".gitkeep") continue;
    hash.update(file.split(path.sep).join("/"));
    hash.update("\0");
    await hashFile(path.join(target, file), hash);
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function ensurePythonArchive() {
  await mkdir(downloadRoot, { recursive: true });
  try {
    if (await digestFile(archivePath) === pythonSha256) return;
  } catch {
    // 缺失或损坏的压缩包在下方重新下载。
  }
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || "";
  const args = ["--fail", "--location", "--output", archivePath];
  if (proxy) args.push("--proxy", proxy);
  args.push(pythonUrl);
  console.log("正在下载固定版本 Python 运行时...");
  run("curl.exe", args);
  if (await digestFile(archivePath) !== pythonSha256) throw new Error("Python 运行时哈希校验失败。");
}

async function replaceRuntime() {
  await rm(backup, { recursive: true, force: true });
  let hadRuntime = false;
  try {
    await access(runtime);
    await rename(runtime, backup);
    hadRuntime = true;
  } catch {
    // 全新检出没有旧运行时，属正常情况。
  }
  try {
    await rename(staging, runtime);
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (hadRuntime) await rename(backup, runtime).catch(() => undefined);
    throw error;
  }
}

if (process.platform !== "win32") throw new Error("MinerU 便携运行时当前只支持 Windows x64 构建。");
await Promise.all([access(worker), access(lockfile)]);
await ensurePythonArchive();
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
run("powershell.exe", ["-NoProfile", "-Command", "Expand-Archive", "-LiteralPath", archivePath, "-DestinationPath", staging, "-Force"]);

const pthPath = path.join(staging, "python311._pth");
let pth = await readFile(pthPath, "utf8");
pth = pth.replace(/^#import site$/m, "import site");
if (!pth.split(/\r?\n/).includes("Lib/site-packages")) pth = `${pth.trimEnd()}\nLib/site-packages\n`;
await writeFile(pthPath, pth, "utf8");
const sitePackages = path.join(staging, "Lib", "site-packages");
await mkdir(sitePackages, { recursive: true });
console.log("正在安装哈希锁定的 MinerU basic 档依赖...");
run("uv", [
  "pip", "install",
  "--target", sitePackages,
  "--link-mode", "copy",
  "--require-hashes",
  "--python-version", "3.11",
  "--python-platform", "windows",
  "--only-binary", ":all:",
  "--no-binary", "jieba",
  "--index-url", "https://pypi.org/simple",
  "-r", lockfile,
], { env: { ...process.env, ...proxyEnv } });

// 构建期打 docvortex 上下标冲突补丁（T65）：必须在导入验证之前——校验随 import 固化。
// 补丁后的 schema.py 参与清单哈希，manifest 记录补丁状态；worker 启动只读校验。
console.log("正在修补 docvortex 上下标冲突校验（构建期）...");
const docvortexPatch = await applyDocvortexScriptConflictPatch(sitePackages);
if (docvortexPatch.state === "unrecognized") {
  console.warn("警告：docvortex schema.py 与已知模式均不匹配，补丁未应用——数学页（双上下标公式）可能整页解析失败，请人工核对上游变更后更新补丁模式。");
}
console.log(`docvortex 补丁状态：${docvortexPatch.state}`);

console.log("正在验证 MinerU 导入...");
runPython("from mineru.parser.mineru_parser import MinerUParser; import mineru; print('mineru', mineru.version.__version__)");

console.log("正在下载 MinerU basic 档模型（ModelScope，约 0.8 GB）...");
runPython(`
import sys
sys.argv = ["mineru-models-download", "--tier", "basic", "--source", "modelscope"]
from mineru.kit.commands.models import download_main
download_main()
`);

console.log("正在做单页解析冒烟验证...");
runPython(`
import json, sys
from mineru.parser.mineru_parser import MinerUParser

parser = MinerUParser(tier="basic", parse_mode="auto")
result = parser.parse(sys.argv[1], page_range="1")
content = result.structured_content()
sample = {
    "pages": len(result.pages),
    "item_keys": sorted(content.keys()) if isinstance(content, dict) else type(content).__name__,
    "items_head": (content.get("items") if isinstance(content, dict) else None) or [],
}
with open(sys.argv[2], "w", encoding="utf8") as fh:
    json.dump(sample, fh, ensure_ascii=False, default=str)
print("introspection written")
`, path.join(projectRoot, "docs", "extracted.pdf"), path.join(projectRoot, "tmp", "mineru-smoke-introspect.json"));

await removeBytecode(staging);
await replaceRuntime();

const manifest = {
  schemaVersion: 1,
  engine: "MinerU",
  engineVersion: "4.0.2",
  runtime: "Python 3.11.9 + ONNX Runtime (MinerU basic)",
  model: "basic",
  patches: { docvortexScriptConflict: docvortexPatch.state },
  files: await Promise.all(["mineru-runtime", "mineru-worker/mineru_worker.py"].map(async (resourcePath) => ({
    path: resourcePath,
    sha256: await digestResource(path.join(resourcesRoot, resourcePath)),
  }))),
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log("MinerU 离线运行时已准备完成，并已刷新资源清单。");
