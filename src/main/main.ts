import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, ipcMain, Menu, net } from "electron";

import { preflightDataHome } from "./data-home.js";
import { createEmbeddingConnectionModule } from "./embedding-connection.js";
import { scheduleEmbeddingJobIfConfigured } from "./embedding-job-scheduler.js";
import { createLibraryModule } from "./library.js";
import { createModelConnectionModule } from "./model-connection.js";
import { readAppConfig, updateAppConfig, type StoredAppConfig } from "./config-store.js";
import { createAgentHost, type AgentHost } from "./agent/agent-host.js";
import { createBookIndex } from "./agent/book-index.js";
import { buildConversationExportFilename, buildConversationMarkdown, selectExportableMessages } from "./agent/conversation-export.js";
import type { ResolvedModelConnection } from "./agent/model-runtime.js";
import { buildAiOutlineCompleter } from "./agent/outline-ai.js";
import { createSessionStore } from "./agent/session-store.js";
import { createToolRegistry } from "./agent/tool-registry.js";
import { createWebSearchModule } from "./agent/web-search.js";
import { createToolMedia } from "./tool-media.js";
import { createOcrModule } from "./ocr.js";
import { createWorkerMineruEngine } from "./mineru.js";
import { createPageRenderer } from "./page-render.js";
import { createPdfDocumentBroker } from "./pdf-document-broker.js";
import { createBackgroundJobModule } from "./background-jobs.js";
import { createRecognizedTextIngestion } from "./recognized-text-ingestion.js";
import {
  createBookOutlineModule,
  findOutlineChapterRange,
  findOutlineSectionPath,
  traceWindowSnapshot,
} from "./book-outline.js";
import { createOcrJobExecutor } from "./ocr-job.js";
import { createPipelineTracer, readPipelineTrace } from "./pipeline-trace.js";
import { createReaderProfileModule } from "./reader-profile.js";
import { createAppearanceSettingsModule } from "./appearance-settings.js";
import type {
  AgentStreamEvent,
  BackgroundStateEvent,
  BackgroundJobMutationResult,
  ExportConversationResult,
  LibraryMutationResult,
  ScheduleBackgroundJobInput,
  SaveEmbeddingConnectionInput,
  SaveWebSearchConnectionResult,
  SaveModelConnectionInput,
  StartupPreflight,
  TestEmbeddingConnectionInput,
  TestModelConnectionInput,
} from "../shared/contracts.js";
import { resolveModelContextWindow } from "../shared/contracts.js";
import { MINERU_ENGINE_VERSION, MINERU_INPUT_VERSION, MINERU_MODEL } from "../shared/mineru-config.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
let startupPreflight: StartupPreflight;
let closeLibrary: (() => void) | undefined;
let closeAgentHost: (() => void) | undefined;
let closeBookIndex: (() => void) | undefined;
let closeOcr: (() => void) | undefined;
let closeBackgroundJobs: (() => void) | undefined;
let closeBookOutline: (() => void) | undefined;
let disposePdfBroker: (() => void) | undefined;

// 组装根唯一的窗口广播：agent 事件与后台状态推送共用同一遍历（ADR-0008 泛化 agent broadcast）。
function broadcastToWindows(channel: string, payload: unknown) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

function broadcastAgentEvent(event: AgentStreamEvent) {
  broadcastToWindows("agent:event", event);
}

