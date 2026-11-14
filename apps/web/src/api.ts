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

export interface ArtifactFile {
  path: string;
  size: number;
  modifiedAt: number;
}

export interface ArtifactList {
  root: string;
  files: ArtifactFile[];
  truncated: boolean;
}

export type ArtifactContent =
  | { kind: "text"; path: string; size: number; text: string; truncated: boolean }
  | { kind: "image"; path: string; size: number; mime: string; base64: string }
  | { kind: "binary"; path: string; size: number };

export type Provider = "openai-responses" | "anthropic" | "openai-compatible";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ModelSettings {
  provider: Provider;
  model: string;
  baseUrl?: string;
  reasoningEffort?: ReasoningEffort;
  maxOutputTokens?: number;
  contextWindow?: number;
  price?: { input: number; cachedInput?: number; output: number };
  apiKeySecret?: string;
}

export interface SecretInfo {
  name: string;
  set: boolean;
  masked?: string;
  fromEnv: boolean;
  usedBy: string[];
}

export interface Settings {
  models: Record<string, ModelSettings>;
  concurrency: number;
  notifications: boolean;
  tasks: { network: boolean };
  approvals: Record<string, "required" | "auto">;
  secrets: SecretInfo[];
  sandbox: string;
  paths: { home: string; config: string; credentials: string };
}

export type SettingsPatch = Partial<
  Pick<Settings, "models" | "concurrency" | "notifications" | "tasks" | "approvals">
>;

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
  files: (id: string) => request<ArtifactList>("GET", `/tasks/${id}/files`),
  file: (id: string, path: string) =>
    request<{ file: ArtifactContent }>(
      "GET",
      `/tasks/${id}/files/content?path=${encodeURIComponent(path)}`,
    ).then((r) => r.file),
  reveal: (id: string, path?: string) =>
    request<{ ok: true }>("POST", `/tasks/${id}/reveal`, path ? { path } : {}),
  settings: () => request<{ settings: Settings }>("GET", "/settings").then((r) => r.settings),
  updateSettings: (patch: SettingsPatch) =>
    request<{ settings: Settings }>("PATCH", "/settings", patch).then((r) => r.settings),
  setSecret: (name: string, value: string) =>
    request<{ settings: Settings }>("PUT", `/secrets/${name}`, { value }).then((r) => r.settings),
  deleteSecret: (name: string) =>
    request<{ settings: Settings }>("DELETE", `/secrets/${name}`).then((r) => r.settings),
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
