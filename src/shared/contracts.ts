import type { RegionBbox } from "./region.js";

export type PreflightFailureCode =
  | "APPLICATION_DIRECTORY_NOT_WRITABLE"
  | "DATA_HOME_NOT_WRITABLE"
  | "INVALID_CONFIG"
  | "INSUFFICIENT_DISK_SPACE";

export type StartupPreflight =
  | {
      ok: true;
      dataHome: string;
      warnings: string[];
    }
  | {
      ok: false;
      dataHome: string;
      code: PreflightFailureCode;
      message: string;
    };

export type OpenedPdfBook = {
  id: string;
  name: string;
  path: string;
  pageCount: number;
  currentPage: number;
  readingState: ReadingState;
  bytes: Uint8Array;
  password?: string;
};

export type ReadingZoomMode = "page-width" | "custom";

export type ReadingState = {
  page: number;
  scrollTop: number;
  zoomMode: ReadingZoomMode;
  zoomScale: number;
  leftSidebarOpen: boolean;
  rightSidebarOpen: boolean;
};

export type NormalizedPageRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SelectedPassage = {
  bookId: string;
  page: number;
  text: string;
  rects: NormalizedPageRect[];
};

export type LibraryBook = {
  id: string;
  title: string;
  fileName: string;
  path: string;
  pageCount: number;
  currentPage: number;
  updatedAt: string;
};

export type OpenPdfBookResult =
  | {
      ok: true;
      book: OpenedPdfBook;
    }
  | {
      ok: false;
      code: "INVALID_FILE_TYPE" | "FILE_UNAVAILABLE" | "INVALID_PDF" | "CONTENT_CHANGED";
      message: string;
      bookId?: string;
    }
  | {
      ok: false;
      code: "PASSWORD_REQUIRED";
      message: string;
      challengeId: string;
      bookId?: string;
    };

export type LibraryMutationResult =
  | {
      ok: true;
      bookId: string;
    }
  | {
      ok: false;
      code: "NOT_FOUND" | "WRITE_ERROR";
      message: string;
    };

export type ModelProtocol = "openai" | "anthropic";

/** 探测请求携带的 max-tokens 字段名；OpenAI 家族推理模型只认 max_completion_tokens，其余通行 max_tokens。 */
export type MaxTokensField = "max_tokens" | "max_completion_tokens";

export function isModelProtocol(value: unknown): value is ModelProtocol {
  return value === "openai" || value === "anthropic";
}

/** 上下文窗口两档预设（token）；压缩阈值按其中 70% 计算，默认 1M。 */
export const MODEL_CONTEXT_WINDOW_OPTIONS = [262_144, 1_048_576] as const;
export const DEFAULT_MODEL_CONTEXT_WINDOW = 1_048_576;

/** 存储的窗口值收敛到合法档位；缺省或损坏一律回落默认档（已保存连接无感迁移）。 */
export function resolveModelContextWindow(value: unknown): number {
  return (MODEL_CONTEXT_WINDOW_OPTIONS as readonly unknown[]).includes(value)
    ? value as number
    : DEFAULT_MODEL_CONTEXT_WINDOW;
}

export type ModelConnectionState = {
  protocol: ModelProtocol;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  contextWindow: number;
};

export type SaveModelConnectionInput = {
  protocol: ModelProtocol;
  baseUrl: string;
  model: string;
  apiKey?: string;
  clearApiKey?: boolean;
  contextWindow?: number;
};

export type SaveModelConnectionResult =
  | {
      ok: true;
      connection: ModelConnectionState;
    }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      message: string;
    };

export type TestModelConnectionInput = {
  protocol: ModelProtocol;
  baseUrl: string;
  model: string;
  apiKey?: string;
  clearApiKey?: boolean;
  /** 探测请求的 max-tokens 字段名；缺省 max_tokens。 */
  maxTokensField?: MaxTokensField;
};

