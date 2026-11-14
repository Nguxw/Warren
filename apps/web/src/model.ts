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
  /** A retryable failure the next attempt got past. */
  | { type: "recovered"; message: string }
  | { type: "paused"; reason: string }
  | { type: "resumed" }
  | { type: "compacted"; replaces: number }
  | { type: "completed" | "failed" | "cancelled"; summary?: string };

/** An entry with a key that stays the same as the log grows: `<seq>.<n-th entry of that event>`. */
export type KeyedEntry = Entry & { key: string };

/** Tools whose calls the timeline shows through their effect instead of as a tool row. */
const SILENT_TOOLS = new Set(["complete_task", "ask_user"]);

export function timeline(events: readonly TaskEvent[]): KeyedEntry[] {
  const entries: Entry[] = [];
  const tools = new Map<string, Extract<Entry, { kind: "tool" }>>();
  const attention = new Map<string, Extract<Entry, { kind: "attention" }>>();
  // Retryable failures not yet followed by a response; they stop being warnings once one comes.
  let retrying: Extract<Entry, { kind: "notice" }>[] = [];

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
        for (const entry of retrying) {
          if (entry.notice.type === "retryable") {
            entry.tone = "info";
            entry.notice = { type: "recovered", message: entry.notice.message };
          }
        }
        retrying = [];
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
      case "model.failed": {
        const entry = {
          kind: "notice" as const,
          seq,
          at,
          tone: event.data.kind === "retryable" ? ("warn" as const) : ("error" as const),
          notice: { type: event.data.kind, message: event.data.message },
        };
        entries.push(entry);
        if (event.data.kind === "retryable") retrying.push(entry);
        break;
      }
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
      case "context.compacted":
        entries.push({
          kind: "notice",
          seq,
          at,
          tone: "info",
          notice: { type: "compacted", replaces: event.data.replaces },
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

// ------------------------------------------------------------------ activity

export type ToolEntry = Extract<KeyedEntry, { kind: "tool" }>;
export type StepCategory = "inspect" | "edit" | "run" | "publish" | "other";

const CATEGORIES: Record<string, StepCategory> = {
  read_file: "inspect",
  list_files: "inspect",
  search: "inspect",
  edit_file: "edit",
  write_file: "edit",
  shell: "run",
  publish_branch: "publish",
  open_pull_request: "publish",
};

export function categoryOf(tool: string): StepCategory {
  return CATEGORIES[tool] ?? "other";
}

/**
 * The activity feed: the conversation stays as it is, and every run of consecutive tool calls
 * becomes one collapsible group summarised by what kind of work it did.
 */
export type Block =
  | { kind: "entry"; key: string; entry: KeyedEntry }
  | {
      kind: "steps";
      key: string;
      tools: ToolEntry[];
      counts: Partial<Record<StepCategory, number>>;
      failed: number;
      active: boolean;
    };

export function activity(entries: readonly KeyedEntry[]): Block[] {
  const blocks: Block[] = [];
  let group: Extract<Block, { kind: "steps" }> | undefined;
  for (const entry of entries) {
    if (entry.kind !== "tool") {
      group = undefined;
      blocks.push({ kind: "entry", key: entry.key, entry });
      continue;
    }
    if (!group) {
      group = { kind: "steps", key: entry.key, tools: [], counts: {}, failed: 0, active: false };
      blocks.push(group);
    }
    group.tools.push(entry);
    const category = categoryOf(entry.name);
    group.counts[category] = (group.counts[category] ?? 0) + 1;
    if (entry.status === "error" || entry.status === "denied" || entry.status === "interrupted") {
      group.failed += 1;
    }
    if (
      entry.status === "running" ||
      entry.status === "pending" ||
      entry.status === "awaiting approval"
    ) {
      group.active = true;
    }
  }
  return blocks;
}

/** The call the task is working on right now, if any. */
export function currentStep(entries: readonly KeyedEntry[]): ToolEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.kind === "tool" && (entry.status === "running" || entry.status === "pending")) {
      return entry;
    }
  }
  return undefined;
}

export interface Deliverables {
  branch?: string;
  pullRequest?: { number: number; url: string };
}

/** What the task handed back, read from its privileged tools' results. */
export function deliverables(entries: readonly KeyedEntry[]): Deliverables {
  const result: Deliverables = {};
  for (const entry of entries) {
    if (entry.kind !== "tool" || entry.status !== "ok" || !entry.output) continue;
    const branch = / as branch (\S+?)\.?$/m.exec(entry.output)?.[1];
    if (entry.name === "publish_branch" && branch) result.branch = branch;
    const pr = /pull request #(\d+): (\S+)/.exec(entry.output);
    if (entry.name === "open_pull_request" && pr?.[1] && pr[2]) {
      result.pullRequest = { number: Number(pr[1]), url: pr[2] };
    }
    const open = /already open: (\S+\/pull\/(\d+))/.exec(entry.output);
    if (entry.name === "open_pull_request" && open?.[1] && open[2]) {
      result.pullRequest = { number: Number(open[2]), url: open[1] };
    }
  }
  return result;
}

