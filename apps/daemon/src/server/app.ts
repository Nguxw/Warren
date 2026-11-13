import { existsSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { LogInvariantError, statusOf, type TaskState } from "@warren/core";
import {
  CreateTaskRequest,
  ResolveAttentionRequest,
  SendInputRequest,
  TaskStatus,
} from "@warren/protocol";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Config } from "../config/config.ts";
import type { WorkspaceDiff } from "../runtime/diff.ts";
import type { Scheduler } from "../runtime/scheduler.ts";
import { type TaskStore, UnknownTaskError } from "../store/task-store.ts";
import type { Notifier } from "./notifier.ts";

export interface AppDeps {
  store: TaskStore;
  scheduler: Scheduler;
  notifier: Notifier;
  config: Config;
  token: string;
  /** Which secrets the daemon has, by name; never their values. */
  secrets: Record<string, boolean>;
  sandbox: string;
  newId(): string;
  /** Interval for keep-alive comments on idle streams. */
  heartbeatMs?: number;
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
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  });

  app.get("/health", (c) =>
    c.json({ ok: true, pid: process.pid, secrets: deps.secrets, sandbox: deps.sandbox }),
  );

  app.post("/tasks", async (c) => {
    const body = CreateTaskRequest.parse(await c.req.json());
    const modelRole = body.modelRole ?? "main";
    if (!config.models[modelRole]) {
      throw new HTTPException(400, {
        message: `unknown model role "${modelRole}"; configured: ${Object.keys(config.models).join(", ")}`,
      });
    }
    let workspace: { kind: "none" } | { kind: "clone"; source: string } = { kind: "none" };
    if (body.repo) {
      const source = resolve(body.repo);
      if (!existsSync(join(source, ".git")) || !statSync(source).isDirectory()) {
        throw new HTTPException(400, { message: `${source} is not a git repository` });
      }
      workspace = { kind: "clone", source };
    }
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
      const source = workspace?.kind === "clone" ? workspace.source : undefined;
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

  app.get("/events/cursor", (c) => c.json({ id: store.latestEventId() }));

  app.get("/tasks/:id", (c) => c.json({ task: view(load(c)) }));

  app.get("/tasks/:id/diff", async (c) => {
    const state = load(c);
    const diff = await deps.diff?.(state);
    if (!diff) throw new HTTPException(404, { message: "this task has no repository workspace" });
    return c.json({ diff });
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
