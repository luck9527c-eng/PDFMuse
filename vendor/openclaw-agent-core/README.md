# Vendored OpenClaw Agent Core

本目录是 [OpenClaw](https://github.com/openclaw/openclaw) 在固定 commit
`a828190b2953483a4a181ff5d23c283e92713d47`（MIT 许可，见 `LICENSE`）上的选择性
vendoring。来源、补丁和升级核对信息记录在 `UPSTREAM.json`。

内容与边界：

- `packages/agent-core`：Agent Loop、Agent 状态机、工具执行、上下文压缩等非测试源码。
- `packages/normalization-core`：仅 agent-core 实际导入的 7 个模块。
- `@openclaw/ai`（其根导出包含同 commit 的 `@openclaw/llm-core`）与 `typebox`
  来自 npm（版本固定，见 `UPSTREAM.json`），不在此目录。

修改规则：

- 业务代码不得直接 import 本目录；一律通过 `src/main/agent/openclaw-core.ts`
  适配层 re-export。
- 升级上游时先更新 `UPSTREAM.json` 的 commit 与补丁记录，再从上游拉取测试文件
  运行 Core contract tests、Agent Host 集成测试和生产构建。
- 不引入 Gateway、渠道、节点、插件加载器或 SecretRef 相关代码。
