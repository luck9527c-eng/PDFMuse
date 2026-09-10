import type { ConversationMessage } from "../../shared/contracts.js";

export type ConversationExportInput = {
  title: string;
  messages: ConversationMessage[];
  exportedAt: Date;
};

const FALLBACK_TITLE = "未命名书籍";
const FALLBACK_FILENAME_TITLE = "未命名";
/** 书名可能来自文件名，截断避免逼近 Windows 路径长度限制。 */
const MAX_FILENAME_TITLE_LENGTH = 80;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatCompactDate(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

function normalizeTitle(title: string): string {
  return title.replace(/[\r\n\t]+/g, " ").trim() || FALLBACK_TITLE;
}

/** 只导出完整的一问一答：失败/中断的回答跳过，提问全部保留。 */
export function selectExportableMessages(messages: ConversationMessage[]): ConversationMessage[] {
  return messages.filter((message) => message.role === "reader" || message.status === "complete");
}

function renderMessage(message: ConversationMessage): string {
  const lines = [message.role === "reader" ? "## 🧑 我" : "## 🤖 AI", "", message.body.trim()];
  if (message.role === "reader" && message.passage) {
    lines.push("", `> 📖 引用原文 · 第 ${message.passage.page} 页`);
  }
  if (message.role === "assistant" && message.evidence?.length) {
    const pages = [...new Set(message.evidence.map((item) => item.page))].sort((a, b) => a - b);
    if (pages.length > 0) lines.push("", `> 📚 参考：第 ${pages.join("、")} 页`);
  }
  return lines.join("\n");
}

function conversationDateRange(messages: ConversationMessage[]): string | undefined {
  const times = messages
    .map((message) => Date.parse(message.createdAt))
    .filter((time) => !Number.isNaN(time));
  if (times.length === 0) return undefined;
  const from = formatDate(new Date(Math.min(...times)));
  const to = formatDate(new Date(Math.max(...times)));
  return from === to ? from : `${from} ~ ${to}`;
}

export function buildConversationMarkdown(input: ConversationExportInput): string {
  const exportable = selectExportableMessages(input.messages);
  const header = [
    `# 《${normalizeTitle(input.title)}》阅读对话`,
    "",
    `> 导出自 PDFMuse · ${formatDate(input.exportedAt)}`,
  ];
  const range = conversationDateRange(exportable);
  if (range) header.push(`> 对话时间：${range}`);
  const body = exportable.map(renderMessage).join("\n\n");
  return `${[...header, "", body].join("\n")}\n`;
}

export function buildConversationExportFilename(title: string, exportedAt: Date): string {
  const cleaned = title
    .replace(/\s+/g, " ")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, MAX_FILENAME_TITLE_LENGTH)
    .replace(/[. ]+$/, "");
  return `${cleaned || FALLBACK_FILENAME_TITLE}-对话-${formatCompactDate(exportedAt)}.md`;
}