// 后台状态推送（ADR-0008）：模块只发「某书变了」通知，这里组装完整状态分片 + 单调 revision 广播。
let backgroundStateRevision = 0;
type BackgroundStateEventInput = BackgroundStateEvent extends infer Variant ? Variant extends BackgroundStateEvent ? Omit<Variant, "revision"> : never : never;
function broadcastBackgroundState(event: BackgroundStateEventInput) {
  const payload: BackgroundStateEvent = { ...event, revision: (backgroundStateRevision += 1) };
  broadcastToWindows("background:event", payload);
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
    const getBookTitle = (bookId: unknown): string => (
      typeof bookId === "string" ? library.list().find((book) => book.id === bookId)?.title ?? "" : ""
    );
    closeLibrary = library.close;
    const configPath = path.join(startupPreflight.dataHome, "config.json");
    const readerProfile = createReaderProfileModule(startupPreflight.dataHome);
    const appearanceSettings = createAppearanceSettingsModule(startupPreflight.dataHome);
    // 管线观测 trace（常驻写入不门控 dev；写失败不影响管线）：data/logs/ 下按书分 JSONL。
    const traceLogDirectory = path.join(startupPreflight.dataHome, "logs");
    const tracer = createPipelineTracer({ logDirectory: traceLogDirectory });
    // 识别块直读是多家管线（目录定位、触发探针、观测快照）共用的最小读接口。
    const readRecognizedBlocks = (bookId: string, page: number) => ocr.getPage(bookId, page)?.blocks;
    const mineruEngine = createWorkerMineruEngine({
      command: path.join(applicationDirectory(), "resources", "mineru-runtime", process.platform === "win32" ? "python.exe" : "python"),
      args: [path.join(applicationDirectory(), "resources", "mineru-worker", "mineru_worker.py")],
      mineruHome: path.join(applicationDirectory(), "resources", "mineru-runtime", "home"),
      smallBackend: "torch",
      model: MINERU_MODEL,
      inputVersion: MINERU_INPUT_VERSION,
      engineVersion: MINERU_ENGINE_VERSION,
    });
    const ocr = createOcrModule(startupPreflight.dataHome, mineruEngine, {
      resolvePdfPath: (bookId) => {
        const source = library.getBookSource(bookId);
        return source ? { path: source.path, encrypted: Boolean(source.savedPassword) } : undefined;
      },
    });
    closeOcr = ocr.close;
    // PDF 文档句柄中介（T60）：渲染、整书抽取共享 per-book 文档句柄（一次解析），
    // LRU 容量 2、空闲 5 分钟回收；书源经检索模块的既有读接口加载（原文件只读）。
    const pdfBroker = createPdfDocumentBroker({
      loadBook: (bookId) => bookIndex.loadBookByBookId(bookId),
    });
    disposePdfBroker = pdfBroker.dispose;
    const bookIndex = createBookIndex(startupPreflight.dataHome, {
      onEmbeddingError: (error) => {
        const diagnostic = error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: "UnknownError", message: String(error) };
        console.error("语义索引底层请求失败：", diagnostic);
      },
      // 语义向量构建转交通道：检索/索引路径发现向量缺失时排后台任务立即返回（首问不再阻塞整书补建）；
      // 任务按（书, embedding kind）去重，优先级与 Recognized Text Ingestion 的语义调度一致。
      scheduleEmbeddingBuild: (bookId) => {
        void scheduleOptionalEmbedding({
          bookId,
          priority: 5,
          total: library.getBookSource(bookId)?.pageCount ?? 0,
        });
      },
      getEmbeddingProvider: async () => {
        const config = await readAppConfig(configPath);
        if (!config.embedding) return undefined;
        return {
          model: config.embedding.model,
          embed: (inputs: readonly string[], signal?: AbortSignal) => embeddingConnection.embed(inputs, signal),
        };
      },
      getBookSource: (bookId) => library.getBookSource(bookId),
      readRecognizedBlocks: (bookId, page) => ocr.getPage(bookId, page)?.blocks,
      acquireDocument: (bookId) => pdfBroker.acquire(bookId),
    });
    closeBookIndex = bookIndex.close;
    // 页面渲染独立模块（T34）：OCR 链路、视觉工具与目录 AI 共用，检索模块不再依赖 canvas。
    const pageRenderer = createPageRenderer((bookId) => bookIndex.loadBookByBookId(bookId), pdfBroker);
    const sessionStore = createSessionStore(startupPreflight.dataHome, {
      deleteConversationEmbeddings: bookIndex.deleteConversationEmbeddings,
    });
    const loadChatConnection = async (): Promise<ResolvedModelConnection | undefined> => {
      const config = await readAppConfig(configPath);
      return config.chat
        ? {
          protocol: config.chat.protocol,
          baseUrl: config.chat.baseUrl,
          model: config.chat.model,
          ...(config.chat.apiKey ? { apiKey: config.chat.apiKey } : {}),
          contextWindow: resolveModelContextWindow(config.chat.contextWindow),
        }
        : undefined;
    };
    const bookOutline = createBookOutlineModule(startupPreflight.dataHome, {
      readRecognizedBlocks,
      aiOutline: {
        renderPage: pageRenderer.renderPage,
        complete: buildAiOutlineCompleter({ loadConnection: loadChatConnection }),
      },
      onOutlineChange: (bookId) => broadcastBackgroundState({
        kind: "outline",
        bookId,
        strategy: bookOutline.strategy(bookId),
        nodes: bookOutline.get(bookId),
        calibrated: bookOutline.calibrated(bookId),
      }),
      tracer,
    });
    closeBookOutline = bookOutline.close;
    const scheduleOptionalEmbedding = (input: Omit<ScheduleBackgroundJobInput, "kind">) => (
      scheduleEmbeddingJobIfConfigured(input, {
        loadConfig: () => readAppConfig(configPath),
        schedule: (job) => backgroundJobs.schedule(job),
      })
    );
    // Recognized Text Ingestion：识别一页后的索引、语义调度、目录联动与断点协议收进一个模块。
    const ingestion = createRecognizedTextIngestion({
      indexRecognizedPage: (bookId, page, lines) => bookIndex.indexRecognizedPage(bookId, page, lines),
      scheduleEmbedding: scheduleOptionalEmbedding,
      invalidateOutline: (bookId, page) => bookOutline.invalidate(bookId, page),
      loadPageCount: (bookId) => library.getBookSource(bookId)?.pageCount ?? 0,
      listJobs: (bookId) => backgroundJobs.list(bookId),
      cancelJob: (id) => backgroundJobs.cancel(id),
      scheduleJob: (input) => backgroundJobs.schedule(input),
    });
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
        if (!config.embedding?.baseUrl.trim() || !config.embedding.model.trim()) return;
        if (context.signal.aborted) throw new Error("嵌入任务已暂停或取消。");
        const completed = await bookIndex.ensureEmbeddings(job.bookId, context.signal);
        if (!completed) throw new Error("语义索引生成失败，当前继续使用全文检索。");
        const stats = bookIndex.stats(job.bookId);
        context.checkpoint(`page:${stats.indexedPages}`, stats.indexedPages, stats.totalPages);
      },
      // OCR 整书执行器（T58-03 统一目录流）：线性扫描、弹性池派页、断点前沿与数据触发器
      // （目录数据就绪即交棒重排）；依赖全注入，模块级测试覆盖触发/断点/续跑。
      ocr: createOcrJobExecutor({
        loadBook: (bookId) => library.list().find((item) => item.id === bookId),
        getPageBlocks: readRecognizedBlocks,
        isPageCompatible: (bookId, page) => ocr.isPageCompatible(bookId, page, MINERU_ENGINE_VERSION, MINERU_MODEL, MINERU_INPUT_VERSION),
        recognizePage: (input, signal) => ocr.recognizePage(input, signal),
        ingestPage: (bookId, page, blocks) => ingestion.ingestRecognizedPage(bookId, page, blocks, "background"),
        scheduleOutlineRerank: ingestion.scheduleOutlineRerank,
        completeBook: (bookId) => ingestion.completeBookOcr(bookId),
        decodeCheckpoint: ingestion.decodeOcrCheckpoint,
        encodeCheckpoint: ingestion.encodeOcrCheckpoint,
        createFrontier: ingestion.createOcrFrontier,
        concurrency: mineruEngine.concurrency,
        tracer,
      }),
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
    }, (bookId) => broadcastBackgroundState({ kind: "jobs", bookId, jobs: backgroundJobs.list(bookId) }));
    closeBackgroundJobs = backgroundJobs.close;
    // 每书数据所有权（ADR 0007）：各数据模块注册自己的清理钩子，Library 删除时按注册顺序遍历。
    library.registerBookDataCleaner(bookIndex.deleteBookData);
    library.registerBookDataCleaner(sessionStore.deleteBookData);
    library.registerBookDataCleaner(bookOutline.deleteBookData);
    library.registerBookDataCleaner(ocr.deleteBookData);
    library.registerBookDataCleaner(backgroundJobs.deleteBookData);
    // T44：view_page 原图媒体目录（<dataHome>/media/<bookId>），删除书籍数据时整目录移除。
    const toolMedia = createToolMedia(startupPreflight.dataHome);
    library.registerBookDataCleaner(toolMedia.deleteBookData);
    void readAppConfig(configPath)
      .then((config) => {
        if (!config.embedding?.baseUrl.trim() || !config.embedding.model.trim()) {
          backgroundJobs.clearFailed("embedding");
        }
      })
      .catch((error) => console.error("读取嵌入模型配置失败，无法清理历史语义索引任务。", error));
    // 网络搜索：默认 DuckDuckGo（免 Key，Electron net.fetch 遵循系统代理），配置 Tavily Key 后优先并支持降级。
    const webSearch = createWebSearchModule({
      loadTavilyApiKey: async () => (await readAppConfig(configPath)).webSearch?.tavilyApiKey,
      fetchImpl: (input, init) => net.fetch(input, init),
    });
    const toolRegistry = createToolRegistry();
    const agentHost: AgentHost = createAgentHost({
      dataHome: startupPreflight.dataHome,
      store: sessionStore,
      emit: broadcastAgentEvent,
      loadModelConnection: loadChatConnection,
      loadReaderProfile: async () => (await readerProfile.get()).content,
      loadBookTitle: (bookId) => getBookTitle(bookId) || undefined,
      resolveReadingSection: (bookId, page) => findOutlineSectionPath(bookOutline.get(bookId) ?? [], page),
      // 顶层章节页码范围：只进检索加权，不进模型可见文字（同 T24 的 Reading Focus 原则）。
      resolveChapterRange: (bookId, page) => {
        const nodes = bookOutline.get(bookId);
        const pageCount = library.getBookSource(bookId)?.pageCount ?? 0;
        return nodes && pageCount > 0 ? findOutlineChapterRange(nodes, page, pageCount) : undefined;
      },
      isKnownBook: isOwnedBook,
      // T64 引用落地校验的语料读接口：声明页/证据页的已索引文本（未索引页 undefined）。
      readIndexedPageText: (bookId, page) => bookIndex.readPages(bookId, page, page)[0]?.text,
      countIndexedPages: (bookId) => bookIndex.stats(bookId).indexedPages,
      buildTools: (context) => toolRegistry.buildAgentTools(() => ({
        bookId: context.bookId,
        focus: context.focus,
        reportEvidence: context.reportEvidence,
        pageBudget: context.pageBudget,
        bookIndex,
        getOutline: (id) => bookOutline.get(id),
        renderPageImage: pageRenderer.renderPage,
        renderRegionImage: pageRenderer.renderRegion,
        savePageImage: toolMedia.savePageImage,
        loadPageImage: toolMedia.loadPageImage,
        loadRenderedImage: toolMedia.loadRenderedImage,
        saveRenderedImage: toolMedia.saveRenderedImage,
        webSearch,
      })),
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
    // 打开书籍即后台预热：仅扫描书（已有识别历史）会拉起 worker，吸收首次识别的模型加载延迟（T49）。
    function bookIdOf(result: unknown): string | undefined {
      if (typeof result !== "object" || result === null) return undefined;
      const id = (result as { id?: unknown }).id;
      return typeof id === "string" ? id : undefined;
    }
    const openBookAndPreheat = async (open: () => unknown) => {
      const result = await open();
      const bookId = bookIdOf(result);
      if (bookId) void ocr.preheat(bookId);
      return result;
    };
    ipcMain.handle("library:choose", async () => {
      const result = await dialog.showOpenDialog({
        title: "打开 PDF 书籍",
        properties: ["openFile"],
        filters: [{ name: "PDF 文件", extensions: ["pdf"] }],
      });
      const selectedPath = result.filePaths[0];
      if (result.canceled || !selectedPath) return null;
      return openBookAndPreheat(() => library.openPath(selectedPath));
    });
    ipcMain.handle("library:open-path", (_event, filePath: unknown) => openBookAndPreheat(() => library.openPath(filePath)));
    ipcMain.handle("library:open-recent", () => openBookAndPreheat(() => library.openRecent()));
    ipcMain.handle("library:open-known", (_event, bookId: unknown) => openBookAndPreheat(() => library.openKnown(bookId)));
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
    ipcMain.handle("web-search-connection:get", async () => ({
      tavilyApiKeySet: Boolean((await readAppConfig(configPath)).webSearch?.tavilyApiKey),
    }));
    ipcMain.handle("web-search-connection:save", async (_event, input: unknown): Promise<SaveWebSearchConnectionResult> => {
      if (!input || typeof input !== "object") {
        return { ok: false, code: "VALIDATION_ERROR", message: "网络搜索配置无效。" };
      }
      const value = input as { tavilyApiKey?: unknown; clearApiKey?: unknown };
      const incomingKey = typeof value.tavilyApiKey === "string" ? value.tavilyApiKey.trim() : "";
      if (value.tavilyApiKey !== undefined && !incomingKey && value.tavilyApiKey !== "") {
        return { ok: false, code: "VALIDATION_ERROR", message: "Tavily API Key 必须是文本。" };
      }
      try {
        const config = await updateAppConfig(configPath, (current: StoredAppConfig) => {
          const key = value.clearApiKey
            ? undefined
            : (incomingKey || current.webSearch?.tavilyApiKey);
          return { ...current, webSearch: key ? { tavilyApiKey: key } : undefined };
        });
        return { ok: true, connection: { tavilyApiKeySet: Boolean(config.webSearch?.tavilyApiKey) } };
      } catch {
        return { ok: false, code: "WRITE_ERROR", message: "无法保存网络搜索配置，原有配置未更改。" };
      }
    });
    ipcMain.handle("agent:get-conversation", (_event, bookId: unknown) => agentHost.getConversation(bookId));
    ipcMain.handle("agent:get-run-diagnostics", (_event, bookId: unknown) => agentHost.listDiagnostics(bookId));
    ipcMain.handle("agent:clear-conversation", (_event, bookId: unknown) => agentHost.clearConversation(bookId));
    ipcMain.handle("agent:export-conversation", async (_event, bookId: unknown): Promise<ExportConversationResult> => {
      const messages = agentHost.getConversation(bookId);
      if (selectExportableMessages(messages).length === 0) {
        return { outcome: "failed", message: "本书会话为空，没有可导出的对话。" };
      }
      const title = getBookTitle(bookId);
      const exportedAt = new Date();
      const save = await dialog.showSaveDialog({
        title: "导出会话为 Markdown",
        defaultPath: buildConversationExportFilename(title, exportedAt),
        filters: [{ name: "Markdown 文件", extensions: ["md"] }],
      });
      if (!save.filePath) return { outcome: "cancelled" };
      try {
        await writeFile(save.filePath, buildConversationMarkdown({ title, messages, exportedAt }), "utf8");
        return { outcome: "saved", path: save.filePath };
      } catch {
        return { outcome: "failed", message: "无法写入导出文件，请检查保存位置后重试。" };
      }
    });
    ipcMain.handle("ocr:get-page", (_event, bookId: unknown, page: unknown) => (
      isOwnedBook(bookId) && typeof page === "number" ? ocr.getPage(bookId, page) : undefined
    ));
    ipcMain.handle("ocr:recognize-page", async (_event, input: unknown) => {
      if (!input || typeof input !== "object") return { ok: false, code: "VALIDATION_ERROR", message: "OCR 页面请求无效。" };
      const value = input as { bookId?: unknown };
      if (!isOwnedBook(value.bookId)) return { ok: false, code: "VALIDATION_ERROR", message: "当前 PDF 书籍不可用。" };
      // 交互来源由主进程标注：插队派发，整书扫描让位（T49）。
      const result = await ocr.recognizePage({ ...(input as Parameters<typeof ocr.recognizePage>[0]), priority: "interactive" });
      if (result.ok) {
        await ingestion.ingestRecognizedPage(result.page.bookId, result.page.page, result.page.blocks, "interactive");
      }
      return result;
    });
    ipcMain.handle("outline:get", async (_event, bookId: unknown) => {
      if (!isOwnedBook(bookId)) return undefined;
      // 读路径快检：缓存未命中时同步解析内嵌书签（不渲染页面），第一档开书即得；
      // 返回完整读快照（来源 + 校准标记 + 节点），与推送事件同构。
      await bookOutline.ensureEmbedded(bookId, () => bookIndex.loadBookByBookId(bookId));
      return bookOutline.read(bookId);
    });
    // 管线观测读通道（只读，注册不门控 dev——面板才是 dev 门控的部分）：
    // 事件搬运 / 窗口快照现算 / 某页原始识别块 / 该书任务流水；无此书返回空态而非报错。
    ipcMain.handle("trace:get", (_event, bookId: unknown) => (
      isOwnedBook(bookId) ? readPipelineTrace(traceLogDirectory, bookId) : []
    ));
    ipcMain.handle("trace:snapshot", (_event, bookId: unknown) => {
      if (!isOwnedBook(bookId)) return traceWindowSnapshot(0, () => undefined);
      const pageCount = library.getBookSource(bookId)?.pageCount ?? 0;
      return traceWindowSnapshot(pageCount, (page) => readRecognizedBlocks(bookId, page));
    });
    ipcMain.handle("trace:page-blocks", (_event, bookId: unknown, page: unknown) => (
      isOwnedBook(bookId) && typeof page === "number" && Number.isSafeInteger(page) && page >= 1
        ? readRecognizedBlocks(bookId, page) ?? []
        : []
    ));
    ipcMain.handle("trace:jobs", (_event, bookId: unknown) => (
      isOwnedBook(bookId) ? backgroundJobs.list(bookId) : []
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
      });
    });
    ipcMain.handle("background-jobs:pause", (_event, jobId: unknown) => mutateOwnedJob(jobId, "pause"));
    ipcMain.handle("background-jobs:resume", (_event, jobId: unknown) => mutateOwnedJob(jobId, "resume"));
    ipcMain.handle("background-jobs:cancel", (_event, jobId: unknown) => mutateOwnedJob(jobId, "cancel"));
    ipcMain.handle("agent:start-run", (_event, input: unknown) => agentHost.start(input));
    ipcMain.handle("agent:cancel-run", (_event, runId: unknown) => agentHost.cancel(runId));
    ipcMain.handle("reader-profile:get", () => readerProfile.get());
    ipcMain.handle("reader-profile:save", (_event, input: unknown) => readerProfile.save(input));
    ipcMain.handle("appearance-settings:get", () => appearanceSettings.get());
    ipcMain.handle("appearance-settings:save", (_event, input: unknown) => appearanceSettings.save(input));
  }
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.once("before-quit", () => {
  disposePdfBroker?.();
  disposePdfBroker = undefined;
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
  closeOcr?.();
  closeOcr = undefined;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
