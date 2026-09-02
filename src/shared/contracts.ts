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
  bytes: Uint8Array;
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

export interface PDFMuseApi {
  getStartupPreflight(): Promise<StartupPreflight>;
  listLibraryBooks(): Promise<LibraryBook[]>;
  choosePdfBook(): Promise<OpenPdfBookResult | null>;
  openDroppedPdf(file: unknown): Promise<OpenPdfBookResult>;
  openLibraryBook(bookId: string): Promise<OpenPdfBookResult>;
  updateLibraryBookPage(bookId: string, page: number): Promise<void>;
  getModelConnection(): Promise<ModelConnectionState>;
  saveModelConnection(input: SaveModelConnectionInput): Promise<SaveModelConnectionResult>;
  testModelConnection(input: TestModelConnectionInput): Promise<TestModelConnectionResult>;
  getEmbeddingConnection(): Promise<EmbeddingConnectionState>;
  saveEmbeddingConnection(input: SaveEmbeddingConnectionInput): Promise<SaveEmbeddingConnectionResult>;
  testEmbeddingConnection(input: TestEmbeddingConnectionInput): Promise<TestEmbeddingConnectionResult>;
}
