import type { PDFMuseApi } from "../shared/contracts";

/**
 * 渲染端实际使用的全部 preload API 方法。
 * satisfies Record<keyof PDFMuseApi, true> 保证：新增接口方法漏列、或删除/改名
 * 已有方法时，这里会在编译期报错，清单永不漂移。
 */
const REQUIRED_API_METHODS = {
  getStartupPreflight: true,
  listLibraryBooks: true,
  choosePdfBook: true,
  openDroppedPdf: true,
  openRecentLibraryBook: true,
  openLibraryBook: true,
  relocateLibraryBook: true,
  removeLibraryBook: true,
  deleteLibraryBookData: true,
  unlockPdfBook: true,
  updateLibraryBookState: true,
  getModelConnection: true,
  saveModelConnection: true,
  testModelConnection: true,
  getEmbeddingConnection: true,
  saveEmbeddingConnection: true,
  testEmbeddingConnection: true,
  getBookConversation: true,
  getRunDiagnostics: true,
  clearBookConversation: true,
  exportBookConversation: true,
  recognizePage: true,
  getRecognizedPage: true,
  getBookOutline: true,
  listBackgroundJobs: true,
  scheduleBackgroundJob: true,
  pauseBackgroundJob: true,
  resumeBackgroundJob: true,
  cancelBackgroundJob: true,
  startAgentRun: true,
  cancelAgentRun: true,
  onAgentEvent: true,
  onBackgroundEvent: true,
  getReaderProfile: true,
  saveReaderProfile: true,
  getAppearanceSettings: true,
  saveAppearanceSettings: true,
  getWebSearchConnection: true,
  saveWebSearchConnection: true,
} satisfies Record<keyof PDFMuseApi, true>;

/**
 * 检测 preload 版本错配（渲染端更新而 Electron 主进程未重启）。
 * 返回缺失的方法名；浏览器预览模式（无 pdfMuse）返回空。
 */
export function findMissingApiMethods(api: PDFMuseApi | undefined): string[] {
  if (!api) return [];
  const available = api as unknown as Record<string, unknown>;
  return Object.keys(REQUIRED_API_METHODS).filter((method) => typeof available[method] !== "function");
}
