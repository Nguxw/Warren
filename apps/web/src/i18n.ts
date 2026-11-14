import type { TaskStatus } from "@warren/protocol";
import { durationParts, type StepCategory, type ToolStatus } from "./model.ts";

/**
 * Interface languages. Chinese is the default; the choice is remembered per browser.
 * Only Warren's own words are translated: task titles, prompts and model output stay as written.
 */

export type Lang = "zh" | "en";

const zh = {
  "app.newTask": "新建任务",
  "app.search": "搜索任务",
  "app.loading": "加载中…",
  "app.unreachable": "无法连接守护进程",
  "app.sandbox": "沙箱已启用",
  "app.noSandbox": "未启用沙箱",

  "triggers.open": "事件",
  "triggers.title": "GitHub 事件",
  "triggers.intro":
    "Warren 从 GitHub 收到的事件，以及它的决定。处于“观察”模式的规则只记录它本会开始的工作；确认判断可靠后，再在配置中改为 auto。",
  "triggers.none":
    "还没有事件。在 ~/.warren/config.json 中配置 github 后，这里会出现提及、标签和 CI 失败。",
  "decision.create": "已创建",
  "decision.observe": "观察",
  "decision.append": "已追加",
  "decision.answer": "已回答",
  "decision.ignore": "忽略",
  "kind.comment": "评论",
  "kind.issue_opened": "新 issue",
  "kind.issue_labeled": "标签",
  "kind.ci_failed": "CI 失败",
  "signin.title": "需要登录",
  "signin.body": "此页面需要守护进程的令牌。请在终端中打开：",

  "group.needsYou": "需要你",
  "group.working": "进行中",
  "group.idle": "等待回复",
  "group.paused": "已暂停",
  "group.ended": "已结束",
  "row.approve": "待批准",
  "row.asks": "待回答",
  "search.none": "没有匹配的任务",

  "status.active": "进行中",
  "status.waiting": "需要你",
  "status.idle": "等待回复",
  "status.paused": "已暂停",
  "status.ended": "已结束",
  "outcome.completed": "已完成",
  "outcome.failed": "失败",
  "outcome.cancelled": "已取消",

  "home.title": "今天要 Warren 做什么？",
  "home.body": "说清楚要完成的事，回车就开始。它在后台的独立工作区里完成，只在需要你的时候打扰你。",
  "home.placeholder": "描述要完成的事…",
  "home.shortcuts": "↩ 发送 · ⇧↩ 换行 · ⌘N 回到这里 · ⌘K 搜索任务",
  "home.example.research": "调研今天 GitHub 热榜上值得关注的项目，写成一份报告",
  "home.example.fix": "运行仓库的测试，修复失败的用例并提交",
  "home.example.notes": "把文件夹里的笔记整理成一份摘要",
  "home.networkOn": "可联网",
  "home.networkOff": "不联网",
  "home.pickFolder": "选择文件夹…",
  "home.typePath": "输入路径…",
  "home.clear": "清除",
  "new.repo": "工作文件夹",
  "new.repoPlaceholder": "本地文件夹路径",
  "new.model.main": "标准",
  "new.model.hard": "深度",
  "new.model.cheap": "快速",
  "new.networkHint": "安装依赖、下载文件时需要",
  "new.repoHint":
    "git 仓库会克隆一份，结果以分支交回；其他文件夹会复制一份。原文件夹都不会被改动。",
  "new.choosePrompt": "选择任务要处理的文件夹",
  "new.output": "保存产物到",
  "new.outputPlaceholder": "保存产物的文件夹",
  "new.outputHint": "完成后一键保存到这里，放进以任务命名的新文件夹。",
  "new.outputPrompt": "选择保存产物的文件夹",
  "card.save": "保存到 {dir}",
  "card.saveChoose": "保存到…",
  "card.saved": "已保存到 {dir}",
  "notice.exported": "已保存 {n} 个文件到 {destination}",
  "files.added": "新增",
  "files.modified": "修改",
  "files.copySummary": "复制自 {source}，{unchanged} 个文件没有改动",
  "files.deleted": "删除了 {n} 个文件：{files}",
  "files.noChanges": "还没有改动文件夹里的文件。",

  "step.inspect": "查看代码",
  "step.edit": "修改文件",
  "step.run": "执行命令",
  "step.publish": "发布结果",
  "step.other": "处理中",
  "card.thinking": "正在思考下一步…",
  "card.elapsed": "已运行 {duration}",
  "card.question": "Warren 需要你的回答",
  "card.approval": "需要你批准",
  "card.idle": "等待你的回复",
  "card.idleHint": "在下方输入消息，任务会继续进行。",
  "card.paused": "已暂停",
  "card.completed": "已完成",
  "card.failed": "任务失败",
  "card.cancelled": "已取消",
  "card.answerPlaceholder": "输入你的回答…",
  "card.answer": "回答",
  "card.approve": "批准",
  "card.deny": "拒绝",
  "card.denyNote": "拒绝原因（可选，会告诉 Warren）",
  "card.resume": "继续任务",
  "card.branch": "分支 {branch}",
  "card.pr": "PR #{number}",
  "card.changes": "{files} 个文件 · +{add} −{del}",
  "card.noChanges": "没有改动",

  "meta.networkOn": "可联网",
  "meta.networkOff": "离线",
  "meta.calls": "{n} 次调用",
  "meta.duration": "用时 {duration}",

  "tab.activity": "动态",
  "tab.changes": "改动",
  "action.replay": "回放",
  "action.pause": "暂停",
  "action.resume": "继续",
  "action.cancel": "取消任务",
  "replay.live": "实时",
  "replay.step": "第 {step} / {max} 步",
  "replay.back": "回到实时",

  "steps.inspect": "查看 {n} 处",
  "steps.edit": "修改 {n} 处",
  "steps.run": "运行 {n} 条命令",
  "steps.publish": "发布 {n} 次",
  "steps.other": "{n} 个操作",
  "steps.failed": "{n} 个失败",
  "steps.running": "进行中",

  "tool.ok": "完成",
  "tool.error": "失败",
  "tool.denied": "被拒绝",
  "tool.interrupted": "被中断",
  "tool.running": "运行中",
  "tool.pending": "等待中",
  "tool.awaiting approval": "等待批准",
  "tool.arguments": "参数",
  "tool.output": "输出",

  "who.task": "任务说明",
  "who.you": "你",
  "who.warren": "Warren",
  "who.question": "提问",
  "who.approval": "审批",
  "resolution.approved": "已批准",
  "resolution.denied": "已拒绝",
  "resolution.waiting": "等待你处理",

  "notice.retryable": "模型暂时不可用，正在重试：{message}",
  "notice.fatal": "模型出错：{message}",
  "notice.context_overflow": "对话超出模型上下文：{message}",
  "notice.paused": "已暂停：{reason}",
  "notice.resumed": "已继续",
  "notice.compacted": "已压缩上下文：较早的 {n} 条记录换成了摘要",
  "notice.completed": "任务完成",
  "notice.failed": "任务失败",
  "notice.cancelled": "任务已取消",

  "composer.reply": "回复 Warren，任务会继续…",
  "composer.add": "给 Warren 补充说明…",
  "composer.send": "发送",
  "composer.hint": "↩ 发送 · ⇧↩ 换行",
  "composer.ended": "任务已结束。",

  "changes.loading": "正在读取改动…",
  "changes.none": "工作区还没有改动。",
  "changes.truncated": "改动较多，只显示了一部分。",
  "changes.binary": "二进制文件",
  "changes.error": "无法读取改动：{error}",
  "changes.summary": "{files} 个文件改动",
  "changes.status.added": "新增",
  "changes.status.deleted": "删除",
  "changes.status.renamed": "重命名",
  "changes.status.modified": "修改",

  "duration.h": "{h} 小时 {m} 分",
  "duration.m": "{m} 分 {s} 秒",
  "duration.s": "{s} 秒",
  "ago.now": "刚刚",
  "ago.minutes": "{n} 分钟前",
  "ago.hours": "{n} 小时前",
  "ago.days": "{n} 天前",
  "app.settings": "设置",
  "tab.files": "产物",
  "card.open": "打开 {name}",
  "card.files": "{n} 个文件",
  "card.reveal": "在访达中显示",
  "notice.recovered": "模型连接中断过一次，已自动重试成功（{message}）",

  "files.loading": "正在读取文件…",
  "files.none": "这个任务还没有产生文件。",
  "files.error": "无法读取文件：{error}",
  "files.truncated": "文件较多，只列出了最近的 500 个。",
  "files.location": "保存位置",
  "files.copyPath": "复制路径",
  "files.copied": "已复制",
  "files.reveal": "在访达中显示",
  "files.binary": "这个文件无法在这里预览（{size}），可以在访达中打开。",
  "files.textTruncated": "文件较大，只显示了前 1 MB。",
  "files.rendered": "预览",
  "files.source": "源码",
  "files.htmlNote": "网页以源码显示，不会在这里运行；需要时在访达中用浏览器打开。",
  "files.select": "选择左侧的文件查看内容。",

  "settings.title": "设置",
  "settings.saved": "已保存",
  "settings.error": "保存失败：{error}",
  "settings.save": "保存",
  "settings.revert": "还原",
  "settings.general": "通用",
  "settings.language": "语言",
  "settings.languageHint": "界面文字的语言；任务内容保持原样。",
  "settings.theme": "外观",
  "settings.theme.system": "跟随系统",
  "settings.theme.light": "浅色",
  "settings.theme.dark": "深色",
  "settings.notifications": "系统通知",
  "settings.notificationsHint": "任务需要你或完成时发送 macOS 通知。",
  "settings.models": "模型",
  "settings.modelsIntro":
    "每个角色对应一个模型：新建任务时选择角色，压缩长任务的上下文用“快速”。修改对之后的模型调用立即生效。",
  "settings.provider": "提供方",
  "settings.model": "模型名",
  "settings.baseUrl": "接口地址",
  "settings.effort": "推理强度",
  "settings.effortDefault": "默认",
  "settings.price": "价格（美元 / 百万 token）",
  "settings.priceIn": "输入",
  "settings.priceOut": "输出",
  "settings.usesKey": "使用密钥 {name}",
  "settings.usesNoKey": "不需要密钥",
  "settings.keyMissing": "未设置",
  "settings.keys": "API 密钥",
  "settings.keysIntro": "保存在 {file}，只有你的账户可读。密钥只能写入，界面只显示开头和结尾几位。",
  "settings.keySet": "已设置",
  "settings.keyUnset": "未设置",
  "settings.keyEnv": "来自环境变量，在那里修改",
  "settings.keyUsedBy": "用于 {roles}",
  "settings.keySetAction": "设置",
  "settings.keyReplace": "更换",
  "settings.keyRemove": "删除",
  "settings.keyRemoveConfirm": "确认删除",
  "settings.keyName": "密钥名称",
  "settings.provider.openai-responses": "OpenAI",
  "settings.provider.anthropic": "Anthropic",
  "settings.provider.openai-compatible": "OpenAI 兼容接口",
  "settings.keyCancel": "取消",
  "settings.keyPlaceholder": "粘贴密钥",
  "settings.keyCustom": "添加其他密钥",
  "settings.keyNamePlaceholder": "WARREN_DEEPSEEK_API_KEY",
  "settings.keyHint.WARREN_OPENAI_API_KEY": "OpenAI 模型",
  "settings.keyHint.WARREN_ANTHROPIC_API_KEY": "Claude 模型",
  "settings.keyHint.WARREN_GITHUB_TOKEN": "推送分支、开 PR、GitHub 连接器",
  "settings.keyHint.WARREN_GITHUB_WEBHOOK_SECRET": "校验 GitHub webhook 的签名",
  "settings.tasks": "任务",
  "settings.network": "新任务默认可联网",
  "settings.networkHint": "新建任务时仍可单独开关。",
  "settings.concurrency": "同时运行的任务",
  "settings.concurrencyHint": "超出的任务排队等待。",
  "settings.approvals": "需要你批准的操作",
  "settings.approval.publish_branch": "把任务分支推回源仓库",
  "settings.approval.open_pull_request": "在 GitHub 上开 PR",
  "settings.approvalRequired": "需批准",
  "settings.approvalAuto": "自动",
  "settings.about": "关于",
  "settings.home": "数据目录",
  "settings.configFile": "配置文件",
  "settings.sandbox": "沙箱",
  "settings.restartNote": "GitHub 连接器、端口和沙箱在配置文件里设置，重启 Warren 后生效。",
};

