# Warren

常驻在个人电脑上的长程 Agent。它在后台接收任务，在隔离的工作区里长时间执行，只在需要你决定或者结果可以直接用的时候才打扰你。

- **本地优先**：数据在 `~/.warren/`，使用你单独配置的 API key，不碰本机其他 Agent（Claude Code、Codex）的登录态。
- **可恢复**：每个任务是一份只追加的事件日志，进程崩溃、电脑休眠或重启后从日志接着执行，外部动作不会被重复执行。
- **多模型**：内部使用与提供方无关的对话格式，通过适配器接入 OpenAI、OpenAI 兼容接口（DeepSeek、Qwen、Ollama）和 Anthropic。
- **少打扰**：只在需要回答、需要审批、结果可用时通知你。

> 状态：开发中（M0：工程底座和事件日志）。

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
| `packages/protocol` | 事件格式 v1、内部对话格式、Grant，以及事件版本升级 |
| `packages/core` | 从事件日志折叠任务状态、推出下一步；不做任何 IO |
| `apps/daemon` | 守护进程：Store（SQLite、迁移），之后是循环调度、API、接入层 |

依赖方向：`protocol` ← `core` ← 适配器 ← `apps/*`。只有 `apps/daemon` 负责组装。

## 开发

需要 [Bun](https://bun.sh) 1.4+。

```sh
bun install
bun run check     # 类型检查 + lint + 测试
bun test          # 只跑测试
bun run format    # 自动格式化
```

## 设计文档

按编号阅读，每篇只依赖前面的内容。

- [000 理念](docs/000-philosophy.md)
- [001 事件日志](docs/001-event-log.md)
- [002 循环与恢复](docs/002-loop-and-recovery.md)

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
