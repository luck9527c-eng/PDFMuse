import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resourcesRoot = path.join(projectRoot, "resources");
const tmpRoot = path.join(projectRoot, "tmp");
const downloadRoot = path.join(tmpRoot, "ocr-runtime-downloads");
const archivePath = path.join(downloadRoot, "python-3.11.9-embed-amd64.zip");
const staging = path.join(tmpRoot, "rapidocr-runtime-staging");
const runtime = path.join(resourcesRoot, "ocr-runtime");
const backup = path.join(tmpRoot, "ocr-runtime-backup");
const worker = path.join(resourcesRoot, "ocr-worker", "rapidocr_worker.py");
const lockfile = path.join(resourcesRoot, "ocr-requirements.lock");
const manifestPath = path.join(resourcesRoot, "ocr-manifest.json");
const pythonUrl = "https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip";
const pythonSha256 = "009d6bf7e3b2ddca3d784fa09f90fe54336d5b60f0e0f305c37f400bf83cfd3b";

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
    if (entry.isDirectory()) files.push(...await listFiles(directory, child));
    else if (entry.isFile()) files.push(child);
    else throw new Error(`OCR 资源包含不支持的文件类型：${child}`);
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
    // Missing or invalid archives are replaced below.
  }
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || capture("git", ["config", "--get", "https.proxy"]);
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
    // A missing existing runtime is expected on a clean checkout.
  }
  try {
    await rename(staging, runtime);
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (hadRuntime) await rename(backup, runtime).catch(() => undefined);
    throw error;
  }
}

if (process.platform !== "win32") throw new Error("OCR 便携运行时当前只支持 Windows x64 构建。");
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
console.log("正在安装哈希锁定的 RapidOCR/ONNX Runtime 依赖...");
run("uv", [
  "pip", "install",
  "--target", sitePackages,
  "--link-mode", "copy",
  "--require-hashes",
  "--python-version", "3.11",
  "--python-platform", "windows",
  "--only-binary", ":all:",
  "--no-binary", "antlr4-python3-runtime",
  "--index-url", "https://pypi.org/simple",
  "-r", lockfile,
]);

run(path.join(staging, "python.exe"), ["-B", "-c", "from rapidocr import RapidOCR; import onnxruntime; RapidOCR(params={'Global.log_level':'error'}); print(onnxruntime.__version__)"], {
  env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
});
await removeBytecode(staging);
await replaceRuntime();

const manifest = {
  schemaVersion: 1,
  engine: "RapidOCR",
  engineVersion: "3.9.2-onnxruntime1.29.0-r1",
  runtime: "Python 3.11.9 + ONNX Runtime 1.29.0",
  model: "PP-OCRv6-small",
  files: await Promise.all(["ocr-runtime", "ocr-worker/rapidocr_worker.py"].map(async (resourcePath) => ({
    path: resourcePath,
    sha256: await digestResource(path.join(resourcesRoot, resourcePath)),
  }))),
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log("RapidOCR 离线运行时已准备完成，并已刷新资源清单。");
