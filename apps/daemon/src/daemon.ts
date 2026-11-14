import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { ModelResolver, Tool } from "@warren/core";
import { DaemonInfo } from "@warren/protocol";
import {
  builtinTools,
  noSandbox,
  openPullRequestTool,
  publishBranchTool,
  type Sandbox,
  SeatbeltSandbox,
  seatbeltAvailable,
} from "@warren/tools";
import { type Config, loadConfig } from "./config/config.ts";
import { loadSecrets } from "./config/secrets.ts";
import { Settings } from "./config/settings.ts";
import { warrenPaths } from "./paths.ts";
import { workspaceDiff } from "./runtime/diff.ts";
import { GitHubRuntime } from "./runtime/github.ts";
import { Intake } from "./runtime/intake.ts";
import { modelResolver, providerClients, secretStatus } from "./runtime/models.ts";
import { macNotify, type Notify, taskNotifications } from "./runtime/notifications.ts";
import { type Logger, Scheduler, stderrLogger } from "./runtime/scheduler.ts";
import { branchName, Workspaces } from "./runtime/workspace.ts";
import { createApp } from "./server/app.ts";
import { Notifier } from "./server/notifier.ts";
import { openDatabase } from "./store/database.ts";
import { type Clock, systemClock, TaskStore } from "./store/task-store.ts";
import { TriggerStore } from "./store/trigger-store.ts";

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
  /** The web interface, served at `/` (an HTML import, bundled by Bun). */
  ui?: Bun.HTMLBundle;
  /** Desktop notifications; defaults to macOS Notification Center when the config enables it. */
  notify?: Notify;
}

export interface RunningDaemon {
  info: DaemonInfo;
  url: string;
  store: TaskStore;
  scheduler: Scheduler;
  intake: Intake;
  github: GitHubRuntime | undefined;
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
  const sandbox = chooseSandbox(config.sandbox, paths.home, logger);
  const privileged = [
    publishBranchTool({ branchOf: branchName }),
    openPullRequestTool({ branchOf: branchName, token: () => secrets.WARREN_GITHUB_TOKEN }),
  ];
  const defaultApprovals = Object.fromEntries(
    privileged.map((tool) => [tool.name, tool.approval ?? "auto"] as const),
  );
  const tools = options.tools ?? [
    ...builtinTools(sandbox),
    // The rule is looked up per call, so a change in the settings applies to the next call.
    ...privileged.map((tool) =>
      Object.defineProperty({ ...tool }, "approval", {
        enumerable: true,
        get: () => config.approvals[tool.name] ?? tool.approval,
      }),
    ),
  ];
  const notifier = new Notifier();
  const taskNotify = taskNotifications(
    (id) => store.get(id)?.title,
    options.notify ?? (process.platform === "darwin" ? macNotify : () => {}),
  );
  const notifications: typeof taskNotify = (events) => {
    if (config.notifications) taskNotify(events);
  };
  let github: GitHubRuntime | undefined;
  const store: TaskStore = new TaskStore(db, options.clock ?? systemClock, (events) => {
    notifier.notify();
    notifications(events);
    github?.onCommit(events);
  });
  const triggers = new TriggerStore(db);
  const workspaces = new Workspaces(paths.tasks);
  const scheduler = new Scheduler({
    store,
    workspaces,
    concurrency: config.concurrency,
    logger,
    loop: {
      models: options.models ?? modelResolver(config.models, providerClients(secrets)),
      tools,
      newId: () => Bun.randomUUIDv7(),
      sleep: options.sleep ?? abortableSleep,
    },
  });

  const now = () => (options.clock ?? systemClock).now();
  const intake = new Intake({
    db,
    tasks: store,
    triggers,
    github: () => config.github,
    botLogin: () => github?.login,
    newId: () => Bun.randomUUIDv7(),
    wake: (id) => scheduler.wake(id),
    now,
  });
  if (config.github) {
    github = new GitHubRuntime({
      config: config.github,
      token: secrets.WARREN_GITHUB_TOKEN,
      webhookSecret: secrets.WARREN_GITHUB_WEBHOOK_SECRET,
      intake,
      triggers,
      tasks: store,
      logger,
      now,
    });
  }

