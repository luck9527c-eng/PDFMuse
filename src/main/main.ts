import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";

import { preflightDataHome } from "./data-home.js";
import { createEmbeddingConnectionModule } from "./embedding-connection.js";
import { createModelConnectionModule } from "./model-connection.js";
import type {
  OpenedPdfBook,
  SaveEmbeddingConnectionInput,
  SaveModelConnectionInput,
  StartupPreflight,
  TestEmbeddingConnectionInput,
  TestModelConnectionInput,
} from "../shared/contracts.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
let startupPreflight: StartupPreflight;

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
  }
  ipcMain.handle("pdf:choose", async (): Promise<OpenedPdfBook | null> => {
    const result = await dialog.showOpenDialog({
      title: "打开 PDF 书籍",
      properties: ["openFile"],
      filters: [{ name: "PDF 文件", extensions: ["pdf"] }],
    });

    const selectedPath = result.filePaths[0];
    if (result.canceled || !selectedPath) return null;

    const bytes = await readFile(selectedPath);
    return {
      name: path.basename(selectedPath, path.extname(selectedPath)),
      path: selectedPath,
      bytes: new Uint8Array(bytes),
    };
  });

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
