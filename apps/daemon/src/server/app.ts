import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { LogInvariantError, statusOf, type TaskState } from "@warren/core";
import {
  CreateTaskRequest,
  type Grant,
  ResolveAttentionRequest,
  SendInputRequest,
  TaskStatus,
} from "@warren/protocol";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Config } from "../config/config.ts";
import { InvalidSecretError } from "../config/secrets.ts";
import { SecretUpdate, type Settings, SettingsError, SettingsPatch } from "../config/settings.ts";
import {
  ArtifactPathError,
  type Baseline,
  exportArtifacts,
  listArtifacts,
  readArtifact,
  resolveArtifact,
} from "../runtime/artifacts.ts";
import type { WorkspaceDiff } from "../runtime/diff.ts";
import {
  checkCopySize,
  checkFolder,
  exportFolder,
  FolderError,
  type FolderRules,
} from "../runtime/folders.ts";
import type { Scheduler } from "../runtime/scheduler.ts";
import { computeStats } from "../runtime/stats.ts";
import { type TaskStore, UnknownTaskError } from "../store/task-store.ts";
import type { TriggerStore } from "../store/trigger-store.ts";
import type { Notifier } from "./notifier.ts";

export interface AppDeps {
  store: TaskStore;
  scheduler: Scheduler;
  notifier: Notifier;
  config: Config;
  token: string;
  /** Which secrets the configured models need and whether each is set; never their values. */
  secrets(): Record<string, boolean>;
  settings: Settings;
  /** The directory a task works in; its files are what the task produced. */
  workspaceOf(taskId: string): string;
  /** For a copied folder, its files before the task ran. */
  baselineOf(taskId: string): Baseline | undefined;
  /** Which of the person's folders may be copied from or saved to. */
  folders: FolderRules;
  /** Asks the person to pick a folder with the system's dialog; undefined if they cancel. */
  pickFolder?(prompt: string): Promise<string | undefined>;
  /** Shows a file or folder in the system file manager without opening it; absent off macOS. */
  reveal?(path: string): Promise<void>;
  sandbox: string;
  newId(): string;
  /** Interval for keep-alive comments on idle streams. */
  heartbeatMs?: number;
  triggers?: TriggerStore;
  /** What a task changed in its workspace; undefined when it has no repository workspace. */
  diff?(task: TaskState): Promise<WorkspaceDiff | undefined>;
}

const DEFAULT_MAX_MODEL_CALLS = 100;

