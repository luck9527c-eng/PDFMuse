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
  name: string;
  path: string;
  bytes: Uint8Array;
};

export interface PDFMuseApi {
  getStartupPreflight(): Promise<StartupPreflight>;
  choosePdfBook(): Promise<OpenedPdfBook | null>;
}