export type TestModelConnectionResult =
  | {
      ok: true;
      model: string;
      message: string;
    }
  | {
      ok: false;
      code:
        | "VALIDATION_ERROR"
        | "AUTHENTICATION_ERROR"
        | "NETWORK_ERROR"
        | "TIMEOUT"
        | "SERVICE_ERROR"
        | "INVALID_RESPONSE";
      message: string;
    };

export type EmbeddingConnectionState = {
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
};

export type SaveEmbeddingConnectionInput = {
  baseUrl: string;
  model: string;
  apiKey?: string;
  clearApiKey?: boolean;
};

export type SaveEmbeddingConnectionResult =
  | {
      ok: true;
      connection: EmbeddingConnectionState;
    }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      message: string;
    };

export type TestEmbeddingConnectionInput = SaveEmbeddingConnectionInput;

export type TestEmbeddingConnectionResult =
  | {
      ok: true;
      model: string;
      dimensions: number;
      message: string;
    }
  | {
      ok: false;
      code:
        | "VALIDATION_ERROR"
        | "AUTHENTICATION_ERROR"
        | "NETWORK_ERROR"
        | "TIMEOUT"
        | "SERVICE_ERROR"
        | "INVALID_RESPONSE";
      message: string;
    };

export type AgentMessageStatus = "complete" | "error" | "cancelled";

/** 回答引用的 PDF Evidence：来自当前书的可信检索结果，可点击跳回原文。 */
export type ConversationEvidence = {
  source: "pdf";
  page: number;
  snippet: string;
  trust: "trusted";
  /** 检索相关度（read_pages 的整页读取视为 1）；证据聚合按页取最优、按分截断。 */
  score?: number;
};

export type ConversationMessage = {
  id: string;
  sessionId: string;
  runId: string;
  role: "reader" | "assistant";
  body: string;
  status: AgentMessageStatus;
  errorMessage?: string;
  passage?: { page: number; text: string; rects: NormalizedPageRect[] };
  evidence?: ConversationEvidence[];
  createdAt: string;
};

/** 每条回答持久化与追问注入共用的证据上限：领域不变量（按页去重、按分截断）。 */
export const CONVERSATION_EVIDENCE_MAX = 8;

export type ReadingFocus = {
  currentPage: number;
  selectedPassage?: SelectedPassage;
  /** 当前页所在章节（Main 侧由 Book Outline 解析注入，不信任 Renderer 自报）。 */
  sectionTitle?: string;
  /** 当前页所在顶层章节的页码范围（Main 侧解析，仅供检索加权，不进入模型可见文字）。 */
  chapterRange?: { from: number; to: number };
};

export type BookContext = {
  title: string;
};

export type RecognizedPageText = {
  bookId: string;
  page: number;
  /** 块级识别结果：文本/标题块的 text 为纯文本，公式块为无定界符 LaTeX，图片块可为空。 */
  blocks: MineruBlock[];
  engine: string;
  model: string;
  inputHash: string;
  inputVersion?: string;
  engineVersion: string;
  createdAt: string;
};
/** OCR 派发优先级：交互插队、批量让位（弹性池消费）。 */
export type OcrDispatchPriority = "interactive" | "bulk";

export type OcrPageRequest = {
  bookId: string;
  page: number;
  /** 渲染端不传，由主进程按来源标注。 */
  priority?: OcrDispatchPriority;
};
export type OcrPageResult =
  | { ok: true; page: RecognizedPageText }
  | { ok: false; code: "VALIDATION_ERROR" | "UNAVAILABLE" | "FAILED" | "CANCELLED"; message: string };

export type MineruBlock = { type: string; text: string; bbox: RegionBbox };
export type MineruPageRequest = { page: number; pdfPath: string; priority?: OcrDispatchPriority };
export type MineruPageData = { blocks: MineruBlock[]; markdown: string };
export type MineruWorkerResponse =
  | { id: string; ok: true; result: MineruPageData }
  | { id: string; ok: false; message: string };

