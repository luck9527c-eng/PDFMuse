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
import { createOcrModule } from "./ocr.js";
import { createReaderProfileModule } from "./reader-profile.js";
import type {
  AgentStreamEvent,
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
    const ocr = createOcrModule(startupPreflight.dataHome);
    closeOcr = ocr.close;
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
      isKnownBook: (bookId) => library.list().some((book) => book.id === bookId),
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
      return ocr.recognizePage(input as Parameters<typeof ocr.recognizePage>[0]);
    });
    const isOwnedBook = (bookId: unknown): bookId is string => typeof bookId === "string" && library.list().some((book) => book.id === bookId);
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
