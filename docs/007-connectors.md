# 007 连接器：GitHub

本文说明 Warren 如何从外部接收工作：事件怎么进来、怎么决定要不要做、结果怎么回到原处。前置阅读：[005 安全边界](005-security.md)、[006 界面与常驻](006-interface.md)。

## 两条进入路径，一个去重键

| 路径 | 作用 | 弱点 |
|---|---|---|
| Webhook（推送） | 实时 | 电脑休眠或隧道断开时，期间的投递会丢失 |
| 补漏轮询（拉取） | 完整：从游标开始拉取之后发生的事 | 有延迟（默认 2 分钟） |

两条路径并存，并且在同一个去重键上汇合：每个事件的 `externalId` 只取决于"发生了什么"，与"怎么到达"无关。例如评论是 `comment:<id>`，标签是 `labeled:<repo>#<n>:<label>`，CI 失败是 `run:<id>`。`trigger_events` 表的 `(source, external_id)` 唯一约束让重复到达的同一事件只处理一次。

- **Webhook：** 监听在单独的本地端口（`github.webhookPort`），与控制 API 分开。这样隧道只暴露这一个端口，而它只接受签名正确的投递（`X-Hub-Signature-256`，密钥是 `WARREN_GITHUB_WEBHOOK_SECRET`）。
- **轮询：** 按 `pollSeconds` 定时执行，并且检测到长时间的间隔（通常是休眠后唤醒）时立刻补一次。游标向前重叠一分钟，以防漏掉 GitHub 延迟才能查到的条目；重叠带来的重复由去重键吸收。
- **第一次轮询从"现在"开始：** Warren 只接新请求，不回头处理仓库里的历史。

## 处理一个事件：一个事务

`Intake.ingest` 在一个 SQLite 事务里完成去重检查、路由、创建任务（或追加输入、回答问题）以及记录决定。所以：

- 崩溃不会丢事件，也不会把同一个事件做成两个任务；
- webhook 和轮询同时送来同一事件，结果也只有一条记录。

## 路由规则

路由是纯函数（`packages/core/src/routing.ts`）。和 DeepSeek Super-Agent 一样，分两类来源：

| 规则 | 触发 | 类型 | 默认模式 |
|---|---|---|---|
| `mention` | 允许名单中的人在 issue 或评论中提到 `@warren` | 明确请求 | `auto` |
| `label` | 允许名单中的人给 issue 打上 `warren` 标签 | 明确请求 | `auto` |
| `ciFailure` | 默认分支上的 CI 失败 | 推断（Warren 自己发现） | `observe` |

- **三种模式：** `off` 忽略；`observe` 只记录"本会开始的工作"，不创建任务；`auto` 直接开始。推断类规则默认是 `observe`：先在"事件"页面（或 `warren triggers`）里看它的判断准不准，确认可靠后再改成 `auto`。
- **对话归属：** 已经有任务在跟随的对话里，允许名单中的人新发的评论会交给那个任务。如果任务正在等回答，这条评论就是答案。
- **不理会的情况：** 不在允许名单的人；Warren 自己的账号（`botLogin`，默认从 token 查出）；带有隐藏标记 `<!-- warren -->` 的评论。后两条是双重保险，防止 Warren 把自己的回复当成新请求，陷入循环。

## 结果回到原处

由 GitHub 发起的任务会跟随它所在的对话（`follows`，例如 `github:owner/repo#12`）：

- 任务提问时，问题会以评论形式发到该 issue；人在 issue 里回复，就等于回答。
- 任务结束时，结论会发到该 issue。

回复失败会重试 3 次，失败只记录日志。这些评论只是通知，任务本身的结果（分支、PR）由特权工具交付，不依赖这条评论。

## 配置

`~/.warren/config.json`：

```json
{
  "github": {
    "allowedActors": ["your-github-login"],
    "webhookPort": 7350,
    "repos": {
      "owner/app": {
        "path": "/Users/you/code/app",
        "rules": { "mention": "auto", "label": "auto", "ciFailure": "observe" }
      }
    }
  }
}
```

`~/.warren/credentials.env`：

```sh
WARREN_GITHUB_TOKEN=github_pat_…          # 读 issue 和评论、发评论、推送分支、开 PR
WARREN_GITHUB_WEBHOOK_SECRET=…            # 只在使用 webhook 时需要
```

- **token：** 建议给 Warren 一个单独的账号（`botLogin` 会被忽略），使用只授权目标仓库的 fine-grained token。
- **只用轮询：** 不填 `webhookPort` 即可。
- **使用 webhook：** 用 Cloudflare Tunnel、Tailscale Funnel 或 smee.io 把公网地址转发到 `http://127.0.0.1:7350/github`，并在仓库设置里订阅 Issues、Issue comments、Pull request review comments 和 Workflow runs。

## 验证

- **路由：** 纯函数测试，覆盖明确请求、允许名单、忽略自身、对话归属、回答问题、标签、CI 只观察和规则关闭。
- **连接器：** 签名校验；webhook 归一化；轮询与 webhook 对同一评论得到同一去重键。
- **端到端（`apps/daemon/tests/github.test.ts`）：** 用本地假 GitHub API 和真实签名的 webhook，走完整个流程：
  - 有人提到 `@warren`，Warren 创建任务；
  - 任务提问，问题以评论形式发回 issue；
  - 有人在 issue 里回复，回复作为答案交给任务；
  - 任务完成，结论发回 issue。

  同时验证：去重；陌生人和 Warren 自己的评论被忽略；签名错误被拒绝；CI 失败只被观察。
