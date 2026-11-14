# 003 运行时

本文说明运行时：守护进程如何组装、调度器如何运行循环、工作区、模型适配器和工具的边界，以及 API。前置阅读：[002 循环与恢复](002-loop-and-recovery.md)。

## 进程与组件

```
warren CLI ─┐
Web 界面 ───┼─HTTP + SSE（127.0.0.1，带 token）──▶ warren daemon（单进程）
桌面外壳 ───┘                                      ├─ API（Hono）
                                                   ├─ Scheduler ── runTask × N（进程内并发）
                                                   ├─ AutomationRunner、GitHubRuntime（工作的来源）
                                                   ├─ TaskStore（bun:sqlite，唯一写入者）
                                                   ├─ ModelResolver ── OpenAI Responses / OpenAI 兼容 / Anthropic
                                                   └─ Tools ──spawn──▶ Seatbelt 沙箱里的子进程
```

`startDaemon`（`apps/daemon/src/daemon.ts`）是组装根，不含领域规则：加锁、读配置和密钥、打开数据库、启动服务、写 `daemon.json`、恢复任务、启动自动化和连接器。

无论任务来自 API、自动化还是 GitHub，都经过同一段代码创建（`runtime/tasks.ts` 的 `taskData`：校验文件夹、填默认值、生成 Grant），所以三条入口的规则完全一致。

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
- 选 `clone` 而不是 `git worktree`：worktree 的提交要写源仓库的 `.git`，而沙箱只允许写任务自己的目录。克隆是自包含的，源仓库永远不会被改动。
- 指定的文件夹不是 git 仓库时，把它复制进工作区（`copy`）。在 APFS 上用 `cp -c` 克隆文件，改动之前不占额外空间。复制完成后，给副本拍一份快照（每个文件的大小和修改时间），存在工作区之外的 `baseline.json`，模型改不到。之后对照这份快照，就能列出任务新增、修改和删除了哪些文件。
- 没指定文件夹时，工作区是空目录。系统提示词会告诉模型，要交给你的东西（报告、数据）都存在这里。
- 三种工作区，原文件夹都不会被改动：
  - 仓库任务的结果以分支交回（`publish_branch`）；
  - 其他任务的结果由你点"保存到…"复制出去：放进目标文件夹里一个以任务命名的新子文件夹，已存在就加序号，从不覆盖；
  - 复制文件夹的任务只保存它新增和修改的文件。
- 新建任务时可以指定 `outputDir`，记在 `task.created` 里，结束时直接提供"保存到 <它>"。每次保存记一条 `artifacts.exported`。
- 可用的文件夹有限制（`runtime/folders.ts`），作为输入和作为保存目标时一样：
  - 不能是 home 目录本身或它的上级；
  - 不能是、也不能包含 Warren 自己的目录，以及沙箱隐藏的凭证目录（`~/.ssh`、`~/Library/Keychains` 等）；
  - 复制前检查大小，超过 5 万个文件或 4 GB 就拒绝。
  这样复制进来的副本里不会带上凭证，保存出去也不会写到密钥或 Warren 自己的数据上。

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
- **Anthropic 适配器**（`anthropic`，官方 `@anthropic-ai/sdk`）：
  - 对话转换成交替的 `user` 和 `assistant` 消息；工具调用对应 `tool_use`，工具结果对应 `tool_result`，同一轮的多个工具结果放在同一条 user 消息里。
  - thinking 块连同签名原样存进日志，之后的请求原样发回（API 的要求）；其他提供方留下的推理内容会被丢弃。
  - 推理强度映射到 `output_config.effort`；用顶层 `cache_control` 自动缓存最长的稳定前缀；"prompt is too long" 归为上下文过长。
  - 配置示例：`"hard": { "provider": "anthropic", "model": "claude-opus-5-5" }`，密钥 `WARREN_ANTHROPIC_API_KEY`。
