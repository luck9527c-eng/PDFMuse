import { constants } from "node:fs";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  rename,
  statfs,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  EMPTY_APP_CONFIG,
  parseAppConfig,
  writeAppConfig,
} from "./config-store.js";
import type { StartupPreflight } from "../shared/contracts.js";

const MINIMUM_FREE_BYTES = 256 * 1024 * 1024;
const DATA_DIRECTORIES = ["logs", "cache", "books"];
const DEFAULT_READER_PROFILE = `# 读者画像

## 语言

- 默认使用中文回答。

## 解释偏好

- 技术概念需要澄清时，优先使用具体示例。
`;

async function verifyWritable(directory: string) {
  const probePath = path.join(directory, `.pdfmuse-write-probe-${process.pid}`);
  await writeFile(probePath, "pdfmuse", { flag: "wx" });
  await unlink(probePath);
}

async function hasOcrResources(applicationDirectory: string) {
  const worker = path.join(applicationDirectory, "resources", "ocr-worker", "paddleocr_worker.py");
  const runtime = path.join(applicationDirectory, "resources", "ocr-runtime", process.platform === "win32" ? "python.exe" : "python");
  const models = path.join(applicationDirectory, "resources", "ocr-models");
  const manifestPath = path.join(applicationDirectory, "resources", "ocr-manifest.json");

  try {
    await Promise.all([access(worker, constants.R_OK), access(runtime, constants.X_OK), access(models, constants.R_OK)]);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { engine?: string; engineVersion?: string; model?: string; files?: Array<{ path?: string; sha256?: string }> };
    if (manifest.engine !== "PaddleOCR" || manifest.model !== "PP-OCRv5" || !Array.isArray(manifest.files)) return false;
    for (const entry of manifest.files) {
      if (!entry.path || !entry.sha256) return false;
      const target = path.join(applicationDirectory, "resources", entry.path);
      await access(target, constants.R_OK);
      // File hashes are checked for files; model directories are existence-checked and hashed by the release pipeline.
      try {
        const bytes = await readFile(target);
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (digest !== entry.sha256) return false;
      } catch {
        // Directories are validated by access above; the installer manifest owns their recursive hash.
      }
    }
    return true;
  } catch {
    return false;
  }
}

export async function preflightDataHome(applicationDirectory: string): Promise<StartupPreflight> {
  const dataHome = path.join(applicationDirectory, "data");
  const warnings: string[] = [];

  try {
    await verifyWritable(applicationDirectory);
  } catch (error) {
    return {
      ok: false,
      dataHome,
      code: "APPLICATION_DIRECTORY_NOT_WRITABLE",
      message: `PDFMuse 无法写入程序所在目录：${String(error)}`,
    };
  }

  try {
    await mkdir(dataHome, { recursive: true });
    await verifyWritable(dataHome);
  } catch (error) {
    return {
      ok: false,
      dataHome,
      code: "DATA_HOME_NOT_WRITABLE",
      message: `PDFMuse 无法创建或写入数据目录：${String(error)}`,
    };
  }

  const configPath = path.join(dataHome, "config.json");
  try {
    const config = await readFile(configPath, "utf8");
    const parsed = parseAppConfig(config, { allowLegacyVersion: true });
    if (parsed.migrated) await writeAppConfig(configPath, parsed.config);
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    if (missing) {
      await writeAppConfig(configPath, EMPTY_APP_CONFIG);
    } else {
      const backupName = `config.invalid-${Date.now()}-${process.pid}.json`;
      await rename(configPath, path.join(dataHome, backupName));
      await writeAppConfig(configPath, EMPTY_APP_CONFIG);
      warnings.push(`损坏的配置文件已备份为 ${backupName}，请重新配置模型连接。`);
    }
  }

  const disk = await statfs(dataHome);
  if (disk.bavail * disk.bsize < MINIMUM_FREE_BYTES) {
    return {
      ok: false,
      dataHome,
      code: "INSUFFICIENT_DISK_SPACE",
      message: "PDFMuse 至少需要 256 MB 可用空间才能安全启动。",
    };
  }

  await Promise.all(DATA_DIRECTORIES.map((directory) => mkdir(path.join(dataHome, directory), { recursive: true })));
  await writeFile(path.join(dataHome, "READER_PROFILE.md"), DEFAULT_READER_PROFILE, {
    encoding: "utf8",
    flag: "wx",
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });

  if (!(await hasOcrResources(applicationDirectory))) {
    warnings.push("尚未安装 OCR 工作进程资源。");
  }

  return { ok: true, dataHome, warnings };
}
