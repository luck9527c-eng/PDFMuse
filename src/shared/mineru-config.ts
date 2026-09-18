export const MINERU_ENGINE = "MinerU";
export const MINERU_ENGINE_VERSION = "4.0.2";
export const MINERU_MODEL = "basic";

// 识别输入为 PDF 原文件按页直读（ADR 0011），不存在渲染倍率，指纹只由引擎/档位/版本派生。
export const MINERU_INPUT_VERSION = `${MINERU_ENGINE}:${MINERU_MODEL}:${MINERU_ENGINE_VERSION}`;

export const MINERU_REQUIRED_RESOURCE_PATHS = [
  "mineru-runtime",
  "mineru-worker/mineru_worker.py",
] as const;
