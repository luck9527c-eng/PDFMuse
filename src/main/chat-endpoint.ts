import type { ModelProtocol } from "../shared/contracts.js";

function dropSuffix(pathname: string, suffix: string) {
  return pathname.endsWith(suffix) ? pathname.slice(0, -suffix.length) : pathname;
}

// 已带版本段的地址（/v1、/v4 等）视为归一完毕；照抄 openclaw 目录里的
// 规范地址形态，如智谱 https://api.z.ai/api/paas/v4 之后直接拼协议路由。
const VERSIONED_PATH_RE = /\/v\d+$/;

/**
 * 把 Reader 输入的接口地址归一化为协议 SDK 需要的 base。
 *
 * 运行时 openai-completions 适配器在 base 后拼 `/chat/completions`（OpenAI SDK 路由），
 * anthropic-messages 适配器在 base 后拼 `/v1/messages`（Anthropic SDK 路由）。
 * 连接测试与 toLlmModel 共用本函数，保证两处打到的端点永远一致——
 * 裸域名（如 https://api.b.ai）、/v1 结尾、粘贴完整端点三种输入都收敛到同一端点。
 */
export function normalizeChatApiBase(protocol: ModelProtocol, rawBaseUrl: string): string {
  const url = new URL(rawBaseUrl);
  url.search = "";
  url.hash = "";
  let pathname = url.pathname.replace(/\/+$/, "");
  if (protocol === "openai") {
    pathname = dropSuffix(pathname, "/chat/completions");
    if (!VERSIONED_PATH_RE.test(pathname)) pathname = `${pathname}/v1`;
  } else {
    pathname = dropSuffix(pathname, "/v1/messages");
    pathname = dropSuffix(pathname, "/messages");
    pathname = dropSuffix(pathname, "/v1");
  }
  url.pathname = pathname;
  return url.toString().replace(/\/+$/, "");
}

/** 连接测试实际请求的端点；与运行时 SDK 拼出的路由保持一致。 */
export function chatEndpointUrl(protocol: ModelProtocol, rawBaseUrl: string): URL {
  const url = new URL(normalizeChatApiBase(protocol, rawBaseUrl));
  // 裸域名的 pathname 是 "/"，先收敛掉再做拼接，避免出现双斜杠。
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${protocol === "openai"
    ? "/chat/completions"
    : "/v1/messages"}`;
  return url;
}
