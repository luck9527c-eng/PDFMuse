import type { ReadingFocus } from "../../shared/contracts.js";
import type { AssistantMessage, Message, UserMessage } from "./openclaw-core.js";

const SYSTEM_PROMPT = [
  "你是 PDFMuse，一位帮助 Reader 精读 PDF 书籍的中文阅读助手。",
  "回答一律使用中文，优先依据 Reader 提供的 Selected Passage 和阅读焦点解释原文；焦点之外的书中内容在未提供时不要臆测页码。",
  "回答使用清晰的 Markdown：要点用列表，术语加粗，代码使用围栏代码块，公式用 LaTeX（行内 $...$，独立 $$...$$）。",
  "引用书中内容时注明页码；书外知识要明确说明不是本书内容。回答保持精炼，避免重复 Reader 已有的原文。",
].join("\n");

export function buildSystemPrompt() {
  return SYSTEM_PROMPT;
}

/** Reading Focus 以固定结构进入问题消息，保持 Reader 原文不被改写。 */
export function buildQuestionContent(question: string, focus?: ReadingFocus) {
  const sections: string[] = [];
  if (focus?.selectedPassage) {
    sections.push(`【Selected Passage · 第 ${focus.selectedPassage.page} 页】\n${focus.selectedPassage.text}`);
  }
  if (focus && Number.isSafeInteger(focus.currentPage) && focus.currentPage > 0) {
    sections.push(`【当前阅读位置】第 ${focus.currentPage} 页`);
  }
  sections.push(`【Reader 的问题】\n${question}`);
  return sections.join("\n\n");
}

function assistantText(message: AssistantMessage) {
  return message.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/**
 * 把已持久化的会话消息转换为下一轮模型上下文。
 * 错误或被取消的回答不进入模型上下文，但在 Reader 侧保留展示。
 */
export function historyToLlmMessages(
  history: ReadonlyArray<{ role: "reader" | "assistant"; body: string; status: string }>,
  question: string,
  focus: ReadingFocus | undefined,
  limit = 12,
): Message[] {
  const usable = history.filter(
    (message) => message.role === "reader" || message.status === "complete",
  );
  const recent = usable.slice(-limit);
  const messages: Message[] = recent.map<Message>((message) => {
    if (message.role === "assistant") {
      return {
        role: "assistant",
        content: [{ type: "text", text: message.body }],
        api: "pdfmuse-history",
        provider: "pdfmuse",
        model: "history",
        usage: emptyUsage(),
        stopReason: "stop",
        timestamp: 0,
      } satisfies AssistantMessage;
    }
    return {
      role: "user",
      content: message.body,
      timestamp: 0,
    } satisfies UserMessage;
  });
  const questionMessage: UserMessage = {
    role: "user",
    content: buildQuestionContent(question, focus),
    timestamp: Date.now(),
  };
  messages.push(questionMessage);
  return messages;
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export { assistantText };
