# PDFMuse

个人 PDF 深度阅读助手——在阅读流程内理解知识型 PDF 书籍：划选原文提问、获得扎根本书且页码可点击验证的 AI 回答，扫描页自动 OCR 变为可选中文字，阅读进度跨会话恢复。

基于 Electron + React + TypeScript 构建，AI 编排复用 OpenClaw Agent Core，OCR 运行在独立 Python Worker。所有产品数据自包含在程序所在目录的 `data/` 文件夹，**PDF 原文件始终留在原地、永不修改**。

## 核心特性

- **书库**：按内容指纹（SHA-256）识别书籍——同一本书移动、改名后自动重新关联；文件缺失只保留记录，同内容重新定位即恢复全部数据
- **AI 对话**：连接任意 OpenAI 兼容模型服务（API Key 仅存本地）。回答优先依据当前书原文，每条回答附可点击的「参考：第 N 页」；支持最多四张截图提问、导出会话为 Markdown
- **混合检索**：FTS 关键词 + 语义向量双路混合，按阅读位置加权；未配置 Embedding 服务时自动降级为全文检索
- **扫描页 OCR**：内置 RapidOCR + ONNX Runtime（独立 Python Worker），识别结果可直接选中、进入查找/提问/索引；当前页静默识别 + 邻页预取
- **智能目录**：内嵌书签优先；缺失时 AI 视觉提取印刷目录，锚点投票对齐印刷页码与 PDF 页码
- **阅读现场**：页码、滚动位置、缩放、侧栏开合全部持久化，重开书籍精确恢复
- **数据自包含**：配置、会话、索引、OCR 结果全部在 `data/` 目录；删除书籍数据时各模块事务性清理，不碰 PDF 原文件

## 环境要求

- Windows 10/11（当前发布目标平台）
- Node.js ≥ 20.19（推荐 22 LTS 或 24）
- 首次构建需联网（npm 依赖 + 可选的 OCR 运行时资源约 273 MB）

## 源码运行

```bash
# 1. 安装依赖（国内网络 electron 下载失败时先配镜像，见「常见问题」）
npm install

# 2. 首次必须：编译主进程。dev 脚本只启动 vite 和 electron，不编译主进程代码
npm run build

# 3. 可选：构建 OCR 运行时（不构建则扫描页识别降级为提示，其余功能不受影响）
npm run prepare:ocr

# 4. 启动开发模式
npm run dev
```

首次启动后在「设置」中保存并测试模型连接（OpenAI 兼容 baseUrl + API Key + 模型名）；可选配置 Embedding 连接以启用语义检索。不需要在系统里安装 Python——OCR 使用项目内自带的嵌入式 Python 运行时。

## 常用脚本

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 开发模式（vite + electron，需先跑过一次 `build`） |
| `npm test` | 全量自动化测试（256 项，无需拉起 Electron） |
| `npm run typecheck` | 双 tsconfig 类型检查 |
| `npm run build` | 生产构建（clean + typecheck + vite + 主进程 tsc） |
| `npm run smoke:electron` | Electron 端到端冒烟测试 |
| `npm run package:installer` | 打包 NSIS 安装包（正式发布形态） |
| `npm run prepare:ocr` | 构建/校验 OCR 运行时资源 |
| `npm run benchmark:ocr` | OCR 固定语料性能基准 |

## 目录结构

```
src/
  main/          Electron 主进程（书库、SQLite、检索、后台任务、OCR 调度、Agent Host）
  main/agent/    AI 编排（Agent Host、工具注册表、上下文组装、语义切片、会话存储）
  preload/       类型化 IPC 桥
  renderer/      React 界面（阅读工作区、PDF 查看器、AI 面板、目录、设置）
  shared/        主进程/渲染进程共享契约与 OCR 配置
vendor/          最小范围复用的 OpenClaw Agent Core 源码
resources/       OCR 运行时与模型（本地构建产物，不入库）
scripts/         构建、打包、冒烟、基准脚本
```

## 常见问题

| 现象 | 原因与解决 |
| --- | --- |
| `cannot find module .../dist-electron/.../main.js` | `dist-electron` 是构建产物不入库；新环境先跑一次 `npm run build` |
| `Electron failed to install correctly` | electron 二进制下载失败；`npm config set electron_mirror https://npmmirror.com/mirrors/electron/` 后重装 |
| vite 启动报错或语法错误 | Node 版本过低，升级到 ≥ 20.19 |
| 应用能启动，扫描页提示「资源未安装」 | 缺 OCR 运行时，跑 `npm run prepare:ocr`（需联网）；不影响其他功能 |
| 仓库里没有 docs/、PRD.md 等 | 本地开发文档不入库，属正常现象 |

## 隐私与数据

- PDF 原文件保持原位且只读，任何操作（包括删除书籍数据）都不会修改或删除原文件
- API Key、PDF 密码等只存储在本地 `data/` 目录，仅用于访问你自己配置的模型服务
- 应用运行时不联网下载任何模型；网络请求仅发生在你主动使用 AI 对话/检索/网络搜索功能时
