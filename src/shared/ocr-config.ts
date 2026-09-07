export const OCR_ENGINE = "RapidOCR";
export const OCR_ENGINE_VERSION = "3.9.2-onnxruntime1.29.0-r1";
export const OCR_MODEL = "PP-OCRv6-small";
export const OCR_RENDER_SCALE = 1;
export const OCR_INPUT_VERSION = `${OCR_ENGINE}:${OCR_MODEL}:${OCR_ENGINE_VERSION}:render-${OCR_RENDER_SCALE}`;

export const OCR_REQUIRED_RESOURCE_PATHS = [
  "ocr-runtime",
  "ocr-worker/rapidocr_worker.py",
] as const;
