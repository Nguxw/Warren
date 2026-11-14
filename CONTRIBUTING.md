# 参与贡献

感谢你愿意改进 Warren。本文说明如何搭建开发环境、提交前要检查什么，以及几条改动代价很高、必须遵守的规则。

## 开发环境

- macOS 13 或更高（沙箱相关的测试需要 Seatbelt；其他测试在 Linux 上也能跑）
- [Bun](https://bun.sh) 1.4+、git
- 可选：Rust 工具链（构建桌面应用）、Docker（运行 SWE-bench 评测）

```sh
bun install
bun run check        # 类型检查（tsc）+ Biome lint + 全部测试；提交前必须通过，CI 运行同一条命令
bun run format       # 按 Biome 规则格式化
```

从源码运行一个和日常使用互不干扰的实例：

```sh
mkdir -p /tmp/warren-dev && echo '{"server":{"port":7450}}' > /tmp/warren-dev/config.json
WARREN_HOME=/tmp/warren-dev bun apps/cli/src/main.ts daemon
WARREN_HOME=/tmp/warren-dev bun apps/cli/src/main.ts open
```

## 代码组织

依赖方向是单一的：`protocol` ← `core` ← 适配器（`model`、`tools`、`connectors`）← `apps/*`。

- `packages/protocol`：事件格式、对话格式、Grant、API 契约（zod），不依赖任何内部包。
- `packages/core`：纯逻辑，只依赖 `protocol` 和 zod；不做 IO，不用 Bun API。
- `apps/daemon` 是组装根，也是唯一写数据库的进程；CLI 和界面都通过 HTTP 访问它。
- 界面的视图逻辑放在纯函数里（`apps/web/src/model.ts`、`i18n.ts`）并配测试。所有界面文字都经过 `i18n.ts`（中文默认，另有英文），不要在组件里写死文字。

## 必须遵守的规则

这些规则一旦违反，代价是已有用户的数据或安全：

- **存储的事件永不修改。** 要改某个事件类型的 `data`，把它在 `EVENT_VERSIONS` 里的版本加一，并在 `protocol/src/upcast.ts` 里加一个升级函数。新增事件类型、新增可选字段不需要升版本。
- **日志只存 Warren 自己的对话条目，** 从不存提供方的原始请求或响应。
- **`tool.started` 必须在工具执行前提交；** `external` 类工具在恢复时从不重跑。
- **可信代码从不在工作区里运行 git：** 工作区的钩子和配置是模型可写的。需要时从源仓库一侧 fetch，并关闭钩子、fsmonitor 和凭证助手（见 `packages/tools/src/privileged.ts`）。
- **路径只以 `-D` 参数传给 Seatbelt，** 从不拼进策略文本。
- **数据库迁移只往前加，** 已发布的迁移从不修改。
- **Warren 只用自己的凭证和 `~/.warren`（`WARREN_HOME`），** 从不读写 `~/.codex`、`~/.claude` 或 `gh` 的配置。

## 约定

- 代码、注释、标识符用英文；文档（`docs/`）用中文。
- 用包名导入工作区里的包（`@warren/core`），本地文件带 `.ts` 扩展名。
- 测试放在各包的 `tests/` 里，用 `bun:test`；涉及时间的逻辑用假时钟，不用真实时间。
- 改动了行为，就同时更新对应的设计文档（`docs/000`–`010`），让文档描述的始终是系统现在的样子。

## 提交与 PR

- 一个 PR 做一件事；提交信息说明"为什么"，不只是"改了什么"。
- 涉及模型适配器的改动，请在共享的契约测试（`packages/model/tests/contract.test.ts`）里覆盖。
- 涉及恢复语义的改动，请运行 `bun run chaos` 确认不变量仍然成立。
- 安全问题请不要开公开 issue，按 [SECURITY.md](SECURITY.md) 报告。
