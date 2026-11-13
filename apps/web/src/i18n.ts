import type { TaskStatus } from "@warren/protocol";

/**
 * Interface languages. Chinese is the default; the choice is remembered per browser.
 * Only Warren's own words are translated: task titles, prompts and model output stay as written.
 */

export type Lang = "zh" | "en";

const zh = {
  "app.noSandbox": "无沙箱",
  "app.newTask": "新建任务",
  "app.loading": "加载中…",
  "app.unreachable": "无法连接守护进程。",
  "app.switchLang": "EN",
  "app.switchLangTitle": "Switch to English",

  "signin.body": "此页面需要守护进程的令牌。请在终端中打开：",

  "empty.none": "还没有任务",
  "empty.noneHint": "点击“新建任务”，或在终端运行 warren run。",
  "empty.unselected": "未选择任务",
  "empty.unselectedHint": "从左侧选择一个任务。需要你处理的任务排在最前。",

  "group.needsYou": "需要你处理",
  "group.working": "进行中",
  "group.idle": "等待回复",
  "group.paused": "已暂停",
  "group.ended": "已结束",
  "row.approve": "待批准：",
  "row.asks": "提问：",

  "status.active": "进行中",
  "status.waiting": "等你处理",
  "status.idle": "等待回复",
  "status.paused": "已暂停",
  "status.ended": "已结束",

  "new.title": "新建任务",
  "new.instruction": "要 Warren 做什么？",
  "new.instructionPlaceholder": "修复失败的日期测试，然后提交并发布分支。",
  "new.repo": "仓库",
  "new.repoHint": "（可选，本地 git 仓库）",
  "new.repoPlaceholder": "/Users/you/code/project",
  "new.model": "模型",
  "new.network": "允许联网",
  "new.networkHint": "（安装依赖、下载等）",
  "new.starting": "启动中…",
  "new.start": "开始任务",

  "meta.model": "模型：{role}",
  "meta.repo": "仓库：{repo}",
  "meta.networkOn": "网络：开",
  "meta.networkOff": "网络：关",
  "meta.usage": "{calls} 次调用 · 输入 {input}（缓存 {cached}）· 输出 {output} · {cost}",

  "control.pause": "暂停",
  "control.resume": "继续",
  "control.cancel": "取消",

  "attention.approval": "需要你批准",
  "attention.question": "Warren 提问",
  "attention.notePlaceholder": "可选备注（拒绝时会一并发送）",
  "attention.answerPlaceholder": "你的回答",
  "attention.approve": "批准",
  "attention.deny": "拒绝",
  "attention.answer": "回答",

  "replay.live": "实时",
  "replay.step": "第 {step} / {max} 步",
  "replay.back": "回到实时",

  "who.task": "任务",
  "who.you": "你",
  "who.warren": "Warren",
  "who.approval": "审批",
  "who.question": "提问",
  "resolution.approved": "已批准。",
  "resolution.denied": "已拒绝。",

  "notice.retryable": "模型暂时不可用：{message}",
  "notice.fatal": "模型出错：{message}",
  "notice.context_overflow": "对话超出模型上下文：{message}",
  "notice.paused": "已暂停：{reason}",
  "notice.resumed": "已继续",
  "notice.completed": "任务完成",
  "notice.failed": "任务失败",
  "notice.cancelled": "任务已取消",

  "composer.ended": "此任务已结束。",
  "composer.reply": "回复以继续任务…（⌘↩ 发送）",
  "composer.add": "给任务补充消息…（⌘↩ 发送）",
  "composer.send": "发送",

  "ago.now": "刚刚",
  "ago.minutes": "{n} 分钟前",
  "ago.hours": "{n} 小时前",
  "ago.days": "{n} 天前",
};

export type MessageKey = keyof typeof zh;

const en: Record<MessageKey, string> = {
  "app.noSandbox": "no sandbox",
  "app.newTask": "New task",
  "app.loading": "Loading…",
  "app.unreachable": "The daemon is not reachable.",
  "app.switchLang": "中",
  "app.switchLangTitle": "切换到中文",

  "signin.body": "This page needs the daemon's token. Open it from the terminal:",

  "empty.none": "No tasks yet",
  "empty.noneHint": "Start one with New task, or from the terminal with warren run.",
  "empty.unselected": "Nothing selected",
  "empty.unselectedHint": "Pick a task on the left. Tasks that need you are listed first.",

  "group.needsYou": "Needs you",
  "group.working": "Working",
  "group.idle": "Waiting for a reply",
  "group.paused": "Paused",
  "group.ended": "Finished",
  "row.approve": "Approve: ",
  "row.asks": "Asks: ",

  "status.active": "working",
  "status.waiting": "needs you",
  "status.idle": "waiting",
  "status.paused": "paused",
  "status.ended": "ended",

  "new.title": "New task",
  "new.instruction": "What should Warren do?",
  "new.instructionPlaceholder": "Fix the failing date tests, then commit and publish the branch.",
  "new.repo": "Repository",
  "new.repoHint": "(optional, a local git repository)",
  "new.repoPlaceholder": "/Users/you/code/project",
  "new.model": "Model",
  "new.network": "Allow network",
  "new.networkHint": "(installs, downloads)",
  "new.starting": "Starting…",
  "new.start": "Start task",

  "meta.model": "model: {role}",
  "meta.repo": "repo: {repo}",
  "meta.networkOn": "network: on",
  "meta.networkOff": "network: off",
  "meta.usage": "{calls} calls · {input} in ({cached} cached) · {output} out · {cost}",

  "control.pause": "Pause",
  "control.resume": "Resume",
  "control.cancel": "Cancel",

  "attention.approval": "Needs your approval",
  "attention.question": "Warren asks",
  "attention.notePlaceholder": "Optional note (sent with a denial)",
  "attention.answerPlaceholder": "Your answer",
  "attention.approve": "Approve",
  "attention.deny": "Deny",
  "attention.answer": "Answer",

  "replay.live": "Live",
  "replay.step": "Step {step} of {max}",
  "replay.back": "Back to live",

  "who.task": "Task",
  "who.you": "You",
  "who.warren": "Warren",
  "who.approval": "Approval",
  "who.question": "Question",
  "resolution.approved": "Approved.",
  "resolution.denied": "Denied.",

  "notice.retryable": "Model temporarily unavailable: {message}",
  "notice.fatal": "Model error: {message}",
  "notice.context_overflow": "The conversation no longer fits the model: {message}",
  "notice.paused": "Paused: {reason}",
  "notice.resumed": "Resumed",
  "notice.completed": "Task completed",
  "notice.failed": "Task failed",
  "notice.cancelled": "Task cancelled",

  "composer.ended": "This task has ended.",
  "composer.reply": "Reply to continue the task… (⌘↩ to send)",
  "composer.add": "Add a message for the task… (⌘↩ to send)",
  "composer.send": "Send",

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

export function formatAgo(t: Translate, ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 45) return t("ago.now");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("ago.minutes", { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t("ago.hours", { n: hours });
  return t("ago.days", { n: Math.round(hours / 24) });
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
