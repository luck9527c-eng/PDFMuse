import { constants } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  statfs,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

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
  const worker = path.join(applicationDirectory, "resources", "ocr-worker");
  const models = path.join(applicationDirectory, "resources", "ocr-models");

  try {
    await Promise.all([access(worker, constants.R_OK), access(models, constants.R_OK)]);
    return true;
  } catch {
    return false;
  }
}

export async function preflightDataHome(applicationDirectory: string): Promise<StartupPreflight> {
  const dataHome = path.join(applicationDirectory, "data");

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
    JSON.parse(config);
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    if (!missing) {
      return {
        ok: false,
        dataHome,
        code: "INVALID_CONFIG",
        message: "现有的 data/config.json 不是有效的 JSON 文件。",
      };
    }
    await writeFile(configPath, "{}\n", { encoding: "utf8", flag: "wx" });
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

  const warnings = (await hasOcrResources(applicationDirectory))
    ? []
    : ["尚未安装 OCR 工作进程资源。"];

  return { ok: true, dataHome, warnings };
}
