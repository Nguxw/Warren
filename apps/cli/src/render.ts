import type { TaskEvent, TaskSummary, TriggerRecord } from "@warren/protocol";

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (text: string) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
export const dim = paint(2);
export const bold = paint(1);
export const red = paint(31);
export const green = paint(32);
export const yellow = paint(33);
export const cyan = paint(36);

export function shortId(id: string): string {
  return id.replaceAll("-", "").slice(-8);
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function firstLines(text: string, count: number): string {
  const lines = text.trimEnd().split("\n");
  const shown = lines.slice(0, count).join("\n");
  return lines.length > count ? `${shown}\n… ${lines.length - count} more lines` : shown;
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");
}

/** One event as terminal lines; undefined when it is not worth showing. */
export function renderEvent(event: TaskEvent): string | undefined {
  switch (event.type) {
    case "task.created":
      return `${bold(`▶ ${event.data.title}`)} ${dim(`(${shortId(event.taskId)})`)}`;
    case "input.received":
      return `${cyan("you")}  ${event.data.item.content.map((p) => p.text).join("\n")}`;
    case "model.responded": {
      const lines: string[] = [];
      for (const item of event.data.items) {
        if (item.type === "message") {
          lines.push(`${green("warren")}  ${item.content.map((p) => p.text).join("\n")}`);
        } else if (item.type === "tool_call") {
          if (item.name === "complete_task" || item.name === "ask_user") continue;
          lines.push(dim(`  → ${item.name} ${clip(item.arguments, 110)}`));
        } else if (item.type === "reasoning" && item.summary) {
          lines.push(dim(indent(clip(item.summary, 200), "  · ")));
        }
      }
      return lines.length > 0 ? lines.join("\n") : undefined;
    }
    case "model.failed":
      return yellow(`  ! model ${event.data.kind}: ${clip(event.data.message, 160)}`);
    case "tool.started":
      return undefined;
    case "tool.finished": {
      const text = event.data.content.map((p) => p.text).join("\n");
      if (text === "Task completed.") return undefined;
      const mark = event.data.outcome === "ok" ? dim("←") : red(`← ${event.data.outcome}`);
      const [head = "", ...rest] = firstLines(text, 4).split("\n");
      const tail = rest.length > 0 ? `\n${dim(indent(rest.join("\n"), "      "))}` : "";
      return `    ${mark} ${dim(head)}${tail}`;
    }
    case "attention.requested": {
      const id = shortId(event.taskId);
      if (event.data.kind === "approval") {
        return `${yellow("⚠ needs approval: ")}${bold(event.data.prompt)}\n${dim(
          `  warren approve ${id}   ·   warren deny ${id} "<reason>"`,
        )}`;
      }
      return `${yellow("? ")}${bold(event.data.prompt)}\n${dim(
        `  answer with: warren answer ${id} "<your answer>"`,
      )}`;
    }
    case "attention.resolved": {
      const verdict =
        event.data.approved === undefined
          ? ""
          : event.data.approved
            ? green("approved ")
            : red("denied ");
      return `${cyan("you")}  ${verdict}${event.data.response}`;
    }
    case "task.paused":
      return yellow(`■ paused: ${event.data.reason}`);
    case "task.resumed":
      return dim("▶ resumed");
    case "task.ended": {
      const color =
        event.data.outcome === "completed" ? green : event.data.outcome === "failed" ? red : yellow;
      const summary = event.data.summary ? `\n${event.data.summary}` : "";
      return `${color(bold(`■ ${event.data.outcome}`))}${summary}`;
    }
  }
}

export function renderTask(task: TaskSummary, now = Date.now()): string {
  const color =
    task.status === "waiting"
      ? yellow
      : task.status === "active"
        ? cyan
        : task.status === "ended"
          ? dim
          : (s: string) => s;
  const repo = task.repo ? `${dim(`[${task.repo}]`)} ` : "";
  return `${dim(shortId(task.id))}  ${color(task.status.padEnd(7))}  ${repo}${task.title}  ${dim(ago(now - task.updatedAt))}`;
}

function ago(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

export function renderUsage(usage: {
  modelCalls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
}): string {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return dim(
    `${usage.modelCalls} model calls · ${k(usage.inputTokens)} in (${k(usage.cachedInputTokens)} cached) · ${k(usage.outputTokens)} out · $${usage.costUsd.toFixed(4)}`,
  );
}

export function renderTrigger(record: TriggerRecord, now = Date.now()): string {
  const { event, decision } = record;
  const action =
    decision.action === "create"
      ? green("create ")
      : decision.action === "observe"
        ? yellow("observe")
        : decision.action === "ignore"
          ? dim("ignore ")
          : cyan(decision.action.padEnd(7));
  const where = event.thread.replace(/^github:/, "");
  const who = event.actor ? `@${event.actor}` : event.kind;
  const why =
    decision.action === "ignore" || decision.action === "observe"
      ? dim(decision.reason)
      : decision.action === "create"
        ? decision.title
        : "";
  const task = record.taskId ? dim(` → ${shortId(record.taskId)}`) : "";
  return `${dim(ago(now - record.receivedAt).padEnd(9))} ${action} ${where} ${dim(who)}  ${why}${task}`;
}
