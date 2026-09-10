import { contextBridge, ipcRenderer, webUtils } from "electron";

import type { AgentStreamEvent, PDFMuseApi } from "../shared/contracts.js";

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
  removeLibraryBook: (bookId) => ipcRenderer.invoke("library:remove", bookId),
  deleteLibraryBookData: (bookId) => ipcRenderer.invoke("library:delete-data", bookId),
  unlockPdfBook: (challengeId, password, rememberPassword) => (
    ipcRenderer.invoke("library:unlock", challengeId, password, rememberPassword)
  ),
  updateLibraryBookState: (bookId, state) => ipcRenderer.invoke("library:update-state", bookId, state),
  getModelConnection: () => ipcRenderer.invoke("model-connection:get"),
  saveModelConnection: (input) => ipcRenderer.invoke("model-connection:save", input),
  testModelConnection: (input) => ipcRenderer.invoke("model-connection:test", input),
  getEmbeddingConnection: () => ipcRenderer.invoke("embedding-connection:get"),
  saveEmbeddingConnection: (input) => ipcRenderer.invoke("embedding-connection:save", input),
  testEmbeddingConnection: (input) => ipcRenderer.invoke("embedding-connection:test", input),
  getBookConversation: (bookId) => ipcRenderer.invoke("agent:get-conversation", bookId),
  getRunDiagnostics: (bookId) => ipcRenderer.invoke("agent:get-run-diagnostics", bookId),
  clearBookConversation: (bookId) => ipcRenderer.invoke("agent:clear-conversation", bookId),
  exportBookConversation: (bookId) => ipcRenderer.invoke("agent:export-conversation", bookId),
  recognizePage: (input) => ipcRenderer.invoke("ocr:recognize-page", input),
  getRecognizedPage: (bookId, page) => ipcRenderer.invoke("ocr:get-page", bookId, page),
  searchBook: (bookId, query, limit) => ipcRenderer.invoke("book:search", bookId, query, limit),
  getBookOutline: (bookId) => ipcRenderer.invoke("outline:get", bookId),
  listBackgroundJobs: (bookId) => ipcRenderer.invoke("background-jobs:list", bookId),
  scheduleBackgroundJob: (input) => ipcRenderer.invoke("background-jobs:schedule", input),
  pauseBackgroundJob: (jobId) => ipcRenderer.invoke("background-jobs:pause", jobId),
  resumeBackgroundJob: (jobId) => ipcRenderer.invoke("background-jobs:resume", jobId),
  cancelBackgroundJob: (jobId) => ipcRenderer.invoke("background-jobs:cancel", jobId),
  startAgentRun: (input) => ipcRenderer.invoke("agent:start-run", input),
  cancelAgentRun: (runId) => ipcRenderer.invoke("agent:cancel-run", runId),
  onAgentEvent: (listener) => {
    const channel = (_event: Electron.IpcRendererEvent, payload: AgentStreamEvent) => listener(payload);
    ipcRenderer.on("agent:event", channel);
    return () => ipcRenderer.removeListener("agent:event", channel);
  },
  getReaderProfile: () => ipcRenderer.invoke("reader-profile:get"),
  saveReaderProfile: (input) => ipcRenderer.invoke("reader-profile:save", input),
  getAppearanceSettings: () => ipcRenderer.invoke("appearance-settings:get"),
  saveAppearanceSettings: (input) => ipcRenderer.invoke("appearance-settings:save", input),
  getWebSearchConnection: () => ipcRenderer.invoke("web-search-connection:get"),
  saveWebSearchConnection: (input) => ipcRenderer.invoke("web-search-connection:save", input),
};

contextBridge.exposeInMainWorld("pdfMuse", api);