- **错误归一：** 三个适配器共用一套规则（`packages/model/src/errors.ts`）。408、409、429、5xx 和网络错误归为 `retryable`（遵守 `retry-after`）；上下文超长归为 `context_overflow`；额度用尽和其他 4xx 归为 `fatal`。
- **密钥：** 每个模型角色可以用 `apiKeySecret` 指定读取哪个密钥，名字必须是 `WARREN_<名称>_API_KEY` 或 `WARREN_<名称>_TOKEN` 的形式。不指定时，Responses 适配器用 `WARREN_OPENAI_API_KEY`，Anthropic 适配器用 `WARREN_ANTHROPIC_API_KEY`，兼容适配器不用密钥（适合本地的 Ollama）。
- **推理摘要：** Responses 适配器每次都请求推理摘要（`summary: "auto"`），界面在时间线里显示；账户没有开放摘要时只显示推理用量。

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

守护进程只监听 `127.0.0.1`，只接受本机的 Host 头（防 DNS 重绑定），所有路由都需要 `Authorization: Bearer <token>`（EventSource 可以用 `?token=`）。`:id` 可以是完整 id 或 CLI 显示的短 id。

| 路由 | 作用 |
|---|---|
| `POST /tasks` | 创建任务（`instruction`、`repo`、`outputDir`、`modelRole`、`network`、`budget`、`skills`、`mcpServers`），并唤醒 |
| `GET /tasks`、`GET /tasks/:id` | 列表和详情 |
| `DELETE /tasks/:id` | 删除任务：日志和工作区；运行中的先停止 |
| `GET /tasks/:id/events?after=` | 任务事件 |
| `GET /tasks/:id/stream?after=` | 单任务 SSE 流，支持 `Last-Event-ID` 断点续传 |
| `GET /events?after=`、`GET /events/cursor` | 全部任务的 SSE 流（按全局顺序，给界面用）和当前位置 |
| `POST /tasks/:id/input` | 发消息给任务，唤醒空闲的任务 |
| `POST /tasks/:id/attention/:attentionId` | 回答问题，或批准、拒绝 |
| `POST /tasks/:id/pause`、`resume`、`cancel` | 控制任务 |
| `GET /tasks/:id/diff` | 仓库任务的改动（在任务的沙箱里生成） |
| `GET /tasks/:id/files`、`GET /tasks/:id/files/content?path=` | 产物列表和单个文件的内容（见 [006](006-interface.md)） |
| `POST /tasks/:id/export` | 把产物保存到一个文件夹 |
| `POST /tasks/:id/reveal` | 在访达中显示工作区、某个文件或最近一次保存的位置 |
| `GET /automations`、`POST /automations` | 自动化列表和新建（见 [010](010-automations.md)） |
| `PATCH /automations/:id`、`DELETE /automations/:id`、`POST /automations/:id/run` | 修改（含启用和暂停）、删除、立即运行 |
| `GET /skills`、`POST /skills`、`DELETE /skills/:name`、`POST /skills/reveal` | 技能列表、从文件夹安装、删除、在访达中打开技能文件夹（见 [011](011-skills-and-mcp.md)） |
| `GET /mcp`、`POST /mcp/:name/test` | MCP 服务器的连接状态；重新连接并列出工具。服务器本身在设置里配置 |
| `GET /settings`、`PATCH /settings` | 读取和修改设置（含 MCP 服务器和停用的技能） |
| `PUT /secrets/:name`、`DELETE /secrets/:name` | 设置或删除密钥；只写不读 |
| `POST /pick-folder` | 用系统的文件夹选择框选一个文件夹（macOS） |
| `GET /triggers` | 连接器收到的事件和路由决定 |
| `GET /stats` | 汇总指标（见 [008](008-context-and-metrics.md)） |
| `GET /update`、`POST /update/check`、`POST /update/install` | 最近一次检查结果、立即检查、安装最新版本（见 [012](012-releases-and-updates.md)） |
| `GET /health` | 健康检查、当前版本号，以及配置中的模型需要的密钥是否已加载（只给名字和是否加载，不给值） |

- 违反日志不变量的请求（比如给已结束的任务发消息）返回 409。
- 请求格式错误、文件夹不可用、模型角色不存在返回 400，并说明原因。