/** 目录来源（T57-05 落库元信息，面板可见）：empty 表示尚无目录或无可识别结构。 */
export type BookOutlineStrategy = "embedded" | "ai_toc" | "body_headings" | "empty";
/** calibrated（T58-03）：false = 扫描书触发点的校准态页级目录（偏移换算先行），整书完成后自动转正；缺省视为已校准。 */
export type BookOutline = { strategy: BookOutlineStrategy; nodes: BookOutlineNode[]; calibrated?: boolean };
export type BookOutlineNode = {
  id: string;
  label: string;
  page?: number;
  /** 页内定位锚点（内嵌档原样保留自 PDF 书签 dest）：top 为 PDF 用户空间 Y 坐标（原点左下），
   *  跳转落到页内精确位置——同页多条目（手册条款）靠它区分落点。AI/正文识别档的数据源
   *  只有页码粒度，无此字段（跳页顶）。 */
  anchor?: { top: number };
  children: BookOutlineNode[];
};

export type BackgroundJobKind = "ocr" | "embedding" | "index" | "outline";
export type BackgroundJobStatus = "queued" | "running" | "paused" | "completed" | "cancelled" | "failed";
export type BackgroundJob = {
  id: string;
  bookId: string;
  kind: BackgroundJobKind;
  priority: number;
  status: BackgroundJobStatus;
  progress: number;
  total: number;
  checkpoint?: string;
  attempts: number;
  maxAttempts: number;
  inputVersion?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};
export type ScheduleBackgroundJobInput = {
  bookId: string;
  kind: BackgroundJobKind;
  priority?: number;
  total?: number;
  inputVersion?: string;
  maxAttempts?: number;
};
export type BackgroundJobMutationResult =
  | { ok: true; job: BackgroundJob }
  | { ok: false; code: "VALIDATION_ERROR" | "NOT_FOUND" | "CONFLICT"; message: string };

/** 当前问题的图片附件；data 仅保存不含 data: 前缀的 Base64。 */
export type AgentImageAttachment = {
  id: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  data: string;
};

export const MAX_AGENT_IMAGE_ATTACHMENTS = 4;
export const MAX_AGENT_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_AGENT_IMAGE_TOTAL_BYTES = 24 * 1024 * 1024;

export type StartAgentRunInput = {
  bookId: string;
  question: string;
  focus?: ReadingFocus;
  attachments?: AgentImageAttachment[];
};

export type StartAgentRunResult =
  | {
      ok: true;
      runId: string;
      sessionId: string;
    }
  | {
      ok: false;
      code: "VALIDATION_ERROR" | "MODEL_NOT_CONFIGURED";
      message: string;
    };

export type ClearBookConversationResult =
  | { ok: true }
  | {
      ok: false;
      code: "VALIDATION_ERROR" | "CONFLICT" | "WRITE_ERROR";
      message: string;
    };

/** 导出会话为 Markdown；cancelled 是用户在保存对话框取消，属正常结果。 */
export type ExportConversationResult =
  | { outcome: "saved"; path: string }
  | { outcome: "cancelled" }
  | { outcome: "failed"; message: string };

/** 后台状态推送（ADR-0008）：任务与生成目录的变更以完整状态分片 + 单调 revision 推送，渲染层订阅而非轮询。 */
export type BackgroundStateEvent =
  | { revision: number; kind: "jobs"; bookId: string; jobs: BackgroundJob[] }
  | { revision: number; kind: "outline"; bookId: string; strategy: BookOutlineStrategy; nodes: BookOutlineNode[] | undefined; calibrated?: boolean };

export type AgentStreamEvent =
  | {
      stream: "lifecycle";
      phase: "start" | "finishing" | "end" | "cancelled" | "error";
      runId: string;
      sessionId: string;
      /** 终态附带运行出口（T50 Exit Reason）：结束原因与已用/总圈数随事件透出。 */
      exit?: RunExitInfo;
    }
  | {
      stream: "assistant";
      runId: string;
      sessionId: string;
      delta: string;
    }
  | {
      stream: "message";
      runId: string;
      sessionId: string;
      status: AgentMessageStatus;
      errorMessage?: string;
    }
  | {
      stream: "tool";
      phase: "start" | "update" | "end";
      runId: string;
      callId: string;
      name: string;
      summary?: string;
    }
  | {
      stream: "diagnostics";
      kind: "request";
      runId: string;
      sessionId: string;
      request: RunDiagnosticsRequest;
    }
  | {
      stream: "diagnostics";
      kind: "request-complete";
      runId: string;
      sessionId: string;
      callIndex: number;
      durationMs: number;
      usage?: RunDiagnosticsUsage;
    }
  | {
      stream: "diagnostics";
      kind: "tool";
      runId: string;
      sessionId: string;
      toolCall: RunDiagnosticsToolCall;
    };

