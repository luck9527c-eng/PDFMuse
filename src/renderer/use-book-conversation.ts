import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import type {
  AgentImageAttachment,
  ConversationMessage,
  OpenedPdfBook,
  SelectedPassage,
} from "../shared/contracts";
import {
  createConversationController,
  type ConversationControllerState,
} from "./conversation-controller";

export type BookConversation = {
  state: ConversationControllerState;
  busy: boolean;
  ask(question: string, passage?: SelectedPassage, attachments?: AgentImageAttachment[]): Promise<boolean>;
  cancel(): void;
  dismissNotice(): void;
  notify(message: string): void;
  retry(message: ConversationMessage): void;
  clear(): Promise<"ok" | "busy" | "failed">;
  exportMarkdown(): Promise<"saved" | "cancelled" | "failed">;
  refreshDiagnostics(): Promise<void>;
};

/**
 * Book Conversation 的 React 适配层：状态机负责迁移，这里只做 IPC 编排。
 * 切换书籍时自动重置并加载对应会话。
 */
export function useBookConversation(book: OpenedPdfBook | undefined, getPage: () => number): BookConversation {
  const controllerRef = useRef(createConversationController());
  const controller = controllerRef.current;
  const bookRef = useRef(book);
  bookRef.current = book;

  const state = useSyncExternalStore(
    useCallback((listener: () => void) => controller.subscribe(listener), [controller]),
    useCallback(() => controller.getState(), [controller]),
  );

  const refreshConversation = useCallback(async (bookId: string) => {
    if (!window.pdfMuse) return;
    controller.dispatch({ type: "conversation-loading" });
    try {
      const messages = await window.pdfMuse.getBookConversation(bookId);
      controller.dispatch({ type: "conversation-loaded", messages });
    } catch {
      controller.dispatch({ type: "conversation-error", message: "无法读取本书对话记录。" });
    }
  }, [controller]);

  // 书籍切换：重置助手域状态并加载新书的会话。
  const bookId = book?.id;
  useEffect(() => {
    controller.dispatch({ type: "reset" });
    if (!bookId) return;
    void refreshConversation(bookId);
  }, [bookId, controller, refreshConversation]);

  const refreshDiagnostics = useCallback(async () => {
    const activeBook = bookRef.current;
    const api = window.pdfMuse;
    if (!activeBook || !api) return;
    try {
      const runs = await api.getRunDiagnostics(activeBook.id);
      controller.dispatch({ type: "diagnostics-loaded", runs });
    } catch {
      // 诊断拉取失败不打扰阅读；抽屉显示已有实时数据。
    }
  }, [controller]);

  // Agent 事件订阅与 controller 相同生命周期；终态后以持久化数据替换乐观消息并补全诊断。
  useEffect(() => {
    const api = window.pdfMuse;
    if (!api) return;
    return api.onAgentEvent((event) => {
      const { terminalRunId } = controller.dispatch({ type: "agent-event", event });
      if (!terminalRunId) return;
      const activeBookId = bookRef.current?.id;
      if (activeBookId) {
        void refreshConversation(activeBookId);
        void refreshDiagnostics();
      }
    });
  }, [controller, refreshConversation, refreshDiagnostics]);

  const ask = useCallback(async (question: string, passage?: SelectedPassage, attachments: AgentImageAttachment[] = []) => {
    const activeBook = bookRef.current;
    const api = window.pdfMuse;
    if (!activeBook || !api || controller.isBusy()) return false;
    controller.beginStart();
    try {
      const result = await api.startAgentRun({
        bookId: activeBook.id,
        question,
        focus: {
          currentPage: getPage(),
          ...(passage ? { selectedPassage: passage } : {}),
        },
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      if (!result.ok) {
        controller.dispatch({ type: "run-rejected", message: result.message });
        return false;
      }
      controller.dispatch({ type: "run-started", runId: result.runId, sessionId: result.sessionId, question, passage });
      return true;
    } catch {
      controller.dispatch({ type: "run-start-failed" });
      return false;
    }
  }, [controller, getPage]);

  const cancel = useCallback(() => {
    const api = window.pdfMuse;
    const active = controller.getState().streaming;
    if (!active || !api) return;
    void api.cancelAgentRun(active.runId).catch(() => undefined);
  }, [controller]);

  const dismissNotice = useCallback(() => {
    controller.dispatch({ type: "notice", message: "" });
  }, [controller]);

  const notify = useCallback((message: string) => {
    controller.dispatch({ type: "notice", message });
  }, [controller]);

  const retry = useCallback((message: ConversationMessage) => {
    const activeBook = bookRef.current;
    if (!activeBook) return;
    const readerQuestion = controller.getState().messages
      .slice(0, controller.getState().messages.findIndex((item) => item.id === message.id))
      .reverse()
      .find((item) => item.role === "reader" && item.runId === message.runId);
    if (!readerQuestion) return;
    // 重试沿用原 Selected Passage 的完整 Evidence 坐标。
    const passage = readerQuestion.passage
      ? {
        bookId: activeBook.id,
        page: readerQuestion.passage.page,
        text: readerQuestion.passage.text,
        rects: readerQuestion.passage.rects,
      }
      : undefined;
    void ask(readerQuestion.body, passage);
  }, [ask, controller]);

  const clear = useCallback(async () => {
    const activeBook = bookRef.current;
    const api = window.pdfMuse;
    if (!activeBook || !api || controller.isBusy()) return "busy" as const;
    try {
      const result = await api.clearBookConversation(activeBook.id);
      if (!result.ok) {
        controller.dispatch({ type: "notice", message: result.message });
        return "failed" as const;
      }
      controller.dispatch({ type: "clear-succeeded" });
      return "ok" as const;
    } catch {
      controller.dispatch({ type: "notice", message: "无法清空本书会话，请重试。" });
      return "failed" as const;
    }
  }, [controller]);

  const exportMarkdown = useCallback(async (): Promise<"saved" | "cancelled" | "failed"> => {
    const activeBook = bookRef.current;
    const api = window.pdfMuse;
    if (!activeBook || !api || controller.isBusy()) return "failed" as const;
    try {
      const result = await api.exportBookConversation(activeBook.id);
      if (result.outcome === "saved") {
        controller.dispatch({ type: "notice", message: `已导出到 ${result.path}` });
        return "saved" as const;
      }
      if (result.outcome === "failed") {
        controller.dispatch({ type: "notice", message: result.message });
      }
      return result.outcome;
    } catch {
      controller.dispatch({ type: "notice", message: "无法导出会话，请重试。" });
      return "failed" as const;
    }
  }, [controller]);

  return {
    state,
    busy: Boolean(state.streaming),
    ask,
    cancel,
    dismissNotice,
    notify,
    retry,
    clear,
    exportMarkdown,
    refreshDiagnostics,
  };
}
