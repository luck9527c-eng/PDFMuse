import { contextBridge, ipcRenderer } from "electron";

import type { PDFMuseApi } from "../shared/contracts.js";

const api: PDFMuseApi = {
  getStartupPreflight: () => ipcRenderer.invoke("app:get-startup-preflight"),
  choosePdfBook: () => ipcRenderer.invoke("pdf:choose"),
};

contextBridge.exposeInMainWorld("pdfMuse", api);