/** 诊断：一次模型调用的请求快照；messages 为 JSON 安全的序列化形式，图片数据已脱敏。 */
export type RunDiagnosticsRequest = {
  callIndex: number;
  role: "main" | "tool-turn" | "compaction";
  model: string;
  systemPrompt: string;
  messages: unknown[];
  toolNames: string[];
  startedAt: string;
  durationMs?: number;
  usage?: RunDiagnosticsUsage;
};

export type RunDiagnosticsUsage = {
  input: number;
  output: number;
  totalTokens: number;
};

export type RunDiagnosticsToolCall = {
  callId: string;
  name: string;
  parameters: unknown;
  resultText?: string;
  evidence?: ConversationEvidence[];
  durationMs: number;
  /** 被闸门拦下（已达上限/循环锤）：区分工具没有结果与被拒绝执行。 */
  blocked?: boolean;
};

/** 一问结束方式的分类（T50 Exit Reason），随运行记录落库并经共享契约透出。 */
export type AgentRunExitReason =
  | "completed"
  | "max_iterations_reached"
  | "loop_detected"
  | "wall_clock_timeout"
  | "interrupted_by_user"
  | "all_retries_exhausted_no_response"
  | "error"
  | "unknown";

export type RunExitInfo = {
  exitReason: AgentRunExitReason;
  /** 已用圈数（模型调用迭代，含其工具批；软收尾调用不扣）。 */
  roundsUsed: number;
  roundsTotal: number;
};

/** 诊断：一次运行的完整记录；仅存在于内存环形缓冲，不落盘（出口与圈数另落 agent_runs 表）。 */
export type RunDiagnostics = {
  runId: string;
  sessionId: string;
  question: string;
  startedAt: string;
  status: "running" | "complete" | "error" | "cancelled";
  requests: RunDiagnosticsRequest[];
  toolCalls: RunDiagnosticsToolCall[];
  timeline: RunDiagnosticsTimelineEntry[];
  totalDurationMs?: number;
  exitReason?: AgentRunExitReason;
  roundsUsed?: number;
  roundsTotal?: number;
};

export type RunDiagnosticsTimelineEntry = {
  at: string;
  kind: "run-start" | "request" | "request-complete" | "tool-start" | "tool-end" | "guard" | "run-end";
  detail: string;
};

export type ReaderProfileState = {
  content: string;
  updatedAt?: string;
};

export type SaveReaderProfileInput = { content: string };

export type SaveReaderProfileResult =
  | {
      ok: true;
      profile: ReaderProfileState;
    }
  | {
      ok: false;
      code: "VALIDATION_ERROR" | "WRITE_ERROR";
      message: string;
    };

export type AppearanceSettings = {
  sidebarFontSize: number;
  chatFontSize: number;
  topbarScale: number;
};

export type SaveAppearanceSettingsInput = AppearanceSettings;

export type SaveAppearanceSettingsResult =
  | {
      ok: true;
      settings: AppearanceSettings;
    }
  | {
      ok: false;
      code: "VALIDATION_ERROR" | "WRITE_ERROR";
      message: string;
    };

export type WebSearchConnectionState = {
  tavilyApiKeySet: boolean;
};

export type SaveWebSearchConnectionInput = {
  tavilyApiKey?: string;
  clearApiKey?: boolean;
};

export type SaveWebSearchConnectionResult =
  | { ok: true; connection: WebSearchConnectionState }
  | { ok: false; code: "VALIDATION_ERROR" | "WRITE_ERROR"; message: string };

