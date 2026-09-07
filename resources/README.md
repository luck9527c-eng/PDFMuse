# PDFMuse OCR 运行资源

Windows 安装包在此目录提供 OCR 运行时，运行时不联网下载资源：

- `ocr-runtime/`：固定版本 Python 3.11.9 embeddable、RapidOCR 及 ONNX Runtime wheels，并包含 PP-OCRv6-small 模型。
- `ocr-worker/rapidocr_worker.py`：JSON-lines stdio 入口，stdout 仅输出协议响应。
- `ocr-manifest.json`：构建机生成的资源版本与 SHA-256 清单；安装包发布前必须填充真实哈希。

构建发布前必须用固定语料验证版本、哈希、中文/英文阅读顺序、方向、多边形坐标和 CPU 延迟。缺少任一目录时，PDFMuse 保持阅读可用并在预检中提示 OCR 资源未安装。