export type MessageKey = keyof typeof zh;

const en: Record<MessageKey, string> = {
  "app.newTask": "New task",
  "app.search": "Search tasks",
  "app.loading": "Loading…",
  "app.unreachable": "The daemon is not reachable",
  "app.sandbox": "Sandbox on",
  "app.noSandbox": "No sandbox",

  "triggers.open": "Events",
  "triggers.title": "GitHub events",
  "triggers.intro":
    "What Warren received from GitHub and what it decided. Rules in observe mode only record the work they would have started; switch them to auto once their judgement looks right.",
  "triggers.none":
    "No events yet. Configure github in ~/.warren/config.json and mentions, labels and CI failures appear here.",
  "decision.create": "Created",
  "decision.observe": "Observed",
  "decision.append": "Appended",
  "decision.answer": "Answered",
  "decision.ignore": "Ignored",
  "kind.comment": "comment",
  "kind.issue_opened": "new issue",
  "kind.issue_labeled": "label",
  "kind.ci_failed": "CI failure",
  "signin.title": "Sign in needed",
  "signin.body": "This page needs the daemon's token. Open it from the terminal:",

  "group.needsYou": "Needs you",
  "group.working": "Working",
  "group.idle": "Waiting for a reply",
  "group.paused": "Paused",
  "group.ended": "Done",
  "row.approve": "Approve",
  "row.asks": "Answer",
  "search.none": "No matching tasks",

  "status.active": "Working",
  "status.waiting": "Needs you",
  "status.idle": "Waiting",
  "status.paused": "Paused",
  "status.ended": "Ended",
  "outcome.completed": "Completed",
  "outcome.failed": "Failed",
  "outcome.cancelled": "Cancelled",

  "home.title": "What should Warren do?",
  "home.body":
    "Say what needs doing and press Enter. It works in its own workspace in the background and only interrupts you when it needs you.",
  "home.placeholder": "Describe the task…",
  "home.shortcuts": "↩ send · ⇧↩ new line · ⌘N back here · ⌘K search tasks",
  "home.example.research":
    "Research the notable projects on today's GitHub trending and write a report",
  "home.example.fix": "Run the repository's tests, fix the failing ones and commit",
  "home.example.notes": "Turn the notes in this folder into one summary",
  "home.networkOn": "Network on",
  "home.networkOff": "Offline",
  "home.pickFolder": "Choose a folder…",
  "home.typePath": "Type a path…",
  "home.clear": "Clear",
  "new.repo": "Folder",
  "new.repoPlaceholder": "Path to a local folder",
  "new.model.main": "Standard",
  "new.model.hard": "Deep",
  "new.model.cheap": "Fast",
  "new.networkHint": "For installing dependencies and downloads",
  "new.repoHint":
    "A git repository is cloned and its result comes back as a branch; any other folder is copied. The original is never changed.",
  "new.choosePrompt": "Choose the folder for the task to work on",
  "new.output": "Save results to",
  "new.outputPlaceholder": "Folder for the task's files",
  "new.outputHint": "When it finishes, save with one click into a new folder named after the task.",
  "new.outputPrompt": "Choose where to save the task's files",
  "card.save": "Save to {dir}",
  "card.saveChoose": "Save to…",
  "card.saved": "Saved to {dir}",
  "notice.exported": "Saved {n} files to {destination}",
  "files.added": "New",
  "files.modified": "Changed",
  "files.copySummary": "Copied from {source}; {unchanged} files unchanged",
  "files.deleted": "Removed {n} files: {files}",
  "files.noChanges": "No files in the folder have changed yet.",

  "step.inspect": "Reading code",
  "step.edit": "Editing files",
  "step.run": "Running a command",
  "step.publish": "Publishing",
  "step.other": "Working",
  "card.thinking": "Thinking about the next step…",
  "card.elapsed": "Running for {duration}",
  "card.question": "Warren needs your answer",
  "card.approval": "Needs your approval",
  "card.idle": "Waiting for your reply",
  "card.idleHint": "Write a message below and the task continues.",
  "card.paused": "Paused",
  "card.completed": "Completed",
  "card.failed": "Task failed",
  "card.cancelled": "Cancelled",
  "card.answerPlaceholder": "Type your answer…",
  "card.answer": "Answer",
  "card.approve": "Approve",
  "card.deny": "Deny",
  "card.denyNote": "Reason (optional, sent to Warren)",
  "card.resume": "Resume task",
  "card.branch": "Branch {branch}",
  "card.pr": "PR #{number}",
  "card.changes": "{files} files · +{add} −{del}",
  "card.noChanges": "No changes",

  "meta.networkOn": "Online",
  "meta.networkOff": "Offline",
  "meta.calls": "{n} calls",
  "meta.duration": "took {duration}",

  "tab.activity": "Activity",
  "tab.changes": "Changes",
  "action.replay": "Replay",
  "action.pause": "Pause",
  "action.resume": "Resume",
  "action.cancel": "Cancel task",
  "replay.live": "Live",
  "replay.step": "Step {step} of {max}",
  "replay.back": "Back to live",

  "steps.inspect": "read {n}",
  "steps.edit": "edited {n}",
  "steps.run": "ran {n} commands",
  "steps.publish": "published {n}",
  "steps.other": "{n} actions",
  "steps.failed": "{n} failed",
  "steps.running": "in progress",

  "tool.ok": "Done",
  "tool.error": "Failed",
  "tool.denied": "Denied",
  "tool.interrupted": "Interrupted",
  "tool.running": "Running",
  "tool.pending": "Pending",
  "tool.awaiting approval": "Awaiting approval",
  "tool.arguments": "Arguments",
  "tool.output": "Output",

  "who.task": "Task",
  "who.you": "You",
  "who.warren": "Warren",
  "who.question": "Question",
  "who.approval": "Approval",
  "resolution.approved": "Approved",
  "resolution.denied": "Denied",
  "resolution.waiting": "Waiting for you",

  "notice.retryable": "Model temporarily unavailable, retrying: {message}",
  "notice.fatal": "Model error: {message}",
  "notice.context_overflow": "The conversation no longer fits the model: {message}",
  "notice.paused": "Paused: {reason}",
  "notice.resumed": "Resumed",
  "notice.compacted": "Context compacted: {n} earlier items replaced by a summary",
  "notice.completed": "Task completed",
  "notice.failed": "Task failed",
  "notice.cancelled": "Task cancelled",

  "composer.reply": "Reply to Warren to continue…",
  "composer.add": "Add a note for Warren…",
  "composer.send": "Send",
  "composer.hint": "↩ send · ⇧↩ new line",
  "composer.ended": "This task has ended.",

  "changes.loading": "Reading changes…",
  "changes.none": "No changes in the workspace yet.",
  "changes.truncated": "Large change; only part of it is shown.",
  "changes.binary": "Binary file",
  "changes.error": "Could not read changes: {error}",
  "changes.summary": "{files} files changed",
  "changes.status.added": "added",
  "changes.status.deleted": "deleted",
  "changes.status.renamed": "renamed",
  "changes.status.modified": "modified",

  "duration.h": "{h}h {m}m",
  "duration.m": "{m}m {s}s",
  "duration.s": "{s}s",
  "ago.now": "just now",
  "ago.minutes": "{n}m ago",
  "ago.hours": "{n}h ago",
  "ago.days": "{n}d ago",
  "app.settings": "Settings",
  "tab.files": "Files",
  "card.open": "Open {name}",
  "card.files": "{n} files",
  "card.reveal": "Show in Finder",
  "notice.recovered": "The model connection dropped once; the retry succeeded ({message})",

  "files.loading": "Reading files…",
  "files.none": "This task has not produced any files yet.",
  "files.error": "Could not read files: {error}",
  "files.truncated": "Many files; only the 500 most recent are listed.",
  "files.location": "Saved in",
  "files.copyPath": "Copy path",
  "files.copied": "Copied",
  "files.reveal": "Show in Finder",
  "files.binary": "This file cannot be previewed here ({size}); open it from Finder.",
  "files.textTruncated": "Large file: only the first 1 MB is shown.",
  "files.rendered": "Preview",
  "files.source": "Source",
  "files.htmlNote":
    "Web pages are shown as source and never run here; open one from Finder to view it in a browser.",
  "files.select": "Pick a file on the left to see it.",

  "settings.title": "Settings",
  "settings.saved": "Saved",
  "settings.error": "Could not save: {error}",
  "settings.save": "Save",
  "settings.revert": "Revert",
  "settings.general": "General",
  "settings.language": "Language",
  "settings.languageHint": "Language of the interface; task content stays as written.",
  "settings.theme": "Appearance",
  "settings.theme.system": "System",
  "settings.theme.light": "Light",
  "settings.theme.dark": "Dark",
  "settings.notifications": "Notifications",
  "settings.notificationsHint": "A macOS notification when a task needs you or finishes.",
  "settings.models": "Models",
  "settings.modelsIntro":
    "Each role maps to a model: pick a role when you start a task; long tasks are compacted with Fast. Changes apply to the next model call.",
  "settings.provider": "Provider",
  "settings.model": "Model",
  "settings.baseUrl": "Endpoint",
  "settings.effort": "Reasoning",
  "settings.effortDefault": "Default",
  "settings.price": "Price (USD per million tokens)",
  "settings.priceIn": "Input",
  "settings.priceOut": "Output",
  "settings.usesKey": "Uses {name}",
  "settings.usesNoKey": "No key needed",
  "settings.keyMissing": "not set",
  "settings.keys": "API keys",
  "settings.keysIntro":
    "Stored in {file}, readable only by your account. Keys are write-only; only their first and last characters are shown.",
  "settings.keySet": "Set",
  "settings.keyUnset": "Not set",
  "settings.keyEnv": "From the environment; change it there",
  "settings.keyUsedBy": "Used by {roles}",
  "settings.keySetAction": "Set",
  "settings.keyReplace": "Replace",
  "settings.keyRemove": "Remove",
  "settings.keyRemoveConfirm": "Confirm",
  "settings.keyName": "Key name",
  "settings.provider.openai-responses": "OpenAI",
  "settings.provider.anthropic": "Anthropic",
  "settings.provider.openai-compatible": "OpenAI-compatible",
  "settings.keyCancel": "Cancel",
  "settings.keyPlaceholder": "Paste the key",
  "settings.keyCustom": "Add another key",
  "settings.keyNamePlaceholder": "WARREN_DEEPSEEK_API_KEY",
  "settings.keyHint.WARREN_OPENAI_API_KEY": "OpenAI models",
  "settings.keyHint.WARREN_ANTHROPIC_API_KEY": "Claude models",
  "settings.keyHint.WARREN_GITHUB_TOKEN": "Pushing branches, pull requests, GitHub connector",
  "settings.keyHint.WARREN_GITHUB_WEBHOOK_SECRET": "Verifies GitHub webhook signatures",
  "settings.tasks": "Tasks",
  "settings.network": "New tasks may use the network",
  "settings.networkHint": "Each new task can still turn it on or off.",
  "settings.concurrency": "Tasks running at once",
  "settings.concurrencyHint": "Others wait in a queue.",
  "settings.approvals": "Actions that need your approval",
  "settings.approval.publish_branch": "Push a task's branch back to the source repository",
  "settings.approval.open_pull_request": "Open a pull request on GitHub",
  "settings.approvalRequired": "Ask me",
  "settings.approvalAuto": "Automatic",
  "settings.about": "About",
  "settings.home": "Data folder",
  "settings.configFile": "Config file",
  "settings.sandbox": "Sandbox",
  "settings.restartNote":
    "The GitHub connector, port and sandbox are set in the config file and apply after Warren restarts.",
};

