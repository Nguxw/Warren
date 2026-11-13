import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { ModelResolver, Tool } from "@warren/core";
import { DaemonInfo } from "@warren/protocol";
import { builtinTools } from "@warren/tools";
import { loadConfig } from "./config/config.ts";
import { loadSecrets } from "./config/secrets.ts";
import { warrenPaths } from "./paths.ts";
import { modelResolver, providerClients, secretStatus } from "./runtime/models.ts";
import { type Logger, Scheduler, stderrLogger } from "./runtime/scheduler.ts";
import { Workspaces } from "./runtime/workspace.ts";
import { createApp } from "./server/app.ts";
import { Notifier } from "./server/notifier.ts";
import { openDatabase } from "./store/database.ts";
import { type Clock, systemClock, TaskStore } from "./store/task-store.ts";

export interface DaemonOptions {
  /** Defaults to WARREN_HOME or ~/.warren. */
  home?: string;
  /** 0 picks a free port. Defaults to the config's port. */
  port?: number;
  /** Test seams: replace the configured models, the built-in tools or the clock. */
  models?: ModelResolver;
  tools?: Tool[];
  clock?: Clock;
  logger?: Logger;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  heartbeatMs?: number;
}

export interface RunningDaemon {
  info: DaemonInfo;
  url: string;
  store: TaskStore;
  scheduler: Scheduler;
  stop(): Promise<void>;
}

/**
 * The composition root: builds every part, starts serving, and resumes interrupted tasks.
 * It holds no domain rules of its own.
 */
export async function startDaemon(options: DaemonOptions = {}): Promise<RunningDaemon> {
  const paths = warrenPaths(options.home);
  const logger = options.logger ?? stderrLogger;
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  mkdirSync(paths.tasks, { recursive: true });
  claimLock(paths.daemonInfo);

  const config = loadConfig(paths.config);
  const secrets = loadSecrets({ file: paths.credentials });
  const db = openDatabase(paths.database);
  const notifier = new Notifier();
  const store = new TaskStore(db, options.clock ?? systemClock, () => notifier.notify());
  const workspaces = new Workspaces(paths.tasks);
  const scheduler = new Scheduler({
    store,
    workspaces,
    concurrency: config.concurrency,
    logger,
    loop: {
      models: options.models ?? modelResolver(config.models, providerClients(secrets)),
      tools: options.tools ?? builtinTools(),
      newId: () => Bun.randomUUIDv7(),
      sleep: options.sleep ?? abortableSleep,
    },
  });

  const token = crypto.randomUUID();
  const app = createApp({
    store,
    scheduler,
    notifier,
    config,
    token,
    secrets: secretStatus(config.models, secrets),
    newId: () => Bun.randomUUIDv7(),
    ...(options.heartbeatMs && { heartbeatMs: options.heartbeatMs }),
  });

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: config.server.host,
      port: options.port ?? config.server.port,
      fetch: app.fetch,
      // Streams send a keep-alive every 10 s; idle connections close after 30 s.
      idleTimeout: 30,
    });
  } catch (error) {
    db.close();
    throw error;
  }

  const info: DaemonInfo = {
    pid: process.pid,
    port: server.port ?? 0,
    token,
    startedAt: Date.now(),
  };
  writeFileSync(paths.daemonInfo, JSON.stringify(info, null, 2), { mode: 0o600 });
  chmodSync(paths.daemonInfo, 0o600);

  scheduler.resumeAll();
  logger.info("daemon started", { port: info.port, home: paths.home });

  let stopping: Promise<void> | undefined;
  return {
    info,
    url: `http://${config.server.host}:${info.port}`,
    store,
    scheduler,
    stop() {
      stopping ??= (async () => {
        await scheduler.stop();
        await server.stop(true);
        db.close();
        rmSync(paths.daemonInfo, { force: true });
        logger.info("daemon stopped");
      })();
      return stopping;
    },
  };
}

/** Refuses to start next to a live daemon; a stale file from a crash is taken over. */
function claimLock(file: string): void {
  if (!existsSync(file)) return;
  const parsed = DaemonInfo.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (parsed.success && alive(parsed.data.pid)) {
    throw new Error(`Warren daemon is already running (pid ${parsed.data.pid})`);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
