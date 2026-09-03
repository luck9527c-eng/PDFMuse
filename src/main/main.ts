import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";

import { preflightDataHome } from "./data-home.js";
import { createEmbeddingConnectionModule } from "./embedding-connection.js";
import { createLibraryModule } from "./library.js";
import { createModelConnectionModule } from "./model-connection.js";
import { readAppConfig } from "./config-store.js";
import { createAgentHost, type AgentHost } from "./agent/agent-host.js";
import type { ResolvedModelConnection } from "./agent/model-runtime.js";
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
    ipcMain.handle("agent:start-run", (_event, input: unknown) => agentHost.start(input));
    ipcMain.handle("agent:cancel-run", (_event, runId: unknown) => agentHost.cancel(runId));
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
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
