import { contextBridge, ipcRenderer } from "electron";

import type { PDFMuseApi } from "../shared/contracts.js";

const api: PDFMuseApi = {
  getStartupPreflight: () => ipcRenderer.invoke("app:get-startup-preflight"),
  choosePdfBook: () => ipcRenderer.invoke("pdf:choose"),
  getModelConnection: () => ipcRenderer.invoke("model-connection:get"),
  saveModelConnection: (input) => ipcRenderer.invoke("model-connection:save", input),
  testModelConnection: (input) => ipcRenderer.invoke("model-connection:test", input),
};

contextBridge.exposeInMainWorld("pdfMuse", api);