export const APPEARANCE_DEFAULTS: AppearanceSettings = {
  sidebarFontSize: 11,
  chatFontSize: 12,
  topbarScale: 100,
};

export const APPEARANCE_LIMITS = {
  sidebarFontSize: { min: 10, max: 16, step: 1 },
  chatFontSize: { min: 11, max: 18, step: 1 },
  topbarScale: { min: 85, max: 125, step: 5 },
} as const;

export interface PDFMuseApi {
  getStartupPreflight(): Promise<StartupPreflight>;
  listLibraryBooks(): Promise<LibraryBook[]>;
  choosePdfBook(): Promise<OpenPdfBookResult | null>;
  openDroppedPdf(file: unknown): Promise<OpenPdfBookResult>;
  openRecentLibraryBook(): Promise<OpenPdfBookResult | null>;
  openLibraryBook(bookId: string): Promise<OpenPdfBookResult>;
  relocateLibraryBook(bookId: string): Promise<OpenPdfBookResult | null>;
  removeLibraryBook(bookId: string): Promise<LibraryMutationResult>;
  deleteLibraryBookData(bookId: string): Promise<LibraryMutationResult>;
  unlockPdfBook(challengeId: string, password: string, rememberPassword: boolean): Promise<OpenPdfBookResult>;
  updateLibraryBookState(bookId: string, state: ReadingState): Promise<void>;
  getModelConnection(): Promise<ModelConnectionState>;
  saveModelConnection(input: SaveModelConnectionInput): Promise<SaveModelConnectionResult>;
  testModelConnection(input: TestModelConnectionInput): Promise<TestModelConnectionResult>;
  getEmbeddingConnection(): Promise<EmbeddingConnectionState>;
  saveEmbeddingConnection(input: SaveEmbeddingConnectionInput): Promise<SaveEmbeddingConnectionResult>;
  testEmbeddingConnection(input: TestEmbeddingConnectionInput): Promise<TestEmbeddingConnectionResult>;
  getBookConversation(bookId: string): Promise<ConversationMessage[]>;
  getRunDiagnostics(bookId: string): Promise<RunDiagnostics[]>;
  clearBookConversation(bookId: string): Promise<ClearBookConversationResult>;
  exportBookConversation(bookId: string): Promise<ExportConversationResult>;
  recognizePage(input: OcrPageRequest): Promise<OcrPageResult>;
  getRecognizedPage(bookId: string, page: number): Promise<RecognizedPageText | undefined>;
  getBookOutline(bookId: string): Promise<BookOutline | undefined>;
  listBackgroundJobs(bookId?: string): Promise<BackgroundJob[]>;
  scheduleBackgroundJob(input: ScheduleBackgroundJobInput): Promise<BackgroundJobMutationResult>;
  pauseBackgroundJob(jobId: string): Promise<BackgroundJobMutationResult>;
  resumeBackgroundJob(jobId: string): Promise<BackgroundJobMutationResult>;
  cancelBackgroundJob(jobId: string): Promise<BackgroundJobMutationResult>;
  startAgentRun(input: StartAgentRunInput): Promise<StartAgentRunResult>;
  cancelAgentRun(runId: string): Promise<void>;
  onAgentEvent(listener: (event: AgentStreamEvent) => void): () => void;
  onBackgroundEvent(listener: (event: BackgroundStateEvent) => void): () => void;
  getReaderProfile(): Promise<ReaderProfileState>;
  saveReaderProfile(input: SaveReaderProfileInput): Promise<SaveReaderProfileResult>;
  getAppearanceSettings(): Promise<AppearanceSettings>;
  saveAppearanceSettings(input: SaveAppearanceSettingsInput): Promise<SaveAppearanceSettingsResult>;
  getWebSearchConnection(): Promise<WebSearchConnectionState>;
  saveWebSearchConnection(input: SaveWebSearchConnectionInput): Promise<SaveWebSearchConnectionResult>;
}
