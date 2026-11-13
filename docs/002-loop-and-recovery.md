# 002 循环与恢复

本文说明 Agent 循环如何从事件日志推出每一步，以及进程中断后如何恢复。前置阅读：[001 事件日志](001-event-log.md)。

> 状态：`nextStep` 已实现（`packages/core/src/task-state.ts`）。循环本身在 M1 实现，本文是它的设计。

## 下一步由状态决定

循环不保存自己的状态。每一轮都调用 `nextStep(state)`，按以下顺序取第一个成立的：

| 下一步 | 条件 | 循环的动作 |
|---|---|---|
| `ended` | 有 `task.ended` | 退出 |
| `paused` | 已暂停 | 退出，等恢复 |
| `recover_tools` | 有 `tool.started` 但没有 `tool.finished` | 按副作用等级恢复，见下文 |
| `wait_for_person` | 有未处理的 Attention | 退出，等人答复 |
| `run_tool` | 有待执行的工具调用 | 写 `tool.started`，执行，写 `tool.finished` |
| `call_model` | 历史最后一条是用户消息或工具结果 | 调用模型，写 `model.responded` 或 `model.failed` |
| `idle` | 模型结束了这一轮 | 退出，等新输入 |

任务状态（`active`、`waiting`、`idle`、`paused`、`ended`）也由同一个函数推出，所以列表里看到的状态和循环的判断永远一致。

## 循环的结构

```
loop(taskId):
  while true:
    state = store.get(taskId)
    step  = nextStep(state)
    if step 是 ended / paused / wait_for_person / idle: return
    检查预算（模型调用次数、费用）；超出则写 attention 或 task.ended
    执行 step，把结果作为事件追加
```

- 每一步都是"先读状态，再执行，再追加事件"。追加时 Store 会重新检查不变量。
- 等待期间（模型调用、工具执行）到达的新输入不会打断当前一步；它们被写进日志，下一轮自然会看到。
- 预算是循环的检查，不是日志的不变量：超出预算要先停下来问你，而不是让写入失败。

## 崩溃恢复

进程可能在任意两条事件之间消失。重启后，守护进程对每个未结束、未暂停的任务重新启动循环，大多数情况不需要特殊处理：

- 模型调用中途崩溃：日志里没有 `model.responded`，下一轮会重新调用。代价只是一次模型调用的费用。
- 工具执行完但没写 `tool.finished`：日志显示调用还在执行，进入 `recover_tools`。

`recover_tools` 按 `tool.started` 里记录的副作用等级处理：

| 等级 | 例子 | 恢复方式 |
|---|---|---|
| `read` | 读文件、搜索 | 重新执行 |
| `write` | 编辑工作区文件、跑测试 | 重新执行；工作区当前的文件就是事实 |
| `external` | push、开 PR、发消息 | **不重新执行**。写入 `outcome: "interrupted"` 的结果，告诉模型"结果未知，请先核对再决定是否重试"，例如先查这个分支的 PR 是否已经存在 |

这样不需要额外的发件箱或幂等键机制，外部动作也不会被盲目执行两次。要满足这一点，`tool.started` 必须在执行之前持久化落盘，见 [001](001-event-log.md) 的存储一节。

## 休眠与唤醒

- 休眠时进行中的 HTTP 请求会断开，当作 `retryable` 失败处理，按退避重试。
- 定时触发在休眠期间错过的，唤醒后只补跑一次。
- 连接器在唤醒后用游标补拉错过的事件，靠去重键避免重复（M5）。

## 测试方式

循环依赖的模型、工具、时钟都通过接口注入。测试用脚本化的假模型按预设顺序返回响应，在每两条事件之间注入"崩溃"（丢弃内存状态，从日志重建），检查两条不变量：

1. 外部动作不会被执行两次。
2. 每个任务最终都停在 `ended`、`idle` 或 `waiting`。
