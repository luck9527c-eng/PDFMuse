import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { isModelProtocol, type ModelProtocol } from "../shared/contracts.js";

export type StoredAppConfig = {
  version: 2;
  chat?: {
    protocol: ModelProtocol;
    baseUrl: string;
    model: string;
    apiKey?: string;
  };
  embedding?: {
    baseUrl: string;
    model: string;
    apiKey?: string;
  };
  [key: string]: unknown;
};

export const EMPTY_APP_CONFIG: StoredAppConfig = { version: 2 };
const updateQueues = new Map<string, Promise<void>>();

type ParseAppConfigOptions = {
  allowLegacyVersion?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasValidChatConfig(value: Record<string, unknown>, allowMissingProtocol: boolean) {
  if (value.chat === undefined) return true;
  if (!isRecord(value.chat)) return false;
  return (isModelProtocol(value.chat.protocol) || (allowMissingProtocol && value.chat.protocol === undefined))
    && typeof value.chat.baseUrl === "string"
    && typeof value.chat.model === "string"
    && (value.chat.apiKey === undefined || typeof value.chat.apiKey === "string");
}

function hasValidEmbeddingConfig(value: Record<string, unknown>) {
  if (value.embedding === undefined) return true;
  if (!isRecord(value.embedding)) return false;
  return typeof value.embedding.baseUrl === "string"
    && typeof value.embedding.model === "string"
    && (value.embedding.apiKey === undefined || typeof value.embedding.apiKey === "string");
}

export function parseAppConfig(
  source: string,
  options: ParseAppConfigOptions = {},
): { config: StoredAppConfig; migrated: boolean } {
  const value: unknown = JSON.parse(source);
  const isLegacyVersion = isRecord(value) && (value.version === undefined || value.version === 1);
  if (!isRecord(value)
    || (value.version !== 2 && !(options.allowLegacyVersion && isLegacyVersion))
    || !hasValidChatConfig(value, Boolean(options.allowLegacyVersion && isLegacyVersion))
    || !hasValidEmbeddingConfig(value)) {
    throw new SyntaxError("Invalid PDFMuse configuration");
  }

  const chat = isRecord(value.chat)
    ? {
        ...value.chat,
        protocol: isModelProtocol(value.chat.protocol) ? value.chat.protocol : "openai",
      }
    : undefined;
  return {
    config: {
      ...value,
      version: 2,
      ...(chat ? { chat } : {}),
    } as StoredAppConfig,
    migrated: value.version !== 2,
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

export async function updateAppConfig(
  configPath: string,
  update: (current: StoredAppConfig) => StoredAppConfig,
) {
  const previous = updateQueues.get(configPath) ?? Promise.resolve();
  const operation = previous.then(async () => {
    const next = update(await readAppConfig(configPath));
    await writeAppConfig(configPath, next);
    return next;
  });
  const tail = operation.then(() => undefined, () => undefined);
  updateQueues.set(configPath, tail);
  try {
    return await operation;
  } finally {
    if (updateQueues.get(configPath) === tail) updateQueues.delete(configPath);
  }
}
