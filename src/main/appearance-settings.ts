import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  APPEARANCE_DEFAULTS,
  APPEARANCE_LIMITS,
  type AppearanceSettings,
  type SaveAppearanceSettingsResult,
} from "../shared/contracts.js";

type StoredAppearanceSettings = AppearanceSettings & {
  version: 1;
};

function isValidSetting(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function toStoredSettings(value: unknown): StoredAppearanceSettings | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== undefined && record.version !== 1) return undefined;
  if (
    !isValidSetting(record.sidebarFontSize, APPEARANCE_LIMITS.sidebarFontSize.min, APPEARANCE_LIMITS.sidebarFontSize.max)
    || !isValidSetting(record.chatFontSize, APPEARANCE_LIMITS.chatFontSize.min, APPEARANCE_LIMITS.chatFontSize.max)
    || !isValidSetting(record.topbarScale, APPEARANCE_LIMITS.topbarScale.min, APPEARANCE_LIMITS.topbarScale.max)
  ) {
    return undefined;
  }
  return {
    version: 1,
    sidebarFontSize: record.sidebarFontSize,
    chatFontSize: record.chatFontSize,
    topbarScale: record.topbarScale,
  };
}

export function createAppearanceSettingsModule(dataHome: string) {
  const settingsPath = path.join(dataHome, "appearance-settings.json");

  async function readSettings(): Promise<StoredAppearanceSettings> {
    try {
      const stored = toStoredSettings(JSON.parse(await readFile(settingsPath, "utf8")));
      if (!stored) throw new SyntaxError();
      return stored;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, ...APPEARANCE_DEFAULTS };
      }
      // 损坏的外观设置视为默认值；不覆盖原文件，Reader 保存时才会重写。
      return { version: 1, ...APPEARANCE_DEFAULTS };
    }
  }

  return {
    async get(): Promise<AppearanceSettings> {
      const { version: _version, ...settings } = await readSettings();
      return settings;
    },

    async save(input: unknown): Promise<SaveAppearanceSettingsResult> {
      const stored = toStoredSettings({ ...(input as object), version: 1 });
      if (!stored) {
        return {
          ok: false,
          code: "VALIDATION_ERROR",
          message: "外观设置数值无效。",
        };
      }
      const temporaryPath = path.join(
        path.dirname(settingsPath),
        `.${path.basename(settingsPath)}.${process.pid}.${randomUUID()}.tmp`,
      );
      try {
        await writeFile(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, {
          encoding: "utf8",
          flag: "wx",
        });
        await rename(temporaryPath, settingsPath);
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        return {
          ok: false,
          code: "WRITE_ERROR",
          message: "无法保存外观设置，请检查数据目录是否可写。",
        };
      }
      const { version: _version, ...settings } = stored;
      return { ok: true, settings };
    }
  };
}

export type AppearanceSettingsModule = ReturnType<typeof createAppearanceSettingsModule>;
