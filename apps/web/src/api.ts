import type { TaskState } from "@warren/core";
import type {
  CreateTaskRequest,
  TaskEvent,
  TaskStatus,
  TaskSummary,
  TriggerRecord,
} from "@warren/protocol";

/**
 * The daemon API from the browser. The page is served by the daemon itself, so requests are
 * same-origin; the token arrives once in the URL fragment (`warren open`), which browsers never
 * send to a server, and is kept in localStorage for this origin only.
 */

const TOKEN_KEY = "warren.token";

export function captureToken(): void {
  const match = /(?:^#|&)token=([^&]+)/.exec(window.location.hash);
  if (match?.[1]) {
    localStorage.setItem(TOKEN_KEY, decodeURIComponent(match[1]));
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }
}

export function token(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export class Unauthorized extends Error {}

export type TaskView = TaskState & { status: TaskStatus };

export interface WorkspaceDiff {
  base?: string;
  files: { path: string; additions: number; deletions: number; status: "modified" | "untracked" }[];
  patch: string;
  truncated: boolean;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${token() ?? ""}`,
      ...(body !== undefined && { "Content-Type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (res.status === 401) throw new Unauthorized("Not signed in");
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

export const api = {
  tasks: () => request<{ tasks: TaskSummary[] }>("GET", "/tasks?limit=200").then((r) => r.tasks),
  task: (id: string) => request<{ task: TaskView }>("GET", `/tasks/${id}`).then((r) => r.task),
  events: (id: string) =>
    request<{ events: TaskEvent[] }>("GET", `/tasks/${id}/events`).then((r) => r.events),
  diff: (id: string) =>
    request<{ diff: WorkspaceDiff }>("GET", `/tasks/${id}/diff`).then((r) => r.diff),
  triggers: () =>
    request<{ triggers: TriggerRecord[] }>("GET", "/triggers?limit=200").then((r) => r.triggers),
  cursor: () => request<{ id: number }>("GET", "/events/cursor").then((r) => r.id),
  health: () =>
    request<{ ok: boolean; sandbox: string; secrets: Record<string, boolean> }>("GET", "/health"),
  create: (body: CreateTaskRequest) =>
    request<{ task: TaskView }>("POST", "/tasks", body).then((r) => r.task),
  send: (id: string, text: string) =>
    request<{ task: TaskView }>("POST", `/tasks/${id}/input`, { text }),
  resolve: (id: string, attentionId: string, response: string, approved?: boolean) =>
    request<{ task: TaskView }>("POST", `/tasks/${id}/attention/${attentionId}`, {
      response,
      ...(approved !== undefined && { approved }),
    }),
  control: (id: string, action: "pause" | "resume" | "cancel") =>
    request<{ task: TaskView }>("POST", `/tasks/${id}/${action}`),
};

/** Every task's events as they commit, from the global position `after`. */
export function subscribe(after: number, onEvent: (event: TaskEvent) => void): () => void {
  const source = new EventSource(
    `/events?after=${after}&token=${encodeURIComponent(token() ?? "")}`,
  );
  source.addEventListener("task-event", (message) => {
    onEvent(JSON.parse((message as MessageEvent<string>).data) as TaskEvent);
  });
  return () => source.close();
}
