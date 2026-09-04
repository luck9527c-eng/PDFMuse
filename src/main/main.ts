import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";

import { preflightDataHome } from "./data-home.js";
import { createEmbeddingConnectionModule } from "./embedding-connection.js";
import { createLibraryModule } from "./library.js";
import { createModelConnectionModule } from "./model-connection.js";
import { readAppConfig } from "./config-store.js";
import { createAgentHost, type AgentHost } from "./agent/agent-host.js";
import { createBookIndex } from "./agent/book-index.js";
import type { ResolvedModelConnection } from "./agent/model-runtime.js";
import { createToolRegistry } from "./agent/tool-registry.js";
import { createMemoryModule } from "./agent/memory.js";
import { createOcrModule, createWorkerOcrEngine } from "./ocr.js";
import { createBackgroundJobModule } from "./background-jobs.js";
import { createBookOutlineModule } from "./book-outline.js";
import { createReaderProfileModule } from "./reader-profile.js";
import type {
  AgentStreamEvent,
  BackgroundJobMutationResult,
  LibraryMutationResult,
  ScheduleBackgroundJobInput,
  SaveEmbeddingConnectionInput,
  SaveModelConnectionInput,
  StartupPreflight,
  TestEmbeddingConnectionInput,
  TestModelConnectionInput,
} from "../shared/contracts.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
let startupPreflight: StartupPreflight;
let closeLibrary: (() => void) | undefined;
let closeAgentHost: (() => void) | undefined;
let closeBookIndex: (() => void) | undefined;
let closeMemory: (() => void) | undefined;
let closeOcr: (() => void) | undefined;
let closeBackgroundJobs: (() => void) | undefined;
let closeBookOutline: (() => void) | undefined;

function broadcastAgentEvent(event: AgentStreamEvent) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("agent:event", event);
  }
}

function applicationDirectory() {
  const testDirectory = process.env.PDFMUSE_TEST_APPLICATION_DIRECTORY;
  if (!app.isPackaged && testDirectory) return path.resolve(testDirectory);
  return app.isPackaged ? path.dirname(process.execPath) : app.getAppPath();
}

