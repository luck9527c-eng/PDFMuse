import { configureAiTransportHost } from "./openclaw-core.js";

/**
 * OpenAI 兼容流里承载推理过程的 delta 字段。
 *
 * 这些字段必须在 SSE 边界剥掉：openclaw 的 openai-completions 适配器一见到
 * `reasoning_content` 就进入「严格推理」文本模式（reasoningTagTextPartitioner
 * 的 markStrict），可见正文被扣在分区器里直到流终止才一次性 flush——表现就是
 * 读者看到的是阻塞式回复。PDFMuse 的 Model 声明 reasoning: false，本来也不消费
 * 推理内容，剥掉不损失任何当前会展示的信息。
 */
const REASONING_DELTA_FIELDS = ["reasoning_content", "reasoning", "reasoning_text", "reasoning_details"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 从单条 SSE data 负载里删除推理字段；返回重写后的负载，无需改写时返回 undefined。
 * 非 JSON、无 choices（Anthropic 风格事件）一律原样放行。
 */
export function stripReasoningDeltaFields(payload: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.choices)) return undefined;
  let stripped = false;
  for (const choice of parsed.choices) {
    if (!isRecord(choice) || !isRecord(choice.delta)) continue;
    for (const field of REASONING_DELTA_FIELDS) {
      if (field in choice.delta) {
        delete choice.delta[field];
        stripped = true;
      }
    }
  }
  return stripped ? JSON.stringify(parsed) : undefined;
}

/** 单行 SSE 重写；按行处理保证逐块透传，不改变分块节奏。 */
function rewriteSseLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return line;
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === "[DONE]") return line;
  const rewritten = stripReasoningDeltaFields(payload);
  return rewritten === undefined ? line : `data: ${rewritten}`;
}

/** 包一层 fetch：只改写事件流响应的 data 行，其余请求与响应原样透传。 */
export function createReasoningStrippingFetch(baseFetch: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await baseFetch(input, init);
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.body || !contentType.includes("text/event-stream")) return response;

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let pending = "";
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        let newline = pending.indexOf("\n");
        while (newline >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          controller.enqueue(encoder.encode(`${rewriteSseLine(line)}\n`));
          newline = pending.indexOf("\n");
        }
      },
      flush(controller) {
        if (pending) controller.enqueue(encoder.encode(rewriteSseLine(pending)));
      },
    }));
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: stripBodyFramingHeaders(response.headers),
    });
  };
}

/** 重写后长度与编码都已变化，透传会误导下游解码。 */
function stripBodyFramingHeaders(headers: Headers): Headers {
  const next = new Headers(headers);
  next.delete("content-encoding");
  next.delete("content-length");
  return next;
}

/** 让 Provider Adapter 发出的模型请求都经过上面的 SSE 重写。 */
export function installStreamSanitizingFetch(baseFetch: typeof fetch = fetch): void {
  configureAiTransportHost({ buildModelFetch: () => createReasoningStrippingFetch(baseFetch) });
}
