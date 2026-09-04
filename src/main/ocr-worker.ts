import { parentPort } from "node:worker_threads";

import type { OcrPageRequest, RecognizedPageText } from "../shared/contracts.js";

/** 引擎无关的 Worker 协议；PaddleOCR 适配器在 T15 注入，不让 Renderer 接触引擎。 */
export type OcrWorkerRequest = { id: string; input: OcrPageRequest };
export type OcrWorkerResponse =
  | { id: string; ok: true; result: Pick<RecognizedPageText, "width" | "height" | "orientation" | "lines"> }
  | { id: string; ok: false; message: string };

if (parentPort) {
  const port = parentPort;
  port.on("message", async (message: OcrWorkerRequest) => {
    const response: OcrWorkerResponse = {
      id: message.id,
      ok: false,
      message: "OCR 工作进程尚未安装识别引擎。",
    };
    port.postMessage(response);
  });
}
