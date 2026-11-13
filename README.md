# Warren

常驻在个人电脑上的长程 Agent。它在后台接收任务，在隔离的工作区里长时间执行，只在需要你决定或者结果可以直接用的时候才打扰你。

- **本地优先**：数据在 `~/.warren/`，使用你单独配置的 API key，不碰本机其他 Agent（Claude Code、Codex）的登录态。
- **可恢复**：每个任务是一份只追加的事件日志，进程崩溃、电脑休眠或重启后从日志接着执行，外部动作不会被重复执行。
- **多模型**：内部使用与提供方无关的对话格式，通过适配器接入 OpenAI、OpenAI 兼容接口（DeepSeek、Qwen、Ollama）和 Anthropic。
- **少打扰**：只在需要回答、需要审批、结果可用时通知你。
- **有边界**：模型执行的命令跑在沙箱里，只能写自己的工作区，读不到凭证，网络按任务开关；对外动作由守护进程代为执行，可要求你审批。

> 状态：开发中。M3 已完成：
>
> - 任务的命令在 macOS Seatbelt 沙箱里运行；push、开 PR 等动作由守护进程代为执行，可要求审批。
> - 在 200 个任务、519 次 `kill -9` 的混沌测试中，任务全部完成，外部动作无一重复执行。

## 架构

```
apps        desktop（Web UI + 桌面壳）       cli
                │  HTTP + SSE
daemon      控制 API · 调度 · Store（SQLite） · 接入层（webhook）
core        任务状态折叠 · 循环 · 上下文策略 · 路由      （只依赖接口）
adapters    model/  tools/ + sandbox  connectors/
protocol    事件格式 · 对话格式 · API 契约               （所有包共享）
```

| 目录 | 内容 |
|---|---|
| `packages/protocol` | 事件格式 v1、内部对话格式、Grant、API 契约 |
| `packages/core` | 状态折叠、Agent 循环、各接口定义；不做任何 IO |
| `packages/model` | 模型适配器：OpenAI Responses、OpenAI 兼容（DeepSeek、Qwen、Ollama 等） |
| `packages/tools` | 内置工具、Seatbelt 沙箱、特权工具（发布分支、开 PR） |
| `apps/daemon` | 守护进程：Store、调度器、工作区、HTTP API |
| `apps/cli` | `warren` 命令 |
| `evals` | 混沌测试（反复 `kill -9` 真实守护进程） |

依赖方向：`protocol` ← `core` ← 适配器 ← `apps/*`。只有 `apps/daemon` 负责组装。

## 开发

需要 [Bun](https://bun.sh) 1.4+。

```sh
bun install
bun run check                               # 类型检查 + lint + 测试
bun test                                    # 只跑测试
WARREN_LIVE=1 bun test packages/model       # 加上真实 OpenAI API 测试（花费不到一美分）
bun run chaos 200                           # 混沌测试：反复 kill -9 守护进程，检查不变量
bun run format                              # 自动格式化
```

## 使用

```sh
bun install
cd apps/cli && bun link && cd ../..   # 安装全局命令 warren

warren daemon                         # 在一个终端里运行守护进程
warren run --repo ~/code/app "修复 xxx 测试，提交并发布分支"
warren run --network --repo . "…"     # 需要安装依赖等联网操作时
warren tasks                          # 看还在进行的任务
warren follow <id>                    # 跟随一个任务
warren answer <id> "<回答>"           # 回答任务的问题
warren approve <id>                   # 批准任务等待的动作（如开 PR）
warren deny <id> "<原因>"             # 拒绝，原因会交给任务
warren doctor                         # 检查配置
```

任务在 `~/.warren/tasks/<id>/workspace` 里的独立克隆上工作。完成后它把提交发布回你的仓库，作为 `warren/<短 id>` 分支；你的其他分支不会被改动。要让它开 PR，在 `~/.warren/credentials.env` 里配置 `WARREN_GITHUB_TOKEN`（建议使用只授权目标仓库的 fine-grained token）。

## 配置

Warren 只读取自己专用的变量名，不与其他工具共用 `OPENAI_API_KEY` 等变量。查找顺序：进程环境变量，然后是 `~/.warren/credentials.env`（权限 0600，位于任何仓库之外）。

```sh
mkdir -p ~/.warren && chmod 700 ~/.warren
echo 'WARREN_OPENAI_API_KEY=<your key>' > ~/.warren/credentials.env
chmod 600 ~/.warren/credentials.env
```

密钥不会写入事件日志、数据库或工具子进程的环境变量。

模型按角色配置，默认 `main = gpt-6.1-terra`、`cheap = gpt-6-luna`、`hard = gpt-6.1-sol`。可以在 `~/.warren/config.json` 中覆盖：

```json
{
  "models": {
    "main": { "model": "gpt-6.1-sol", "reasoningEffort": "high" },
    "cheap": {
      "provider": "openai-compatible",
      "baseUrl": "https://api.deepseek.com/v1",
      "model": "deepseek-chat",
      "apiKeySecret": "WARREN_DEEPSEEK_API_KEY"
    }
  },
  "concurrency": 3
}
```

`apiKeySecret` 指定的密钥同样写在 `~/.warren/credentials.env` 里。本地的 Ollama 不需要密钥。

## 设计文档

按编号阅读，每篇只依赖前面的内容。

- [000 理念](docs/000-philosophy.md)
- [001 事件日志](docs/001-event-log.md)
- [002 循环与恢复](docs/002-loop-and-recovery.md)
- [003 运行时](docs/003-runtime.md)
- [004 测试与验证](docs/004-testing.md)
- [005 安全边界](docs/005-security.md)

## 路线图

| 阶段 | 内容 |
|---|---|
| M0 | 工程底座、事件格式 v1、Store 与迁移、状态折叠 |
| M1 | Agent 循环、OpenAI 适配器、基础工具、守护进程 API、CLI |
| M2 | 脚本化假模型、崩溃注入测试、第二个模型适配器 |
| M3 | 克隆工作区、Seatbelt 沙箱、特权工具与审批 |
| M4 | Web UI（收件箱、任务、回放）、launchd、桌面壳 |
| M5 | GitHub 连接器：webhook、补漏、路由规则、Observe 模式 |
| M6 | 上下文压缩、Anthropic 适配器、指标整理 |
