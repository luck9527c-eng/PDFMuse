# PDFMuse OCR 运行资源

Windows 安装包在此目录提供 OCR 运行时，运行时不联网下载资源：

- `ocr-runtime/`：固定版本 Python 3.11 embeddable 及已 vendoring 的 PaddleOCR/PaddlePaddle wheels。
- `ocr-worker/paddleocr_worker.py`：JSON-lines stdio 入口，stdout 仅输出协议响应。
- `ocr-models/`：固定哈希的 PP-OCRv5 det/rec 模型。

构建发布前必须用固定语料验证版本、哈希、中文/英文阅读顺序、方向、多边形坐标和 CPU 延迟。缺少任一目录时，PDFMuse 保持阅读可用并在预检中提示 OCR 资源未安装。
