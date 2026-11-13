# 003 运行时

本文说明 M1 的运行时：守护进程如何组装、调度器如何运行循环、模型适配器和工具的边界，以及 API 与 CLI。前置阅读：[002 循环与恢复](002-loop-and-recovery.md)。

## 进程与组件

```
warren CLI ──HTTP + SSE（127.0.0.1，带 token）──▶ warrend（单进程）
                                                  ├─ API（Hono）
                                                  ├─ Scheduler ── runTask × N（进程内并发）
                                                  ├─ TaskStore（bun:sqlite，唯一写入者）
                                                  ├─ ModelResolver ── OpenAIResponsesClient
                                                  └─ Tools ──spawn──▶ 子进程（清洗过的环境变量）
```

`startDaemon`（`apps/daemon/src/daemon.ts`）是组装根，不含领域规则：加锁、读配置和密钥、打开数据库、启动服务、写 `daemon.json`、恢复任务。

- **单实例锁：** `daemon.json` 记录 pid、端口和 token（权限 0600）。启动时如果其中的 pid 还活着就拒绝启动；进程被强杀留下的旧文件会被接管。
- **正常停止**（SIGINT、SIGTERM）：中断所有循环，等它们退出，关闭服务和数据库，删除 `daemon.json`。被中断的步骤留在日志里，下次启动时按 [002](002-loop-and-recovery.md) 恢复。

## 调度器

`Scheduler`（`apps/daemon/src/runtime/scheduler.ts`）是开始工作的唯一入口：

- `wake(taskId)`：任务没在跑就启动循环，超过并发上限（默认 3）就排队。任务正在跑时，只做一个标记，循环当前这一轮结束后会再看一次日志，所以中途到达的输入不会丢。
- `interrupt(taskId)`：暂停和取消用。每个任务有自己的 AbortSignal，进行中的模型调用和 shell 命令会被立即中止。
- `resumeAll()`：启动时唤醒所有状态为 `active` 的任务，包括有执行到一半的工具调用的任务。
- 准备工作区失败时任务以 `failed` 结束。循环本身抛出的意外错误（程序 bug）会把任务暂停并写明原因，而不是让它静默消失。

## 工作区

每个任务有 `~/.warren/tasks/<id>/workspace`：

- 指定了仓库时，用 `git clone --local` 克隆，并切到 `warren/<短 id>` 分支。克隆先写到 `.partial` 目录再改名，被打断的克隆不会被当成已完成。
- 选 `clone` 而不是 `git worktree`：worktree 的提交要写源仓库的 `.git`，沙箱（M3）限制写路径之后会失败。克隆是自包含的，源仓库永远不会被改动。

## 模型

- **角色：** 配置里的 `main`、`cheap`、`hard` 各指向一个模型。任务在 `task.created` 里记录角色名，实际用的模型记录在每个 `model.responded` 里。
- **默认配置：** `main = gpt-6.1-terra`、`cheap = gpt-6-luna`、`hard = gpt-6.1-sol`。可以在 `~/.warren/config.json` 里覆盖。价格表来自第三方报道，未经官方核实。
- **OpenAI 适配器**（`packages/model`）：
  - 用 Responses API，无状态运行（`store: false`），加密推理内容随对话回传。所以任务日志本身就足以继续任务，不依赖 OpenAI 服务端保存的会话。
  - SDK 自带的重试关闭，由循环统一决定重试策略。
  - `prompt_cache_key` 用任务 id，同一任务的请求前缀可以命中缓存。
- **OpenAI 兼容适配器**（`openai-compatible`）：
  - 走 Chat Completions 协议，一个适配器覆盖 DeepSeek、Qwen、Ollama、vLLM 等。
  - 同一次响应里的文本和多个工具调用，会合并成一条助手消息发送。
  - DeepSeek 的 `reasoning_content` 会记进日志供查看，但不回传，这是这类接口在多轮对话之间的要求。
  - DeepSeek 的缓存命中字段 `prompt_cache_hit_tokens` 也会被读出。
- **错误归一：** 两个适配器共用一套规则（`packages/model/src/errors.ts`）。408、409、429、5xx 和网络错误归为 `retryable`（遵守 `retry-after`）；上下文超长归为 `context_overflow`；额度用尽和其他 4xx 归为 `fatal`。
- **密钥：** 每个模型角色可以用 `apiKeySecret` 指定读取哪个密钥，名字必须是 `WARREN_<名称>_API_KEY` 或 `WARREN_<名称>_TOKEN` 的形式。不指定时，Responses 适配器用 `WARREN_OPENAI_API_KEY`，兼容适配器不用密钥（适合本地的 Ollama）。

```json
{
  "models": {
    "cheap": {
      "provider": "openai-compatible",
      "baseUrl": "https://api.deepseek.com/v1",
      "model": "deepseek-chat",
      "apiKeySecret": "WARREN_DEEPSEEK_API_KEY"
    },
    "local": { "provider": "openai-compatible", "baseUrl": "http://localhost:11434/v1", "model": "qwen3" }
  }
}
```

## 工具

| 工具 | 副作用等级 | 说明 |
|---|---|---|
| `read_file` | read | 带行号，分页读取 |
| `list_files` | read | glob，跳过 `.git`、`node_modules` |
| `search` | read | 有 ripgrep 就用，否则用 grep |
| `edit_file` | write | 精确字符串替换，要求匹配唯一 |
| `write_file` | write | 整个文件写入 |
| `shell` | write | bash，超时默认 120 秒，输出过长时截掉中间部分 |
| `ask_user` | 由循环处理 | 写入 Attention，任务进入等待 |
| `complete_task` | 由循环处理 | 以 `completed` 结束任务 |

- 路径都会解析到工作区内，并跟随符号链接检查，越界直接拒绝。
- 子进程的环境变量走白名单，`WARREN_*` 等密钥不会传进去。
- `shell` 和 `search` 启动的进程运行在 Seatbelt 沙箱里；推送、开 PR 等对外动作由特权工具在守护进程中执行。见 [005 安全边界](005-security.md)。

## API

所有路由都需要 `Authorization: Bearer <token>`（EventSource 可以用 `?token=`）。

| 路由 | 作用 |
|---|---|
| `POST /tasks` | 创建任务（`instruction`、`repo`、`modelRole`、`budget`），并唤醒 |
| `GET /tasks`、`GET /tasks/:id` | 列表和详情；`:id` 可以是完整 id 或 8 位短 id |
| `GET /tasks/:id/events?after=` | 任务事件 |
| `GET /tasks/:id/stream?after=` | 单任务 SSE 流，支持 `Last-Event-ID` 断点续传 |
| `GET /events?after=` | 全部任务的 SSE 流，按全局顺序（给 UI 用） |
| `POST /tasks/:id/input` | 发消息给任务，唤醒空闲的任务 |
| `POST /tasks/:id/attention/:attentionId` | 回答问题 |
| `POST /tasks/:id/pause`、`resume`、`cancel` | 控制任务 |
| `GET /health` | 健康检查，以及配置中的模型需要的密钥是否已加载（只给名字和是否加载，不给值） |

违反日志不变量的请求（比如给已结束的任务发消息）返回 409。

## 已验证

M1 结束时用 `gpt-6.1-terra` 做了两次真实运行：

1. 修复一个日期校验 bug：6 次模型调用，$0.019，测试通过并提交到任务分支。
2. 一个多步任务在执行中途被 `kill -9`。重启后，中断的模型调用被重新发出，任务继续完成：共 7 次模型调用，$0.025。
