# 006 界面与常驻

本文说明人如何使用 Warren：Web 界面、系统通知、开机常驻和单文件发布。前置阅读：[003 运行时](003-runtime.md)、[005 安全边界](005-security.md)。

## 设计原则

界面遵循 [000](000-philosophy.md) 的"少占注意力"：

- **收件箱只按"需不需要你"排序：** 需要你处理 → 进行中 → 等待回复 → 已暂停 → 已结束。需要你处理的任务直接在列表里显示问题或待批准的动作。
- **系统通知只在两种时刻出现：** 任务需要你（提问或审批），以及任务完成或失败。进度不发通知。
- **界面上能做的事和 CLI 一样：** 新建任务、回答、批准或拒绝、发消息、暂停、继续、取消。界面和 CLI 都只是守护进程 API 的客户端。

## Web 界面

`apps/web`，React + TanStack Query。

- **打包：** 由 Bun 的 HTML import 直接打包（`import ui from "@warren/web/index.html"`），守护进程在 `/` 提供页面，不需要 Vite 等额外的构建工具。编译成单文件时界面也一并打包进去。
- **实时更新：** 页面订阅 `GET /events` 的 SSE 流，新事件直接追加到对应任务的时间线，列表和详情去抖后刷新。断线后由 EventSource 带上 `Last-Event-ID` 自动续传。
- **时间线即回放：** 时间线是事件日志的投影（`model.ts` 的 `timeline()`，纯函数，有测试）。回放滑块拖到第 N 步时，页面用 `@warren/core` 的 `foldEvents` 在浏览器里把日志折叠到那一步。看到的状态和守护进程重启时重建出的完全一致，因为用的是同一个函数。
- **中英双语，默认中文：** 界面文字都在 `i18n.ts` 的两份字典里，TypeScript 保证两份的键一一对应。语言选择记在浏览器的 localStorage 里。时间线的提示由逻辑层输出为结构化数据（`Notice`），由界面按当前语言渲染。任务标题、模型回复、提问内容等用户数据保持原文。

## 登录与本机安全

- **token：** API 的 token 保存在 `~/.warren/token`（0600），守护进程重启后不变；删除该文件即可轮换。`warren open` 用 `/#token=…` 打开页面，`#` 后面的片段浏览器不会发给服务器。页面读到 token 后存进本源的 localStorage，并清掉地址栏里的片段。
- **页面与 API 的权限：** 页面本身（HTML、JS、CSS）不含任何秘密，不需要 token；所有 API 都需要。
- **防 DNS 重绑定：** 守护进程只接受 Host 为 `127.0.0.1`、`localhost`、`[::1]` 的请求。恶意网页即使通过 DNS 重绑定把自己的域名解析到本机，请求带的也是它自己的域名，会被拒绝。

## 系统通知

`runtime/notifications.ts`：守护进程在提交事件后检查，遇到 `attention.requested` 或 `task.ended`（取消除外）时，通过 macOS 通知中心提醒你。

- 通知内容可能来自模型（比如它提的问题），所以文字作为 `osascript` 的参数传入，不拼进脚本文本，避免模型在可信进程里注入 AppleScript。
- 可以在配置中关闭：`"notifications": false`。

## 开机常驻

`warren service install` 会在 `~/Library/LaunchAgents/` 写入 launchd 用户代理（`dev.warren.daemon`），并立即加载：

- 登录时启动；退出后自动重启（`KeepAlive`，重启间隔 10 秒）。
- 运行的是和终端里一样的 `warren daemon`：有编译好的单文件程序时用它，否则用 bun 加源码。
- launchd 启动时几乎没有 `PATH`，所以 plist 里写入了 bun、Homebrew 和系统目录，任务才能找到 git 和 bun。
- 日志写到 `~/.warren/logs/daemon.log`。
- `warren service status` 查看状态，`warren service uninstall` 卸载。`WARREN_SERVICE_LABEL` 可以让开发实例和正式实例并存。

已在本机验证：安装后服务被拉起；用 `kill -9` 杀掉后，launchd 自动重启；卸载后没有残留。

## 单文件发布

`bun run build` 输出 `dist/warren`。它是一个自带 Bun 运行时的可执行文件，包含 CLI、守护进程和打包好的界面，可以直接复制到 `PATH` 里使用。

## 桌面外壳（未做）

计划用 Tauri v2 包一层原生窗口和菜单栏图标，窗口加载守护进程提供的同一个页面。它需要 Rust 工具链，本机目前没有，所以还没实现。界面本身与外壳无关，加外壳不需要改动任何页面代码。
