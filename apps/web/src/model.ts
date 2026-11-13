import type { TaskEvent, TaskSummary, ToolOutcome } from "@warren/protocol";

/**
 * View models for the interface, as pure functions of API data so they can be tested without a
 * browser. The timeline is a projection of a task's event log, like everything else in Warren.
 */

export type ToolStatus = "pending" | "awaiting approval" | "running" | ToolOutcome;

export type Entry =
  | { kind: "instruction"; seq: number; at: number; text: string }
  | { kind: "user"; seq: number; at: number; text: string; source: string }
  | { kind: "assistant"; seq: number; at: number; text: string }
  | { kind: "reasoning"; seq: number; at: number; text: string }
  | {
      kind: "tool";
      seq: number;
      at: number;
      callId: string;
      name: string;
      args: string;
      status: ToolStatus;
      output?: string;
    }
  | {
      kind: "attention";
      seq: number;
      at: number;
      attentionId: string;
      type: "question" | "approval";
      prompt: string;
      resolved?: { response: string; approved?: boolean };
    }
  | {
      kind: "notice";
      seq: number;
      at: number;
      tone: "info" | "warn" | "error" | "success";
      notice: Notice;
    };

/** What a notice says, as data; the interface words it in the reader's language. */
export type Notice =
  | { type: "retryable" | "fatal" | "context_overflow"; message: string }
  | { type: "paused"; reason: string }
  | { type: "resumed" }
  | { type: "completed" | "failed" | "cancelled"; summary?: string };

/** An entry with a key that stays the same as the log grows: `<seq>.<n-th entry of that event>`. */
export type KeyedEntry = Entry & { key: string };

/** Tools whose calls the timeline shows through their effect instead of as a tool row. */
const SILENT_TOOLS = new Set(["complete_task", "ask_user"]);

export function timeline(events: readonly TaskEvent[]): KeyedEntry[] {
  const entries: Entry[] = [];
  const tools = new Map<string, Extract<Entry, { kind: "tool" }>>();
  const attention = new Map<string, Extract<Entry, { kind: "attention" }>>();

  for (const event of events) {
    const { seq, at } = event;
    switch (event.type) {
      case "task.created":
        entries.push({ kind: "instruction", seq, at, text: event.data.instruction });
        break;
      case "input.received":
        entries.push({
          kind: "user",
          seq,
          at,
          text: joinText(event.data.item.content),
          source: event.data.trigger.source,
        });
        break;
      case "model.responded":
        for (const item of event.data.items) {
          if (item.type === "message") {
            entries.push({ kind: "assistant", seq, at, text: joinText(item.content) });
          } else if (item.type === "reasoning" && item.summary) {
            entries.push({ kind: "reasoning", seq, at, text: item.summary });
          } else if (item.type === "tool_call" && !SILENT_TOOLS.has(item.name)) {
            const entry = {
              kind: "tool" as const,
              seq,
              at,
              callId: item.callId,
              name: item.name,
              args: item.arguments,
              status: "pending" as ToolStatus,
            };
            tools.set(item.callId, entry);
            entries.push(entry);
          }
        }
        break;
      case "model.failed":
        entries.push({
          kind: "notice",
          seq,
          at,
          tone: event.data.kind === "retryable" ? "warn" : "error",
          notice: { type: event.data.kind, message: event.data.message },
        });
        break;
      case "tool.started": {
        const tool = tools.get(event.data.callId);
        if (tool) tool.status = "running";
        break;
      }
      case "tool.finished": {
        const tool = tools.get(event.data.callId);
        if (tool) {
          tool.status = event.data.outcome;
          tool.output = joinText(event.data.content);
        }
        break;
      }
      case "attention.requested": {
        const entry = {
          kind: "attention" as const,
          seq,
          at,
          attentionId: event.data.attentionId,
          type: event.data.kind,
          prompt: event.data.prompt,
        };
        attention.set(event.data.attentionId, entry);
        entries.push(entry);
        const tool = event.data.callId ? tools.get(event.data.callId) : undefined;
        if (tool && event.data.kind === "approval") tool.status = "awaiting approval";
        break;
      }
      case "attention.resolved": {
        const entry = attention.get(event.data.attentionId);
        if (entry) {
          entry.resolved = {
            response: event.data.response,
            ...(event.data.approved !== undefined && { approved: event.data.approved }),
          };
        }
        for (const tool of tools.values()) {
          if (tool.status === "awaiting approval") tool.status = "pending";
        }
        break;
      }
      case "task.paused":
        entries.push({
          kind: "notice",
          seq,
          at,
          tone: "warn",
          notice: { type: "paused", reason: event.data.reason },
        });
        break;
      case "task.resumed":
        entries.push({ kind: "notice", seq, at, tone: "info", notice: { type: "resumed" } });
        break;
      case "task.ended": {
        const tone =
          event.data.outcome === "completed"
            ? "success"
            : event.data.outcome === "failed"
              ? "error"
              : "warn";
        entries.push({
          kind: "notice",
          seq,
          at,
          tone,
          notice: {
            type: event.data.outcome,
            ...(event.data.summary !== undefined && { summary: event.data.summary }),
          },
        });
        break;
      }
    }
  }
  const perSeq = new Map<number, number>();
  return entries.map((entry) => {
    const n = perSeq.get(entry.seq) ?? 0;
    perSeq.set(entry.seq, n + 1);
    return { ...entry, key: `${entry.seq}.${n}` };
  });
}

export interface TaskGroups {
  needsYou: TaskSummary[];
  working: TaskSummary[];
  idle: TaskSummary[];
  paused: TaskSummary[];
  ended: TaskSummary[];
}

/** The inbox order: what waits for a person first, finished work last. */
export function groupTasks(tasks: readonly TaskSummary[]): TaskGroups {
  const groups: TaskGroups = { needsYou: [], working: [], idle: [], paused: [], ended: [] };
  for (const task of tasks) {
    const key =
      task.status === "waiting"
        ? "needsYou"
        : task.status === "active"
          ? "working"
          : task.status === "ended"
            ? "ended"
            : task.status;
    groups[key].push(task);
  }
  for (const list of Object.values(groups) as TaskSummary[][]) {
    list.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  return groups;
}

export function shortId(id: string): string {
  return id.replaceAll("-", "").slice(-8);
}

export function compact(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Tool arguments as one short line, for a collapsed tool row. */
export function argsPreview(args: string, max = 120): string {
  let text = args;
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    const first = parsed.command ?? parsed.path ?? parsed.pattern ?? parsed.title;
    if (typeof first === "string") text = first;
  } catch {
    // Arguments the model got wrong are shown raw.
  }
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function joinText(parts: readonly { text: string }[]): string {
  return parts.map((part) => part.text).join("\n");
}
