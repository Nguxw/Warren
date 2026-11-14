# 001 事件日志

本文定义任务事件日志的格式 v1。它是 Warren 里最难修改的部分，所以先于其他代码设计。实现见 `packages/protocol` 和 `packages/core/src/task-state.ts`。前置阅读：[000 理念](000-philosophy.md)。

## 信封

每个事件都有相同的信封：

| 字段 | 含义 |
|---|---|
| `type` | 事件类型，如 `tool.started` |
| `v` | 该事件类型的版本。每种类型独立升级，改一种不影响其他 |
| `taskId` | 所属任务 |
| `seq` | 在任务日志中的位置，从 0（`task.created`）开始，连续无空洞 |
| `at` | 守护进程时钟的 Unix 毫秒时间 |
| `data` | 该类型的内容 |

## 事件类型

| 类型 | 含义 |
|---|---|
| `task.created` | 标题、指令、Grant、来源。一定是 `seq = 0` |
| `input.received` | 来自人或连接器的一条消息，会唤醒空闲的任务 |
| `model.responded` | 一次模型响应：输出条目、停止原因、用量、耗时、所用模型 |
| `model.failed` | 一次模型调用失败，已归一为 `retryable`、`fatal`、`context_overflow` |
| `tool.started` | 工具即将执行，记录它的副作用等级。**先写这条，再执行工具** |
| `tool.finished` | 工具结果：`ok`、`error`、`interrupted`、`denied` |
| `attention.requested` / `attention.resolved` | 需要人回答的问题或审批，及其答复 |
| `task.paused` / `task.resumed` | 暂停与恢复 |
| `task.ended` | 结束：`completed`、`failed`、`cancelled`。之后只能追加 `artifacts.exported` |
| `artifacts.exported` | 你把任务的文件保存到了自己的文件夹：保存到哪里、几个文件。这是你对已完成结果的操作，所以可以在结束之后追加，也不会让任务重新开始 |

## 内部对话格式

日志里只存 Warren 自己的对话条目，从不存某个提供方的原始请求或响应。这样任务可以中途换模型，SDK 升级也不会让旧日志读不懂。

| 条目 | 说明 |
|---|---|
| `message` | `user` 或 `assistant` 的消息，内容是 `ContentPart` 数组（目前只有文本，图片等以后作为新成员加入） |
| `reasoning` | 提供方私有的推理状态（如 OpenAI 加密推理、Anthropic thinking 签名）。只有 `provider` 字段指明的适配器能解释 `data`，换模型时其他适配器会丢掉它 |
| `tool_call` | 工具调用；`arguments` 保存模型产出的原始 JSON 文本，可能不合法，执行时再校验 |
| `tool_result` | 工具结果，由 `tool.finished` 生成 |

## 状态折叠和不变量

`foldEvents` 把日志折叠成 `TaskState`。`applyEvent` 同时也是日志的守卫：不能接在当前状态之后的事件会抛出 `LogInvariantError`，Store 拒绝提交整批事件。主要不变量：

- 日志以 `task.created` 开始，`seq` 连续，事件属于同一任务，结束后不能再追加。
- 有待执行的工具调用时，不能再有模型响应。
- `tool.started` 和 `tool.finished` 必须对应一个待执行的调用；同一响应中 `callId` 不能重复。
- 工具调用还没全部出结果时到达的输入先排队，等最后一个结果写入后再进入历史。因为各家 API 都要求工具结果紧跟在调用后面，这样 `history` 任何时候都可以原样发给模型。

## 版本和演进

- **事件写入后永不修改。** 某个类型的 `data` 需要变化时，把它的版本加一，并在 `upcast.ts` 中加一个把 n 升到 n+1 的函数。读取时依次升级，调用方只会看到当前格式。
- **新增事件类型不需要升版本。** 旧版本程序读到不认识的类型会报错，而不是静默忽略。
- 读到比当前程序更新的版本时拒绝读取。

## 存储

事件存在 SQLite（`bun:sqlite`）中，守护进程是唯一写入者。

- `events` 表：`(task_id, seq)` 唯一，是任务内顺序；自增 `id` 是跨任务的全局顺序，客户端可以按它订阅所有任务的事件并断点续传。
- `tasks` 表：任务摘要（标题、状态、更新时间），是日志的投影，和事件在同一事务中更新，只用于列表查询。
- 写入时先用 zod 校验事件，再折叠到当前状态检查不变量，全部通过才提交。
- `synchronous = FULL`：`tool.started` 必须在外部动作执行之前落盘，否则断电可能抹掉这条记录，导致动作被执行两次。Warren 每秒最多几次提交，fsync 的代价可以忽略。
- 表结构只向前迁移，版本记录在 `PRAGMA user_version`；已发布的迁移不修改。
