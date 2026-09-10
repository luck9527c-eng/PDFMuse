import { describe, expect, it } from "vitest";

import type { ConversationMessage } from "../../shared/contracts";
import { buildConversationExportFilename, buildConversationMarkdown } from "./conversation-export";

function message(overrides: Partial<ConversationMessage> & Pick<ConversationMessage, "role" | "body">): ConversationMessage {
  return {
    id: `message-${Math.random().toString(36).slice(2)}`,
    sessionId: "session-1",
    runId: "run-1",
    status: "complete",
    createdAt: "2026-09-08T02:00:00.000Z",
    ...overrides,
  };
}

const exportedAt = new Date(2026, 8, 10, 15, 30);

describe("buildConversationMarkdown", () => {
  it("renders the header, reader questions with passage markers and assistant answers with evidence pages", () => {
    const markdown = buildConversationMarkdown({
      title: "三体",
      exportedAt,
      messages: [
        message({
          role: "reader",
          body: "这段宇宙闪烁的描写有什么深意？",
          passage: { page: 145, text: "宇宙也在闪烁。", rects: [] },
          createdAt: "2026-08-30T02:00:00.000Z",
        }),
        message({
          role: "assistant",
          body: "这段描写暗示了……",
          evidence: [
            { source: "pdf", page: 146, snippet: "证据一", trust: "trusted" },
            { source: "pdf", page: 145, snippet: "证据二", trust: "trusted" },
            { source: "pdf", page: 145, snippet: "重复页码", trust: "trusted" },
          ],
          createdAt: "2026-09-10T02:00:00.000Z",
        }),
      ],
    });

    expect(markdown).toBe(
      [
        "# 《三体》阅读对话",
        "",
        "> 导出自 PDFMuse · 2026-09-10",
        "> 对话时间：2026-08-30 ~ 2026-09-10",
        "",
        "## 🧑 我",
        "",
        "这段宇宙闪烁的描写有什么深意？",
        "",
        "> 📖 引用原文 · 第 145 页",
        "",
        "## 🤖 AI",
        "",
        "这段描写暗示了……",
        "",
        "> 📚 参考：第 145、146 页",
        "",
      ].join("\n"),
    );
  });

  it("skips failed and cancelled assistant replies while keeping every reader question", () => {
    const markdown = buildConversationMarkdown({
      title: "三体",
      exportedAt,
      messages: [
        message({ role: "reader", body: "第一个问题" }),
        message({ role: "assistant", body: "半截回答", status: "cancelled" }),
        message({ role: "reader", body: "第二个问题" }),
        message({ role: "assistant", body: "", status: "error", errorMessage: "超时" }),
        message({ role: "assistant", body: "完整回答" }),
      ],
    });

    expect(markdown).toContain("第一个问题");
    expect(markdown).toContain("第二个问题");
    expect(markdown).toContain("完整回答");
    expect(markdown).not.toContain("半截回答");
  });

  it("omits the passage and reference lines when a message carries neither", () => {
    const markdown = buildConversationMarkdown({
      title: "三体",
      exportedAt,
      messages: [message({ role: "reader", body: "直接提问" }), message({ role: "assistant", body: "直接回答" })],
    });

    expect(markdown).not.toContain("引用原文");
    expect(markdown).not.toContain("参考：");
  });

  it("shows a single date when the conversation happened within one day", () => {
    const markdown = buildConversationMarkdown({
      title: "三体",
      exportedAt,
      messages: [
        message({ role: "reader", body: "早上好", createdAt: "2026-09-08T01:00:00.000Z" }),
        message({ role: "assistant", body: "晚上好", createdAt: "2026-09-08T13:00:00.000Z" }),
      ],
    });

    expect(markdown).toContain("> 对话时间：2026-09-08");
  });

  it("keeps the heading on one line and falls back when the title is blank", () => {
    const multiline = buildConversationMarkdown({
      title: "书名\n带换行",
      exportedAt,
      messages: [message({ role: "reader", body: "问题" })],
    });
    expect(multiline.split("\n")[0]).toBe("# 《书名 带换行》阅读对话");

    const blank = buildConversationMarkdown({ title: "  ", exportedAt, messages: [] });
    expect(blank.split("\n")[0]).toBe("# 《未命名书籍》阅读对话");
    expect(blank).not.toContain("对话时间");
  });
});

describe("buildConversationExportFilename", () => {
  it("composes title, label and compact export date", () => {
    expect(buildConversationExportFilename("三体", exportedAt)).toBe("三体-对话-20260910.md");
  });

  it("strips characters Windows forbids and collapses whitespace", () => {
    expect(buildConversationExportFilename('a/b:c*d?"<>|e', exportedAt)).toBe("abcde-对话-20260910.md");
    expect(buildConversationExportFilename("书   名\t多 空格", exportedAt)).toBe("书 名 多 空格-对话-20260910.md");
  });

  it("trims trailing dots and spaces, truncates long titles and falls back when empty", () => {
    expect(buildConversationExportFilename("书名...", exportedAt)).toBe("书名-对话-20260910.md");
    expect(buildConversationExportFilename("长".repeat(120), exportedAt)).toBe(`${"长".repeat(80)}-对话-20260910.md`);
    expect(buildConversationExportFilename("///", exportedAt)).toBe("未命名-对话-20260910.md");
  });
});