const MESSAGES: Record<Lang, Record<MessageKey, string>> = { zh, en };

/** Whether a key built at run time, such as a hint per secret name, has a message. */
export function isMessageKey(key: string): key is MessageKey {
  return key in zh;
}

export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

export function translator(lang: Lang): Translate {
  return (key, params) =>
    MESSAGES[lang][key].replace(/\{(\w+)\}/g, (match, name: string) =>
      params && name in params ? String(params[name]) : match,
    );
}

export function statusLabel(t: Translate, status: TaskStatus): string {
  return t(`status.${status}`);
}

export function stepLabel(t: Translate, category: StepCategory): string {
  return t(`step.${category}`);
}

export function toolStatusLabel(t: Translate, status: ToolStatus): string {
  return t(`tool.${status}`);
}

export function formatAgo(t: Translate, ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 45) return t("ago.now");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("ago.minutes", { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t("ago.hours", { n: hours });
  return t("ago.days", { n: Math.round(hours / 24) });
}

export function formatDuration(t: Translate, ms: number): string {
  const { h, m, s } = durationParts(ms);
  if (h > 0) return t("duration.h", { h, m });
  if (m > 0) return t("duration.m", { m, s });
  return t("duration.s", { s });
}

const LANG_KEY = "warren.lang";

export function savedLang(): Lang {
  try {
    return localStorage.getItem(LANG_KEY) === "en" ? "en" : "zh";
  } catch {
    return "zh";
  }
}

export function saveLang(lang: Lang): void {
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // Without storage the choice lasts until the page reloads.
  }
}
