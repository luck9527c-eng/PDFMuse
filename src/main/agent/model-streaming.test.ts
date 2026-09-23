import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createModelStreamFn, toLlmModel, type ResolvedModelConnection } from "./model-runtime.js";

/**
 * 回归：推理模型的 SSE 里带 reasoning_content 时，openclaw 适配器会进入严格推理
 * 文本模式，把可见正文扣到流终止才吐一次——读者看到的是阻塞式回复。
 * 这里用真实 HTTP 假服务端按固定节奏推送「思考 + 正文」分片，断言正文仍是逐片到达。
 */
function startSseServer(script: { reasoning: string[]; content: string[]; gapMs: number }): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const send = (delta: Record<string, unknown>, finishReason: string | null = null) => response.write(`data: ${JSON.stringify({
      id: "chunk",
      object: "chat.completion.chunk",
      model: "test-model",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`);
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    void (async () => {
      send({ role: "assistant" });
      for (const piece of script.reasoning) {
        send({ reasoning_content: piece });
        await wait(script.gapMs);
      }
      for (const piece of script.content) {
        send({ content: piece });
        await wait(script.gapMs);
      }
      send({}, "stop");
      response.write("data: [DONE]\n\n");
      response.end();
    })().catch(() => response.end());
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1` });
    });
  });
}

describe("model streaming", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (!server) return;
    await new Promise((resolve) => server!.close(resolve));
    server = undefined;
  });

  it("delivers assistant text incrementally even when the provider streams reasoning deltas", async () => {
    const started = await startSseServer({ reasoning: ["思考一", "思考二"], content: ["第一段", "第二段", "第三段"], gapMs: 40 });
    server = started.server;
    const connection: ResolvedModelConnection = { protocol: "openai", baseUrl: started.baseUrl, model: "test-model", apiKey: "test-key" };
    const streamFn = createModelStreamFn(connection);

    const deltas: string[] = [];
    const response = await streamFn(
      toLlmModel(connection),
      { systemPrompt: "系统提示", messages: [{ role: "user", content: "问题" }] },
      {},
    );
    for await (const event of response) {
      if (event.type === "text_delta" && event.delta) deltas.push(event.delta);
    }

    // 关键断言：三片正文各自到达，而不是合并成最后一次性的一片。
    expect(deltas).toEqual(["第一段", "第二段", "第三段"]);
  }, 15_000);
});
