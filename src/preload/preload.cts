import { contextBridge, ipcRenderer, webUtils } from "electron";

import type { PDFMuseApi } from "../shared/contracts.js";

const api: PDFMuseApi = {
  getStartupPreflight: () => ipcRenderer.invoke("app:get-startup-preflight"),
  listLibraryBooks: () => ipcRenderer.invoke("library:list"),
  choosePdfBook: () => ipcRenderer.invoke("library:choose"),
  openDroppedPdf: (file) => {
    if (!(file instanceof File)) {
      return Promise.resolve({ ok: false, code: "INVALID_FILE_TYPE", message: "请拖入一个 PDF 文件。" });
    }
    return ipcRenderer.invoke("library:open-path", webUtils.getPathForFile(file));
  },
  openRecentLibraryBook: () => ipcRenderer.invoke("library:open-recent"),
  openLibraryBook: (bookId) => ipcRenderer.invoke("library:open-known", bookId),
  relocateLibraryBook: (bookId) => ipcRenderer.invoke("library:relocate", bookId),
  updateLibraryBookState: (bookId, state) => ipcRenderer.invoke("library:update-state", bookId, state),
  getModelConnection: () => ipcRenderer.invoke("model-connection:get"),
  saveModelConnection: (input) => ipcRenderer.invoke("model-connection:save", input),
  testModelConnection: (input) => ipcRenderer.invoke("model-connection:test", input),
  getEmbeddingConnection: () => ipcRenderer.invoke("embedding-connection:get"),
  saveEmbeddingConnection: (input) => ipcRenderer.invoke("embedding-connection:save", input),
  testEmbeddingConnection: (input) => ipcRenderer.invoke("embedding-connection:test", input),
};

contextBridge.exposeInMainWorld("pdfMuse", api);
