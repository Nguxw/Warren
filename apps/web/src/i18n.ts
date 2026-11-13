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
  "app.switchLang": "EN",
  "app.switchLangTitle": "Switch to English",
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

  "empty.title": "交给 Warren 一个任务",
  "empty.body": "它会在后台的独立工作区里完成，只在需要你的时候打扰你。",
  "empty.select": "从左侧选择一个任务，或新建一个。",
  "empty.shortcuts": "⌘N 新建任务 · ⌘K 搜索",

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

  "new.title": "新建任务",
  "new.placeholder": "描述要完成的事，例如：修复失败的日期测试，提交并发布分支。",
  "new.repo": "仓库",
  "new.repoNone": "不使用仓库",
  "new.repoPlaceholder": "本地 git 仓库路径",
  "new.recent": "最近使用",
  "new.model": "模型",
  "new.model.main": "标准",
  "new.model.hard": "深度",
  "new.model.cheap": "快速",
  "new.network": "允许联网",
  "new.networkHint": "安装依赖、下载文件时需要",
  "new.cancel": "取消",
  "new.start": "开始任务",
  "new.starting": "启动中…",

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
  "notice.completed": "任务完成",
  "notice.failed": "任务失败",
  "notice.cancelled": "任务已取消",

  "composer.reply": "回复 Warren，任务会继续…",
  "composer.add": "给 Warren 补充说明…",
  "composer.send": "发送",
  "composer.hint": "⌘↩ 发送",
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
};

export type MessageKey = keyof typeof zh;

const en: Record<MessageKey, string> = {
  "app.newTask": "New task",
  "app.search": "Search tasks",
  "app.loading": "Loading…",
  "app.unreachable": "The daemon is not reachable",
  "app.switchLang": "中",
  "app.switchLangTitle": "切换到中文",
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

  "empty.title": "Give Warren a task",
  "empty.body":
    "It works in its own workspace in the background, and only interrupts you when it needs you.",
  "empty.select": "Pick a task on the left, or start a new one.",
  "empty.shortcuts": "⌘N new task · ⌘K search",

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

  "new.title": "New task",
  "new.placeholder":
    "Describe the work, e.g. fix the failing date tests, commit and publish the branch.",
  "new.repo": "Repository",
  "new.repoNone": "No repository",
  "new.repoPlaceholder": "Path to a local git repository",
  "new.recent": "Recent",
  "new.model": "Model",
  "new.model.main": "Standard",
  "new.model.hard": "Deep",
  "new.model.cheap": "Fast",
  "new.network": "Allow network",
  "new.networkHint": "For installing dependencies and downloads",
  "new.cancel": "Cancel",
  "new.start": "Start task",
  "new.starting": "Starting…",

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
  "notice.completed": "Task completed",
  "notice.failed": "Task failed",
  "notice.cancelled": "Task cancelled",

  "composer.reply": "Reply to Warren to continue…",
  "composer.add": "Add a note for Warren…",
  "composer.send": "Send",
  "composer.hint": "⌘↩ to send",
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
};

const MESSAGES: Record<Lang, Record<MessageKey, string>> = { zh, en };

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
