# PDFMuse 识别运行资源

Windows 安装包在此目录提供扫描页识别运行时（MinerU basic 档），运行时不联网下载资源：

- `mineru-runtime/`：固定版本 Python 3.11.9 embeddable、MinerU 4.0.2 及 ONNX Runtime 依赖，`home/models/` 内含 basic 档全部模型（版面/识别/公式/表格）。
- `mineru-worker/mineru_worker.py`：JSON-lines stdio 入口，进程内常驻 `MinerUParser`，stdout 仅输出协议响应。
- `mineru-manifest.json`：构建机生成的资源版本与 SHA-256 清单；安装包发布前必须填充真实哈希。

构建发布前必须验证版本、哈希与识别质量（公式 LaTeX、阅读顺序、块级坐标）。缺少任一资源时，PDFMuse 保持阅读可用并在预检中提示识别资源未安装。
