# PDFMuse OCR 运行资源（延期）

第一版不携带或使用以下 OCR 资源。恢复扫描型 PDF 支持时，再按 T18 研究结论准备离线资源：

- `ocr-runtime/`：固定版本 Python 3.11 embeddable 及已 vendoring 的 PaddleOCR/PaddlePaddle wheels。
- `ocr-worker/paddleocr_worker.py`：JSON-lines stdio 入口，stdout 仅输出协议响应。
- `ocr-models/`：固定哈希的 PP-OCRv5 det/rec 模型。
- `ocr-manifest.json`：构建机生成的资源版本与 SHA-256 清单；安装包发布前必须填充真实哈希。

恢复 OCR 发布前必须用固定语料验证版本、哈希、中文/英文阅读顺序、方向、多边形坐标和 CPU 延迟。当前缺少这些目录不会影响原生文本 PDF 阅读，也不会产生启动警告。
