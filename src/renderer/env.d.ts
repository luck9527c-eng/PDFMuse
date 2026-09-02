/// <reference types="vite/client" />

import type { PDFMuseApi } from "../shared/contracts";

declare global {
  interface Window {
    pdfMuse?: PDFMuseApi;
  }
}

declare module "*.mjs?url" {
  const url: string;
  export default url;
}

export {};
