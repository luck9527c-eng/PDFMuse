import { describe, expect, it } from "vitest";

import { createMineruResponseRouter } from "./mineru-protocol.js";

function makeRouter() {
  const posted: unknown[] = [];
  const router = createMineruResponseRouter((response) => posted.push(response));
  return { router, posted };
}

const OK_LINE = JSON.stringify({
  id: "r1",
  ok: true,
  result: { blocks: [{ type: "text", text: "文字", bbox: [0, 0, 100, 40] }], markdown: "# 文字" },
});

describe("MinerU response router", () => {
  it("forwards protocol responses for tracked requests and ignores unrelated lines", () => {
    const { router, posted } = makeRouter();
    router.track("r1");
    router.handleLine("[INFO] 第三方日志不应穿透协议");
    router.handleLine("");
    router.handleLine("{broken json");
    router.handleLine(OK_LINE);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ id: "r1", ok: true, result: { blocks: [{ type: "text", text: "文字" }] } });
  });

  it("drops the late response of a cancelled request", () => {
    const { router, posted } = makeRouter();
    router.track("r1");
    router.cancel("r1");
    router.handleLine(OK_LINE);
    expect(posted).toHaveLength(0);
  });

  it("rejects all pending requests when the child process exits", () => {
    const { router, posted } = makeRouter();
    router.track("r1");
    router.track("r2");
    router.cancel("r2");
    router.rejectAll("MinerU 工作进程意外退出。");
    expect(posted).toEqual([{ id: "r1", ok: false, message: "MinerU 工作进程意外退出。" }]);
    // 复位后路由重新可用：取消集合一并清空，同 id 的迟到响应不再被吞。
    router.track("r2");
    router.handleLine(JSON.stringify({ id: "r2", ok: true, result: { blocks: [], markdown: "" } }));
    expect(posted).toHaveLength(2);
  });
});
