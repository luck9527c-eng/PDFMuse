import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export type StoredAppConfig = {
  version: 1;
  chat?: {
    baseUrl: string;
    model: string;
    apiKey?: string;
  };
  [key: string]: unknown;
};

export const EMPTY_APP_CONFIG: StoredAppConfig = { version: 1 };

type ParseAppConfigOptions = {
  allowLegacyVersion?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasValidChatConfig(value: Record<string, unknown>) {
  if (value.chat === undefined) return true;
  if (!isRecord(value.chat)) return false;
  return typeof value.chat.baseUrl === "string"
    && typeof value.chat.model === "string"
    && (value.chat.apiKey === undefined || typeof value.chat.apiKey === "string");
}

export function parseAppConfig(
  source: string,
  options: ParseAppConfigOptions = {},
): { config: StoredAppConfig; migrated: boolean } {
  const value: unknown = JSON.parse(source);
  if (!isRecord(value)
    || (value.version !== 1 && !(options.allowLegacyVersion && value.version === undefined))
    || !hasValidChatConfig(value)) {
    throw new SyntaxError("Invalid PDFMuse configuration");
  }

  return {
    config: { ...value, version: 1 } as StoredAppConfig,
    migrated: value.version === undefined,
  };
}

export async function readAppConfig(configPath: string): Promise<StoredAppConfig> {
  try {
    return parseAppConfig(await readFile(configPath, "utf8")).config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_APP_CONFIG;
    throw error;
  }
}

export async function writeAppConfig(configPath: string, config: StoredAppConfig) {
  const temporaryPath = path.join(
    path.dirname(configPath),
    `.${path.basename(configPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporaryPath, configPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}