// ------------------------------------------------------------------ diff

export interface DiffLine {
  kind: "add" | "del" | "context" | "hunk";
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface DiffFile {
  path: string;
  status: "added" | "deleted" | "modified" | "renamed";
  additions: number;
  deletions: number;
  binary: boolean;
  lines: DiffLine[];
}

/** Parses `git diff` output into files and numbered lines. */
export function parseDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let oldLine = 0;
  let newLine = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const path = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)?.[2] ?? line.slice(11);
      file = { path, status: "modified", additions: 0, deletions: 0, binary: false, lines: [] };
      files.push(file);
      continue;
    }
    if (!file) continue;
    if (line.startsWith("new file mode")) file.status = "added";
    else if (line.startsWith("deleted file mode")) file.status = "deleted";
    else if (line.startsWith("rename to ")) {
      file.status = "renamed";
      file.path = line.slice(10);
    } else if (line.startsWith("Binary files")) file.binary = true;
    else if (line.startsWith("+++ ")) {
      const target = line.slice(4);
      if (target.startsWith("b/")) file.path = target.slice(2);
    } else if (line.startsWith("--- ") || line.startsWith("index ")) {
      // Header lines carry nothing the view needs.
    } else if (line.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldLine = Number(match?.[1] ?? 0);
      newLine = Number(match?.[2] ?? 0);
      file.lines.push({ kind: "hunk", text: line });
    } else if (line.startsWith("+")) {
      file.additions += 1;
      file.lines.push({ kind: "add", text: line.slice(1), newLine: newLine++ });
    } else if (line.startsWith("-")) {
      file.deletions += 1;
      file.lines.push({ kind: "del", text: line.slice(1), oldLine: oldLine++ });
    } else if (line.startsWith(" ")) {
      file.lines.push({
        kind: "context",
        text: line.slice(1),
        oldLine: oldLine++,
        newLine: newLine++,
      });
    }
  }
  return files;
}

/** Elapsed time as minutes and seconds (or hours and minutes), for the UI to word. */
export function durationParts(ms: number): { h: number; m: number; s: number } {
  const total = Math.max(0, Math.round(ms / 1000));
  return { h: Math.floor(total / 3600), m: Math.floor((total % 3600) / 60), s: total % 60 };
}

/** Titles from before repositories were shown separately began with "<repo>: "; drop that. */
export function displayTitle(title: string, repo: string | undefined): string {
  return repo && title.startsWith(`${repo}: `) ? title.slice(repo.length + 2) : title;
}

/** A file size for people: 812 B, 14 KB, 3.2 MB. */
export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1_000_000) return `${Math.round(n / 1000)} KB`;
  return `${(n / 1_000_000).toFixed(1)} MB`;
}

export type PreviewKind = "markdown" | "html" | "text";

/** How a text file is best shown. HTML is shown as source: model-written pages never run here. */
export function previewKind(path: string): PreviewKind {
  const ext = path.toLowerCase().split(".").at(-1) ?? "";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "html" || ext === "htm") return "html";
  return "text";
}

const REPORT_EXTENSIONS = ["md", "markdown", "html", "htm", "pdf", "txt", "csv", "json"];

/**
 * The file a person most likely wants to open first: a document at the top of the workspace,
 * preferring reports over data, then the newest. Files are expected newest first.
 */
export function primaryArtifact<T extends { path: string }>(files: readonly T[]): T | undefined {
  const rank = (path: string) => {
    const ext = path.toLowerCase().split(".").at(-1) ?? "";
    const kind = REPORT_EXTENSIONS.indexOf(ext);
    const depth = path.split("/").length - 1;
    return (kind === -1 ? 100 : kind) + depth * 10;
  };
  let best: T | undefined;
  for (const file of files) if (!best || rank(file.path) < rank(best.path)) best = file;
  return best;
}

export interface FileGroups<T extends { path: string }> {
  /** Files at the top of the workspace, the likely deliverables, the main one first. */
  top: T[];
  /** Everything else by top-level folder: sources, data, caches. */
  folders: { name: string; files: T[] }[];
}

/** Groups a workspace's files for listing, so supporting material does not bury the result. */
export function groupFiles<T extends { path: string }>(files: readonly T[]): FileGroups<T> {
  const main = primaryArtifact(files);
  const top: T[] = [];
  const folders = new Map<string, T[]>();
  for (const file of files) {
    const slash = file.path.indexOf("/");
    if (slash === -1) top.push(file);
    else {
      const name = file.path.slice(0, slash);
      folders.set(name, [...(folders.get(name) ?? []), file]);
    }
  }
  top.sort((a, b) => Number(b === main) - Number(a === main) || a.path.localeCompare(b.path));
  return {
    top,
    folders: [...folders]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, list]) => ({
        name,
        files: list.sort((a, b) => a.path.localeCompare(b.path)),
      })),
  };
}
