import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ReaderProfileState, SaveReaderProfileInput, SaveReaderProfileResult } from "../shared/contracts.js";

/** Reader Profile 是跨书籍的全局学习背景与解释偏好，只能由 Reader 修改。 */
const CONTENT_MAX_LENGTH = 4_000;

type StoredReaderProfile = {
  version: 1;
  content: string;
  updatedAt?: string;
};

const EMPTY_PROFILE: StoredReaderProfile = { version: 1, content: "", updatedAt: "" };

function toState(profile: StoredReaderProfile): ReaderProfileState {
  return {
    content: profile.content,
    ...(profile.updatedAt ? { updatedAt: profile.updatedAt } : {}),
  };
}

export function createReaderProfileModule(dataHome: string) {
  const profilePath = path.join(dataHome, "reader-profile.json");

  async function readProfile(): Promise<StoredReaderProfile> {
    try {
      const parsed: unknown = JSON.parse(await readFile(profilePath, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new SyntaxError();
      const record = parsed as Record<string, unknown>;
      if (record.version !== 1
        || typeof record.content !== "string"
        || (record.updatedAt !== undefined && typeof record.updatedAt !== "string")) {
        throw new SyntaxError();
      }
      return {
        version: 1,
        content: record.content,
        ...(typeof record.updatedAt === "string" ? { updatedAt: record.updatedAt } : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_PROFILE;
      // 损坏的 Profile 视为空配置；不覆盖原文件，Reader 保存时才会重写。
      return EMPTY_PROFILE;
    }
  }

  return {
    async get(): Promise<ReaderProfileState> {
      return toState(await readProfile());
    },

    async save(input: unknown): Promise<SaveReaderProfileResult> {
      if (typeof input !== "object" || input === null || Array.isArray(input)
        || typeof (input as Record<string, unknown>).content !== "string") {
        return {
          ok: false,
          code: "VALIDATION_ERROR",
          message: "阅读偏好内容无效。",
        };
      }
      const content = (input as { content: string }).content;
      if (content.length > CONTENT_MAX_LENGTH) {
        return {
          ok: false,
          code: "VALIDATION_ERROR",
          message: `阅读偏好不能超过 ${CONTENT_MAX_LENGTH} 个字符。`,
        };
      }
      const profile: StoredReaderProfile = {
        version: 1,
        content: content.trim(),
        updatedAt: new Date().toISOString(),
      };
      const temporaryPath = path.join(
        path.dirname(profilePath),
        `.${path.basename(profilePath)}.${process.pid}.${randomUUID()}.tmp`,
      );
      try {
        await writeFile(temporaryPath, `${JSON.stringify(profile, null, 2)}\n`, {
          encoding: "utf8",
          flag: "wx",
        });
        await rename(temporaryPath, profilePath);
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        return {
          ok: false,
          code: "WRITE_ERROR",
          message: "无法保存阅读偏好，请检查数据目录是否可写。",
        };
      }
      return { ok: true, profile: toState(profile) };
    },
  };
}

export type ReaderProfileModule = ReturnType<typeof createReaderProfileModule>;