export function createApp(deps: AppDeps) {
  const { store, scheduler, notifier, config } = deps;
  const heartbeatMs = deps.heartbeatMs ?? 10_000;
  const app = new Hono();

  // Only local names may address the daemon, so a web page cannot reach it through DNS
  // rebinding (its requests would carry the attacker's host name).
  app.use("*", async (c, next) => {
    const host = (c.req.header("host") ?? "").replace(/:\d+$/, "");
    if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) {
      return c.json({ error: "forbidden host" }, 403);
    }
    await next();
  });

  // Every API route needs the token from daemon.json. `?token=` serves EventSource, which cannot
  // set headers.
  app.use("*", async (c, next) => {
    const header = c.req.header("authorization");
    const given = header?.startsWith("Bearer ") ? header.slice(7) : c.req.query("token");
    if (given !== deps.token) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    if (error instanceof UnknownTaskError) return c.json({ error: error.message }, 404);
    if (error instanceof LogInvariantError) return c.json({ error: error.message }, 409);
    if (error instanceof z.ZodError) return c.json({ error: z.prettifyError(error) }, 400);
    if (error instanceof SettingsError || error instanceof InvalidSecretError) {
      return c.json({ error: error.message }, 400);
    }
    if (error instanceof ArtifactPathError) return c.json({ error: error.message }, 404);
    if (error instanceof FolderError) return c.json({ error: error.message }, 400);
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  });

  app.get("/health", (c) =>
    c.json({ ok: true, pid: process.pid, secrets: deps.secrets(), sandbox: deps.sandbox }),
  );

  app.get("/settings", (c) => c.json({ settings: deps.settings.view() }));

  app.patch("/settings", async (c) => {
    const patch = SettingsPatch.parse(await c.req.json());
    return c.json({ settings: deps.settings.update(patch) });
  });

  /** Secrets are write-only: a value goes in, and only whether it is set comes back. */
  app.put("/secrets/:name", async (c) => {
    const { value } = SecretUpdate.parse(await c.req.json());
    return c.json({ settings: deps.settings.setSecret(c.req.param("name"), value) });
  });

  app.delete("/secrets/:name", (c) =>
    c.json({ settings: deps.settings.setSecret(c.req.param("name"), undefined) }),
  );

  app.post("/tasks", async (c) => {
    const body = CreateTaskRequest.parse(await c.req.json());
    const modelRole = body.modelRole ?? "main";
    if (!config.models[modelRole]) {
      throw new HTTPException(400, {
        message: `unknown model role "${modelRole}"; configured: ${Object.keys(config.models).join(", ")}`,
      });
    }
    let workspace: Grant["workspace"] = { kind: "none" };
    if (body.repo) {
      const source = checkFolder(resolve(body.repo), deps.folders);
      // A repository is cloned, so its result comes back as a branch; any other folder is
      // copied, and its result is saved where the person chooses.
      if (existsSync(join(source, ".git"))) workspace = { kind: "clone", source };
      else {
        checkCopySize(source);
        workspace = { kind: "copy", source };
      }
    }
    const outputDir = body.outputDir ? checkFolder(body.outputDir, deps.folders) : undefined;
    const id = deps.newId();
    const state = store.create(id, {
      title: body.title ?? titleOf(body.instruction),
      instruction: body.instruction,
      grant: {
        workspace,
        network: body.network ?? config.tasks.network,
        // With a repository, a task may hand its result back to it and propose it on GitHub.
        privilegedTools: workspace.kind === "clone" ? ["publish_branch", "open_pull_request"] : [],
        budget: { maxModelCalls: DEFAULT_MAX_MODEL_CALLS, ...body.budget },
      },
      trigger: { source: "manual" },
      modelRole,
      ...(outputDir && { outputDir }),
    });
    scheduler.wake(id);
    return c.json({ task: view(state) }, 201);
  });

  app.get("/tasks", (c) => {
    const status = c.req.query("status")?.split(",").filter(Boolean);
    const parsed = status ? z.array(TaskStatus).parse(status) : undefined;
    const limit = Number(c.req.query("limit") ?? 50);
    const tasks = store.list({ ...(parsed && { status: parsed }), limit }).map((task) => {
      const state = store.get(task.id);
      const workspace = state?.grant.workspace;
      const source = workspace && workspace.kind !== "none" ? workspace.source : undefined;
      const repo = source ? { repo: basename(source), repoPath: source } : {};
      const outcome = state?.ended ? { outcome: state.ended.outcome } : {};
      if (task.status !== "waiting") return { ...task, ...repo, ...outcome };
      const attention = (state?.attention ?? []).map(({ attentionId, kind, prompt }) => ({
        attentionId,
        kind,
        prompt,
      }));
      return { ...task, ...repo, attention };
    });
    return c.json({ tasks });
  });

  /** Events from connectors with what routing decided; the record Observe mode is judged by. */
  app.get("/triggers", (c) => {
    const limit = Number(c.req.query("limit") ?? 100);
    return c.json({ triggers: deps.triggers?.list(limit) ?? [] });
  });

  app.get("/stats", (c) => {
    const states = store
      .list({ limit: 100_000 })
      .map((task) => store.get(task.id))
      .filter((state): state is TaskState => Boolean(state));
    return c.json({ stats: computeStats(states, deps.triggers?.list(100_000) ?? []) });
  });

  app.get("/events/cursor", (c) => c.json({ id: store.latestEventId() }));

  app.get("/tasks/:id", (c) => c.json({ task: view(load(c)) }));

  app.get("/tasks/:id/diff", async (c) => {
    const state = load(c);
    const diff = await deps.diff?.(state);
    if (!diff) throw new HTTPException(404, { message: "this task has no repository workspace" });
    return c.json({ diff });
  });

  /**
   * The files in the task's workspace: what it produced. For a copied folder, only what it added
   * or changed; with a repository, the whole clone (the diff shows the changes).
   */
  app.get("/tasks/:id/files", (c) => {
    const id = load(c).id;
    const root = deps.workspaceOf(id);
    if (!existsSync(root)) return c.json({ root, files: [], truncated: false });
    return c.json(listArtifacts(root, deps.baselineOf(id)));
  });

  /**
   * Saves the task's files to a folder of the person's: into a new subfolder named after the
   * task, never over existing files. From a copied folder only what the task added or changed.
   */
  app.post("/tasks/:id/export", async (c) => {
    const state = load(c);
    const body = z.object({ dir: z.string().optional() }).parse(await c.req.json());
    const dir = body.dir ?? state.outputDir;
    if (!dir) throw new HTTPException(400, { message: "no folder to save to" });
    if (state.grant.workspace.kind === "clone") {
      throw new HTTPException(400, { message: "a repository task's result is its branch" });
    }
    const target = checkFolder(dir, deps.folders);
    const root = deps.workspaceOf(state.id);
    if (!existsSync(root)) throw new HTTPException(404, { message: "no workspace yet" });
    const { files } = listArtifacts(root, deps.baselineOf(state.id));
    if (files.length === 0) throw new HTTPException(400, { message: "nothing to save" });
    const destination = exportFolder(target, state.title, `warren-${state.id.slice(-8)}`);
    const copied = exportArtifacts(
      root,
      files.map((f) => f.path),
      destination,
    );
    const next = store.append(state.id, [
      { type: "artifacts.exported", data: { destination, files: copied } },
    ]);
    return c.json({ destination, files: copied, task: view(next) });
  });

  /** Opens the system's folder picker for the interface, which cannot see paths itself. */
  app.post("/pick-folder", async (c) => {
    if (!deps.pickFolder) throw new HTTPException(501, { message: "not supported on this system" });
    const { prompt } = z
      .object({ prompt: z.string().max(200).default("") })
      .parse(await c.req.json());
    // The person may take a while to choose; the request must outlive the idle timeout.
    (c.env as { timeout?(request: Request, seconds: number): void } | undefined)?.timeout?.(
      c.req.raw,
      0,
    );
    return c.json({ path: (await deps.pickFolder(prompt)) ?? null });
  });

  app.get("/tasks/:id/files/content", async (c) => {
    const root = deps.workspaceOf(load(c).id);
    return c.json({ file: await readArtifact(root, c.req.query("path") ?? "") });
  });

  /** Reveals the workspace, one of its files, or the latest save of its files in Finder. */
  app.post("/tasks/:id/reveal", async (c) => {
    const state = load(c);
    const root = deps.workspaceOf(state.id);
    const body = z
      .object({ path: z.string().optional(), saved: z.boolean().optional() })
      .parse(await c.req.json());
    if (!deps.reveal) throw new HTTPException(501, { message: "not supported on this system" });
    if (body.saved) {
      // Only a destination the log says Warren wrote; never a path from the request.
      const saved = state.exports.at(-1)?.destination;
      if (!saved || !existsSync(saved)) throw new HTTPException(404, { message: "not saved" });
      await deps.reveal(saved);
      return c.json({ ok: true });
    }
    if (!existsSync(root)) throw new HTTPException(404, { message: "no workspace yet" });
    await deps.reveal(body.path ? resolveArtifact(root, body.path) : root);
    return c.json({ ok: true });
  });

  app.get("/tasks/:id/events", (c) => {
    const after = Number(c.req.query("after") ?? -1);
    return c.json({ events: store.events(load(c).id, after) });
  });

  /** One task's events after `?after=<seq>` (or Last-Event-ID), then live ones as they commit. */
  app.get("/tasks/:id/stream", (c) => {
    const taskId = load(c).id;
    let after = Number(c.req.header("last-event-id") ?? c.req.query("after") ?? -1);
    return streamSSE(c, async (stream) => {
      let open = true;
      stream.onAbort(() => {
        open = false;
      });
      while (open) {
        const events = store.events(taskId, after);
        for (const event of events) {
          await stream.writeSSE({
            id: String(event.seq),
            event: "task-event",
            data: JSON.stringify(event),
          });
          after = event.seq;
        }
        // Wait only right after an empty read: nothing can commit between it and the wait.
        if (events.length > 0) continue;
        if (!(await notifier.wait(heartbeatMs)) && open) {
          await stream.writeSSE({ event: "ping", data: "" });
        }
      }
    });
  });

  /** Every task's events after a global position; for the UI. */
  app.get("/events", (c) => {
    let after = Number(c.req.header("last-event-id") ?? c.req.query("after") ?? 0);
    return streamSSE(c, async (stream) => {
      let open = true;
      stream.onAbort(() => {
        open = false;
      });
      while (open) {
        const batch = store.eventsSince(after, 500);
        for (const { id, event } of batch) {
          await stream.writeSSE({
            id: String(id),
            event: "task-event",
            data: JSON.stringify(event),
          });
          after = id;
        }
        if (batch.length > 0) continue;
        if (!(await notifier.wait(heartbeatMs)) && open) {
          await stream.writeSSE({ event: "ping", data: "" });
        }
      }
    });
  });

  app.post("/tasks/:id/input", async (c) => {
    const state = load(c);
    const { text } = SendInputRequest.parse(await c.req.json());
    const next = store.append(state.id, [
      {
        type: "input.received",
        data: {
          item: { type: "message", role: "user", content: [{ type: "text", text }] },
          trigger: { source: "manual" },
        },
      },
    ]);
    scheduler.wake(state.id);
    return c.json({ task: view(next) });
  });

  app.post("/tasks/:id/attention/:attentionId", async (c) => {
    const state = load(c);
    const body = ResolveAttentionRequest.parse(await c.req.json());
    const next = store.append(state.id, [
      {
        type: "attention.resolved",
        data: {
          attentionId: c.req.param("attentionId"),
          response: body.response,
          ...(body.approved !== undefined && { approved: body.approved }),
        },
      },
    ]);
    scheduler.wake(state.id);
    return c.json({ task: view(next) });
  });

  app.post("/tasks/:id/pause", (c) => {
    const state = load(c);
    const next = store.append(state.id, [
      { type: "task.paused", data: { reason: "Paused by user" } },
    ]);
    scheduler.interrupt(state.id);
    return c.json({ task: view(next) });
  });

  app.post("/tasks/:id/resume", (c) => {
    const state = load(c);
    const next = store.append(state.id, [{ type: "task.resumed", data: {} }]);
    scheduler.wake(state.id);
    return c.json({ task: view(next) });
  });

  app.post("/tasks/:id/cancel", (c) => {
    const state = load(c);
    const next = store.append(state.id, [
      { type: "task.ended", data: { outcome: "cancelled", summary: "Cancelled by user" } },
    ]);
    scheduler.interrupt(state.id);
    return c.json({ task: view(next) });
  });

  function load(c: Context): TaskState {
    const param = c.req.param("id") ?? "";
    const id = store.resolveId(param);
    const state = id ? store.get(id) : undefined;
    if (!state) throw new UnknownTaskError(`no task ${param}`);
    return state;
  }

  return app;
}

/** A task as the API shows it: its state plus the derived status. */
function view(state: TaskState) {
  return { ...state, status: statusOf(state) };
}

/** The instruction's first line; the repository is shown on its own, not in the title. */
function titleOf(instruction: string): string {
  const line = instruction.split("\n")[0]?.trim() ?? "";
  return line.length > 72 ? `${line.slice(0, 71)}…` : line;
}