  const token = loadToken(paths.token);
  const app = createApp({
    store,
    scheduler,
    notifier,
    config,
    token,
    secrets: () => secretStatus(config.models, secrets),
    settings: new Settings({
      config,
      secrets,
      defaultApprovals,
      paths: { home: paths.home, config: paths.config, credentials: paths.credentials },
      sandbox: sandbox.name,
      env: process.env,
      onConcurrency: (n) => scheduler.setConcurrency(n),
    }),
    workspaceOf: (id) => workspaces.pathOf(id),
    deleteTask: async (id) => {
      await scheduler.release(id);
      db.transaction(() => {
        triggers.forgetTask(id);
        store.delete(id);
      })();
      rmSync(workspaces.dirOf(id), { recursive: true, force: true });
      logger.info("task deleted", { taskId: id });
    },
    baselineOf: (id) => workspaces.baselineOf(id),
    folders: { warrenHome: paths.home },
    ...(process.platform === "darwin" && { pickFolder: chooseFolder }),
    ...(process.platform === "darwin" && { reveal: revealInFinder }),
    sandbox: sandbox.name,
    triggers,
    diff: async (task) => {
      if (task.grant.workspace.kind !== "clone") return undefined;
      const workspace = workspaces.pathOf(task.id);
      if (!existsSync(workspace)) return undefined;
      return workspaceDiff(
        workspace,
        workspaces.scratchOf(task.id),
        sandbox,
        AbortSignal.timeout(60_000),
      );
    },
    newId: () => Bun.randomUUIDv7(),
    ...(options.heartbeatMs && { heartbeatMs: options.heartbeatMs }),
  });

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: config.server.host,
      port: options.port ?? config.server.port,
      ...(options.ui && { routes: { "/": options.ui } }),
      // Serve the bundled interface as built; no hot reload or dev tooling in the daemon.
      development: false,
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
  await github?.start();
  logger.info("daemon started", { port: info.port, home: paths.home });

  let stopping: Promise<void> | undefined;
  return {
    info,
    url: `http://${config.server.host}:${info.port}`,
    store,
    scheduler,
    intake,
    github,
    stop() {
      stopping ??= (async () => {
        await github?.stop();
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

/**
 * The macOS folder chooser. The prompt is an argument to the script, never part of its text, and
 * the script brings its dialog to the front, since the daemon has no window of its own.
 */
async function chooseFolder(prompt: string): Promise<string | undefined> {
  const script = [
    "on run argv",
    "tell me to activate",
    "return POSIX path of (choose folder with prompt (item 1 of argv))",
    "end run",
  ];
  const child = Bun.spawn(
    ["osascript", ...script.flatMap((line) => ["-e", line]), prompt || "Choose a folder"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  // Cancelling is error -128, an ordinary answer.
  if (code !== 0) return undefined;
  return out.trim().replace(/(.)\/$/, "$1");
}

/** `open -R` selects the item in Finder; it never opens or runs it, whatever the model wrote. */
async function revealInFinder(path: string): Promise<void> {
  const child = Bun.spawn(["open", "-R", path], { stdout: "ignore", stderr: "pipe" });
  if ((await child.exited) !== 0) {
    throw new Error(
      `could not reveal ${path}: ${(await new Response(child.stderr).text()).trim()}`,
    );
  }
}

function chooseSandbox(setting: Config["sandbox"], home: string, logger: Logger): Sandbox {
  if (setting === "none") {
    logger.info("sandbox disabled by config: tool commands run with the daemon's rights");
    return noSandbox;
  }
  if (seatbeltAvailable()) return new SeatbeltSandbox({ warrenHome: home });
  if (setting === "seatbelt")
    throw new Error("config requires the Seatbelt sandbox, which is not available here");
  logger.error("no OS sandbox on this platform: tool commands run with the daemon's rights");
  return noSandbox;
}

/**
 * The API token, kept across restarts in `<home>/token` (mode 0600) so a browser or desktop shell
 * stays signed in. Delete the file to rotate it.
 */
function loadToken(file: string): string {
  if (existsSync(file)) {
    const saved = readFileSync(file, "utf8").trim();
    if (saved.length >= 32) return saved;
  }
  const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  writeFileSync(file, token, { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
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
