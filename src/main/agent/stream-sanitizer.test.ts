import { describe, expect, it } from "vitest";

import { createReasoningStrippingFetch, stripReasoningDeltaFields } from "./stream-sanitizer.js";

function sseLine(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n`;
}

function chatChunk(delta: Record<string, unknown>) {
  return { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] };
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function readAll(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

describe("stripReasoningDeltaFields", () => {
  it("removes every reasoning delta field while keeping visible content", () => {
    const rewritten = stripReasoningDeltaFields(JSON.stringify(chatChunk({
      content: "正文",
      reasoning_content: "思考",
      reasoning: "思考",
      reasoning_text: "思考",
      reasoning_details: [{ type: "reasoning.text", text: "思考" }],
    })));
    expect(rewritten).toBeDefined();
    expect(JSON.parse(rewritten!)).toEqual(chatChunk({ content: "正文" }));
  });

  it("reports no rewrite for chunks without reasoning fields", () => {
    expect(stripReasoningDeltaFields(JSON.stringify(chatChunk({ content: "正文" })))).toBeUndefined();
  });

  it("leaves non-chat payloads untouched", () => {
    expect(stripReasoningDeltaFields("[DONE]")).toBeUndefined();
    expect(stripReasoningDeltaFields(JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "x" } }))).toBeUndefined();
    expect(stripReasoningDeltaFields(JSON.stringify({ choices: [{ index: 0 }] }))).toBeUndefined();
  });
});

describe("createReasoningStrippingFetch", () => {
  it("rewrites data lines and forwards everything else", async () => {
    const source = sseResponse([
      sseLine(chatChunk({ role: "assistant" })),
      sseLine(chatChunk({ reasoning_content: "思考" })),
      sseLine(chatChunk({ content: "第一段" })),
      sseLine(chatChunk({ content: "第二段", reasoning_content: "又思考" })),
      "data: [DONE]\n\n",
    ]);
    const baseFetch = (async () => source) as unknown as typeof fetch;
    const text = await readAll(await createReasoningStrippingFetch(baseFetch)("http://x", {}));

    expect(text).toContain(JSON.stringify(chatChunk({ content: "第一段" })));
    expect(text).toContain(JSON.stringify(chatChunk({ content: "第二段" })));
    expect(text).not.toContain("reasoning_content");
    expect(text).toContain("data: [DONE]");
  });

  it("keeps delta boundaries so consumers still see incremental chunks", async () => {
    const baseFetch = (async () => sseResponse([
      sseLine(chatChunk({ reasoning_content: "思考" })),
      sseLine(chatChunk({ content: "第一段" })),
      sseLine(chatChunk({ content: "第二段" })),
    ])) as unknown as typeof fetch;
    const response = await createReasoningStrippingFetch(baseFetch)("http://x", {});

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const reads: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      reads.push(decoder.decode(value, { stream: true }));
    }
    expect(reads).toHaveLength(3);
    expect(reads[1]).toContain("第一段");
    expect(reads[2]).toContain("第二段");
  });

  it("passes non-event-stream responses through untouched", async () => {
    const json = new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    const baseFetch = (async () => json) as unknown as typeof fetch;
    const response = await createReasoningStrippingFetch(baseFetch)("http://x", {});
    expect(response).toBe(json);
  });

  it("drops body framing headers that no longer describe the rewritten body", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sseLine(chatChunk({ reasoning_content: "思考" }))));
        controller.close();
      },
    });
    const source = new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream", "content-encoding": "gzip", "content-length": "999" },
    });
    const baseFetch = (async () => source) as unknown as typeof fetch;
    const response = await createReasoningStrippingFetch(baseFetch)("http://x", {});
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
  });

  it("reassembles data lines split across network chunks", async () => {
    const line = sseLine(chatChunk({ content: "第一段", reasoning_content: "思考" }));
    const source = sseResponse([line.slice(0, 12), line.slice(12, 30), line.slice(30)]);
    const baseFetch = (async () => source) as unknown as typeof fetch;
    const text = await readAll(await createReasoningStrippingFetch(baseFetch)("http://x", {}));
    expect(text).toBe(`${sseLine(chatChunk({ content: "第一段" }))}`);
  });
});