function createWindow() {
  const window = new BrowserWindow({
    title: "PDFMuse",
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: "#ebe8df",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(currentDirectory, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.once("ready-to-show", () => window.show());

  const developmentUrl = process.env.VITE_DEV_SERVER_URL;
  if (developmentUrl) {
    void window.loadURL(developmentUrl);
  } else {
    void window.loadFile(path.join(app.getAppPath(), "dist", "index.html"));
  }
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  startupPreflight = await preflightDataHome(applicationDirectory());

  ipcMain.handle("app:get-startup-preflight", () => startupPreflight);
  if (startupPreflight.ok) {
    const modelConnection = createModelConnectionModule(startupPreflight.dataHome);
    const embeddingConnection = createEmbeddingConnectionModule(startupPreflight.dataHome);
    const library = createLibraryModule(startupPreflight.dataHome);
    const mutatingBookIds = new Set<string>();
    const isOwnedBook = (bookId: unknown): bookId is string => (
      typeof bookId === "string" && !mutatingBookIds.has(bookId) && library.has(bookId)
    );
    closeLibrary = library.close;
    const configPath = path.join(startupPreflight.dataHome, "config.json");
    const readerProfile = createReaderProfileModule(startupPreflight.dataHome);
    const bookIndex = createBookIndex(startupPreflight.dataHome, {
      getEmbeddingProvider: async () => {
        const config = await readAppConfig(configPath);
        if (!config.embedding) return undefined;
        return {
          model: config.embedding.model,
          embed: (inputs: readonly string[], signal?: AbortSignal) => embeddingConnection.embed(inputs, signal),
        };
      },
    });
    closeBookIndex = bookIndex.close;
    const memory = createMemoryModule(startupPreflight.dataHome);
    closeMemory = memory.close;
    const ocr = createOcrModule(startupPreflight.dataHome, createWorkerOcrEngine({
      command: path.join(applicationDirectory(), "resources", "ocr-runtime", process.platform === "win32" ? "python.exe" : "python"),
      args: [path.join(applicationDirectory(), "resources", "ocr-worker", "paddleocr_worker.py")],
      model: "PP-OCRv5",
      engineVersion: "3.7.0",
    }));
    closeOcr = ocr.close;
    const bookOutline = createBookOutlineModule(startupPreflight.dataHome);
    closeBookOutline = bookOutline.close;
    const backgroundJobs = createBackgroundJobModule(startupPreflight.dataHome, {
      index: async (job, context) => {
        const result = await bookIndex.ensureIndexed(
          job.bookId,
          () => bookIndex.loadBookByBookId(job.bookId),
          context.signal,
          (progress, total) => context.checkpoint(`page:${progress}`, progress, total),
        );
        context.checkpoint(`page:${result.indexedPages}`, result.indexedPages, result.totalPages);
        if (context.signal.aborted) throw new Error("索引任务已暂停或取消。");
      },
      embedding: async (job, context) => {
        const config = await readAppConfig(configPath);
        if (!config.embedding) throw new Error("尚未配置嵌入模型，当前继续使用全文检索。");
        if (context.signal.aborted) throw new Error("嵌入任务已暂停或取消。");
        const completed = await bookIndex.ensureEmbeddings(job.bookId, context.signal);
        if (!completed) throw new Error("语义索引生成失败，当前继续使用全文检索。");
        const stats = bookIndex.stats(job.bookId);
        context.checkpoint(`page:${stats.indexedPages}`, stats.indexedPages, stats.totalPages);
      },
      ocr: async (job, context) => {
        const book = library.list().find((item) => item.id === job.bookId);
        if (!book) throw new Error("当前 PDF 书籍不可用。");
        const checkpoint = job.checkpoint?.match(/^page:(\d+)$/);
        const startPage = Math.max(1, Number(checkpoint?.[1] ?? 0) + 1);
        for (let page = startPage; page <= book.pageCount; page += 1) {
          if (context.signal.aborted) throw new Error("OCR 任务已暂停或取消。");
          if (!ocr.isPageCompatible(job.bookId, page, "3.7.0", "PP-OCRv5")) {
            const image = await bookIndex.renderPageForOcr(job.bookId, page);
            const result = await ocr.recognizePage({ bookId: job.bookId, page, ...image }, context.signal);
            if (!result.ok) throw new Error(result.message);
            bookIndex.indexRecognizedPage(job.bookId, page, result.page.lines);
            bookOutline.invalidate(job.bookId, page);
          }
          context.checkpoint(`page:${page}`, page, book.pageCount);
        }
      },
      outline: async (job, context) => {
        const result = await bookOutline.rebuild(
          job.bookId,
          () => bookIndex.loadBookByBookId(job.bookId),
          context.signal,
          (progress, total) => context.checkpoint(`page:${progress}`, progress, total),
        );
        context.checkpoint(`page:${result.processedPages}`, result.processedPages, result.totalPages);
        if (context.signal.aborted) throw new Error("目录补全任务已暂停或取消。");
      },
    });
    closeBackgroundJobs = backgroundJobs.close;
    const toolRegistry = createToolRegistry({ memoryConfigured: true });
    const agentHost: AgentHost = createAgentHost({
      dataHome: startupPreflight.dataHome,
      emit: broadcastAgentEvent,
      loadModelConnection: async (): Promise<ResolvedModelConnection | undefined> => {
        const config = await readAppConfig(configPath);
        return config.chat
          ? {
            protocol: config.chat.protocol,
            baseUrl: config.chat.baseUrl,
            model: config.chat.model,
            ...(config.chat.apiKey ? { apiKey: config.chat.apiKey } : {}),
          }
          : undefined;
      },
      loadReaderProfile: async () => (await readerProfile.get()).content,
      memory,
      isKnownBook: isOwnedBook,
      buildTools: (context) => toolRegistry.buildAgentTools(() => ({
        bookId: context.bookId,
        focus: context.focus,
        reportEvidence: context.reportEvidence,
        bookIndex,
        memory: context.memory,
      })),
      indexConversationMessage: async (bookId, message) => {
        await bookIndex.indexConversationMessage(bookId, message);
      },
    });
    closeAgentHost = agentHost.close;
    const invalidLibraryMutation = (): LibraryMutationResult => ({
      ok: false,
      code: "NOT_FOUND",
      message: "书库中没有找到这本 PDF 书籍。",
    });
    const mutateLibraryBook = async (bookId: unknown, mode: "remove" | "delete") => {
      if (!isOwnedBook(bookId)) return invalidLibraryMutation();
      mutatingBookIds.add(bookId);
      try {
        await Promise.all([
          agentHost.cancelBook(bookId),
          backgroundJobs.cancelBook(bookId),
        ]);
        return mode === "remove"
          ? library.removeFromLibrary(bookId)
          : library.deleteBookData(bookId);
      } finally {
        mutatingBookIds.delete(bookId);
      }
    };
    ipcMain.handle("library:list", () => library.list());
    ipcMain.handle("library:choose", async () => {
      const result = await dialog.showOpenDialog({
        title: "打开 PDF 书籍",
        properties: ["openFile"],
        filters: [{ name: "PDF 文件", extensions: ["pdf"] }],
      });
      const selectedPath = result.filePaths[0];
      if (result.canceled || !selectedPath) return null;
      return library.openPath(selectedPath);
    });
    ipcMain.handle("library:open-path", (_event, filePath: unknown) => library.openPath(filePath));
    ipcMain.handle("library:open-recent", () => library.openRecent());
    ipcMain.handle("library:open-known", (_event, bookId: unknown) => library.openKnown(bookId));
    ipcMain.handle(
      "library:unlock",
      (_event, challengeId: unknown, password: unknown, rememberPassword: unknown) => (
        library.unlock(challengeId, password, rememberPassword)
      ),
    );
    ipcMain.handle("library:relocate", async (_event, bookId: unknown) => {
      const result = await dialog.showOpenDialog({
        title: "重新定位 PDF 原文件",
        properties: ["openFile"],
        filters: [{ name: "PDF 文件", extensions: ["pdf"] }],
      });
      const selectedPath = result.filePaths[0];
      if (result.canceled || !selectedPath) return null;
      return library.relocate(bookId, selectedPath);
    });
    ipcMain.handle("library:remove", (_event, bookId: unknown) => mutateLibraryBook(bookId, "remove"));
    ipcMain.handle("library:delete-data", (_event, bookId: unknown) => mutateLibraryBook(bookId, "delete"));
    ipcMain.handle(
      "library:update-state",
      (_event, bookId: unknown, state: unknown) => library.updateReadingState(bookId, state),
    );
    ipcMain.handle("model-connection:get", () => modelConnection.get());
    ipcMain.handle(
      "model-connection:save",
      (_event, input: SaveModelConnectionInput) => modelConnection.save(input),
    );
    ipcMain.handle(
      "model-connection:test",
      (_event, input: TestModelConnectionInput) => modelConnection.test(input),
    );
    ipcMain.handle("embedding-connection:get", () => embeddingConnection.get());
    ipcMain.handle(
      "embedding-connection:save",
      (_event, input: SaveEmbeddingConnectionInput) => embeddingConnection.save(input),
    );
    ipcMain.handle(
      "embedding-connection:test",
      (_event, input: TestEmbeddingConnectionInput) => embeddingConnection.test(input),
    );
    ipcMain.handle("agent:get-conversation", (_event, bookId: unknown) => agentHost.getConversation(bookId));
    ipcMain.handle("ocr:get-page", (_event, bookId: unknown, page: unknown) => (
      isOwnedBook(bookId) && typeof page === "number" ? ocr.getPage(bookId, page) : undefined
    ));
    ipcMain.handle("ocr:recognize-page", async (_event, input: unknown) => {
      if (!input || typeof input !== "object") return { ok: false, code: "VALIDATION_ERROR", message: "OCR 页面请求无效。" };
      const value = input as { bookId?: unknown };
      if (!isOwnedBook(value.bookId)) return { ok: false, code: "VALIDATION_ERROR", message: "当前 PDF 书籍不可用。" };
      const result = await ocr.recognizePage(input as Parameters<typeof ocr.recognizePage>[0]);
      if (result.ok) {
        bookOutline.invalidate(result.page.bookId, result.page.page);
        const activeOutline = backgroundJobs.list(result.page.bookId).find((job) => (
          job.kind === "outline" && (job.status === "queued" || job.status === "running" || job.status === "paused")
        ));
        if (activeOutline) backgroundJobs.cancel(activeOutline.id);
        const book = library.list().find((item) => item.id === result.page.bookId);
        backgroundJobs.schedule({
          bookId: result.page.bookId,
          kind: "outline",
          priority: 20,
          total: book?.pageCount ?? 0,
        });
      }
      return result;
    });
    ipcMain.handle("outline:get", (_event, bookId: unknown) => (
      isOwnedBook(bookId) ? bookOutline.get(bookId) : undefined
    ));
    const invalidBackgroundJob = (): BackgroundJobMutationResult => ({
      ok: false,
      code: "NOT_FOUND",
      message: "后台任务不存在，或不属于当前书库。",
    });
    const mutateOwnedJob = (jobId: unknown, action: "pause" | "resume" | "cancel") => {
      if (typeof jobId !== "string") return invalidBackgroundJob();
      const job = backgroundJobs.get(jobId);
      if (!job || !isOwnedBook(job.bookId)) return invalidBackgroundJob();
      return backgroundJobs[action](jobId);
    };
    ipcMain.handle("background-jobs:list", (_event, bookId: unknown) => {
      if (bookId !== undefined) return isOwnedBook(bookId) ? backgroundJobs.list(bookId) : [];
      return backgroundJobs.list().filter((job) => isOwnedBook(job.bookId));
    });
    ipcMain.handle("background-jobs:schedule", (_event, input: unknown) => {
      if (!input || typeof input !== "object") return invalidBackgroundJob();
      const value = input as Partial<ScheduleBackgroundJobInput>;
      if (!isOwnedBook(value.bookId)) return invalidBackgroundJob();
      const book = library.list().find((item) => item.id === value.bookId)!;
      return backgroundJobs.schedule({
        bookId: value.bookId,
        kind: value.kind as ScheduleBackgroundJobInput["kind"],
        priority: value.priority,
        total: book.pageCount,
        inputVersion: value.inputVersion,
        maxAttempts: value.maxAttempts,
        startPage: value.startPage,
      });
    });
    ipcMain.handle("background-jobs:pause", (_event, jobId: unknown) => mutateOwnedJob(jobId, "pause"));
    ipcMain.handle("background-jobs:resume", (_event, jobId: unknown) => mutateOwnedJob(jobId, "resume"));
    ipcMain.handle("background-jobs:cancel", (_event, jobId: unknown) => mutateOwnedJob(jobId, "cancel"));
    ipcMain.handle("memory:list-proposals", (_event, bookId: unknown) => isOwnedBook(bookId) ? memory.listProposals(bookId) : []);
    ipcMain.handle("memory:list", (_event, bookId: unknown) => isOwnedBook(bookId) ? memory.listMemories(bookId) : []);
    ipcMain.handle("memory:audit", (_event, bookId: unknown) => isOwnedBook(bookId) ? memory.listAudit(bookId) : []);
    ipcMain.handle("memory:review-proposal", (_event, input: unknown) => {
      if (!input || typeof input !== "object") return { ok: false, code: "VALIDATION_ERROR", message: "记忆审核操作无效。" };
      const value = input as { bookId?: unknown; proposalId?: unknown; action?: unknown };
      if (!isOwnedBook(value.bookId) || typeof value.proposalId !== "string" || (value.action !== "approve" && value.action !== "reject")) {
        return { ok: false, code: "VALIDATION_ERROR", message: "记忆审核操作无效。" };
      }
      return memory.review({ bookId: value.bookId, proposalId: value.proposalId, action: value.action }, value.bookId);
    });
    ipcMain.handle("memory:revoke", (_event, input: unknown) => {
      if (!input || typeof input !== "object") return { ok: false, code: "VALIDATION_ERROR", message: "撤销记忆操作无效。" };
      const value = input as { bookId?: unknown; memoryId?: unknown };
      if (!isOwnedBook(value.bookId) || typeof value.memoryId !== "string") return { ok: false, code: "VALIDATION_ERROR", message: "撤销记忆操作无效。" };
      return memory.revoke(value.memoryId, value.bookId);
    });
    ipcMain.handle("agent:approve-tool", (_event, input: unknown) => {
      if (!input || typeof input !== "object") return { ok: false, message: "审批操作无效。" };
      const value = input as { approvalId?: unknown; approved?: unknown };
      if (typeof value.approvalId !== "string" || typeof value.approved !== "boolean") return { ok: false, message: "审批操作无效。" };
      return agentHost.approveTool({ approvalId: value.approvalId, approved: value.approved });
    });
    ipcMain.handle("agent:start-run", (_event, input: unknown) => agentHost.start(input));
    ipcMain.handle("agent:cancel-run", (_event, runId: unknown) => agentHost.cancel(runId));
    ipcMain.handle("reader-profile:get", () => readerProfile.get());
    ipcMain.handle("reader-profile:save", (_event, input: unknown) => readerProfile.save(input));
  }
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.once("before-quit", () => {
  closeBackgroundJobs?.();
  closeBackgroundJobs = undefined;
  closeBookOutline?.();
  closeBookOutline = undefined;
  closeLibrary?.();
  closeLibrary = undefined;
  closeAgentHost?.();
  closeAgentHost = undefined;
  closeBookIndex?.();
  closeBookIndex = undefined;
  closeMemory?.();
  closeMemory = undefined;
  closeOcr?.();
  closeOcr = undefined;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
