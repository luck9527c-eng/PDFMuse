import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";

import { preflightDataHome } from "./data-home.js";
import type { OpenedPdfBook, StartupPreflight } from "../shared/contracts.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
let startupPreflight: StartupPreflight;

function applicationDirectory() {
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
