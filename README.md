# Warren

常驻在个人电脑上的长程 Agent。它在后台接收任务，在隔离的工作区里长时间执行，只在需要你决定或者结果可以直接用的时候才打扰你。

- **本地优先**：数据在 `~/.warren/`，使用你单独配置的 API key，不碰本机其他 Agent（Claude Code、Codex）的登录态。
- **可恢复**：每个任务是一份只追加的事件日志，进程崩溃、电脑休眠或重启后从日志接着执行，外部动作不会被重复执行。
- **多模型**：内部使用与提供方无关的对话格式，通过适配器接入 OpenAI、OpenAI 兼容接口（DeepSeek、Qwen、Ollama）和 Anthropic。
- **少打扰**：只在需要回答、需要审批、结果可用时通知你。

> 状态：开发中。M1 已完成：可以通过 CLI 让 Warren 在仓库的克隆里完成任务，进程崩溃后能接着执行。

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
| `packages/model` | 模型适配器：OpenAI Responses |
| `packages/tools` | 内置工具：读写编辑文件、搜索、shell |
| `apps/daemon` | 守护进程：Store、调度器、工作区、HTTP API |
| `apps/cli` | `warren` 命令 |

依赖方向：`protocol` ← `core` ← 适配器 ← `apps/*`。只有 `apps/daemon` 负责组装。

## 开发

需要 [Bun](https://bun.sh) 1.4+。

```sh
bun install
bun run check                               # 类型检查 + lint + 测试
bun test                                    # 只跑测试
WARREN_LIVE=1 bun test packages/model       # 加上真实 OpenAI API 测试（花费不到一美分）
bun run format                              # 自动格式化
```

## 使用

```sh
bun install
cd apps/cli && bun link && cd ../..   # 安装全局命令 warren

warren daemon                         # 在一个终端里运行守护进程
warren run --repo ~/code/app "修复 xxx 测试，然后提交"
warren tasks                          # 看还在进行的任务
warren follow <id>                    # 跟随一个任务
warren answer <id> "<回答>"           # 回答任务的问题
warren doctor                         # 检查配置
```

任务在 `~/.warren/tasks/<id>/workspace` 里的独立克隆上工作，提交在 `warren/<短 id>` 分支上，你的仓库不会被改动。

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
  "models": { "main": { "model": "gpt-6.1-sol", "reasoningEffort": "high" } },
  "concurrency": 3
}
```

## 设计文档

按编号阅读，每篇只依赖前面的内容。

- [000 理念](docs/000-philosophy.md)
- [001 事件日志](docs/001-event-log.md)
- [002 循环与恢复](docs/002-loop-and-recovery.md)
- [003 运行时](docs/003-runtime.md)

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
