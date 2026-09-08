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

export type ReadingZoomMode = "page-width" | "page-fit" | "custom";

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

export function isModelProtocol(value: unknown): value is ModelProtocol {
  return value === "openai" || value === "anthropic";
}

export type ModelConnectionState = {
  protocol: ModelProtocol;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
};

export type SaveModelConnectionInput = {
  protocol: ModelProtocol;
  baseUrl: string;
  model: string;
  apiKey?: string;
  clearApiKey?: boolean;
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

export type MemorySource = "pdf" | "conversation" | "summary" | "web";
export type MemoryTrust = "trusted" | "untrusted";
export type MemoryProposalStatus = "pending" | "approved" | "rejected" | "revoked";

export type BookMemory = {
  id: string;
  bookId: string;
  content: string;
  source: MemorySource;
  sourceId?: string;
  page?: number;
  trust: MemoryTrust;
  createdAt: string;
  confirmedAt: string;
  revokedAt?: string;
};

export type MemoryProposal = {
  id: string;
  bookId: string;
  content: string;
  source: MemorySource;
  sourceId?: string;
  page?: number;
  trust: MemoryTrust;
  status: MemoryProposalStatus;
  createdAt: string;
  reviewedAt?: string;
  memoryId?: string;
};

export type MemorySearchResult = BookMemory & { score: number };

export type ProposeMemoryInput = {
  bookId: string;
  content: string;
  source?: MemorySource;
  sourceId?: string;
  page?: number;
  provenance?: "agent" | "reader" | "pdf-evidence" | "conversation" | "summary" | "web";
};

export type MemoryMutationResult =
  | { ok: true; memory?: BookMemory; proposal?: MemoryProposal }
  | { ok: false; code: "VALIDATION_ERROR" | "NOT_FOUND" | "CONFLICT"; message: string };

export type MemoryProposalReviewInput = {
  bookId: string;
  proposalId: string;
  action: "approve" | "reject";
};

export type MemoryRevokeInput = {
  bookId: string;
  memoryId: string;
};

export type MemoryAuditEntry = {
  id: string;
  bookId: string;
  proposalId?: string;
  memoryId?: string;
  action: string;
  details?: string;
  createdAt: string;
};

/** 回答引用的 PDF Evidence：来自当前书的可信检索结果，可点击跳回原文。 */
export type ConversationEvidence = {
  source: "pdf";
  page: number;
  snippet: string;
  trust: "trusted";
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

export type ReadingFocus = {
  currentPage: number;
  selectedPassage?: SelectedPassage;
};

export type OcrPoint = { x: number; y: number };
export type RecognizedTextLine = {
  text: string;
  confidence: number;
  polygon: OcrPoint[];
};
export type RecognizedPageText = {
  bookId: string;
  page: number;
  width: number;
  height: number;
  orientation: number;
  lines: RecognizedTextLine[];
  engine: string;
  model: string;
  inputHash: string;
  inputVersion?: string;
  engineVersion: string;
  createdAt: string;
};
export type OcrPageRequest = {
  bookId: string;
  page: number;
  imageData: string;
  width: number;
  height: number;
};
export type OcrPageResult =
  | { ok: true; page: RecognizedPageText }
  | { ok: false; code: "VALIDATION_ERROR" | "UNAVAILABLE" | "FAILED" | "CANCELLED"; message: string };

export type BookOutlineNode = {
  id: string;
  label: string;
  page?: number;
  children: BookOutlineNode[];
};

export type PdfSearchResult = {
  status: "ok" | "partial" | "unavailable";
  hits: Array<{ page?: number; snippet: string; source?: "pdf" | "conversation" }>;
  indexedPages: number;
  totalPages: number;
  note?: string;
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
  startPage?: number;
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

export type AgentStreamEvent =
  | {
      stream: "lifecycle";
      phase: "start" | "finishing" | "end" | "cancelled" | "error" | "waiting-approval";
      runId: string;
      sessionId: string;
      approvalId?: string;
      toolName?: string;
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
  clearBookConversation(bookId: string): Promise<ClearBookConversationResult>;
  recognizePage(input: OcrPageRequest): Promise<OcrPageResult>;
  getRecognizedPage(bookId: string, page: number): Promise<RecognizedPageText | undefined>;
  searchBook(bookId: string, query: string, limit?: number): Promise<PdfSearchResult>;
  getBookOutline(bookId: string): Promise<BookOutlineNode[] | undefined>;
  listBackgroundJobs(bookId?: string): Promise<BackgroundJob[]>;
  scheduleBackgroundJob(input: ScheduleBackgroundJobInput): Promise<BackgroundJobMutationResult>;
  pauseBackgroundJob(jobId: string): Promise<BackgroundJobMutationResult>;
  resumeBackgroundJob(jobId: string): Promise<BackgroundJobMutationResult>;
  cancelBackgroundJob(jobId: string): Promise<BackgroundJobMutationResult>;
  listMemoryProposals(bookId: string): Promise<MemoryProposal[]>;
  listBookMemories(bookId: string): Promise<BookMemory[]>;
  listMemoryAudit(bookId: string): Promise<MemoryAuditEntry[]>;
  reviewMemoryProposal(input: MemoryProposalReviewInput): Promise<MemoryMutationResult>;
  revokeBookMemory(input: MemoryRevokeInput): Promise<MemoryMutationResult>;
  approveAgentTool(input: { approvalId: string; approved: boolean }): Promise<{ ok: true } | { ok: false; message: string }>;
  startAgentRun(input: StartAgentRunInput): Promise<StartAgentRunResult>;
  cancelAgentRun(runId: string): Promise<void>;
  onAgentEvent(listener: (event: AgentStreamEvent) => void): () => void;
  getReaderProfile(): Promise<ReaderProfileState>;
  saveReaderProfile(input: SaveReaderProfileInput): Promise<SaveReaderProfileResult>;
}
