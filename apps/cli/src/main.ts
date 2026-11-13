#!/usr/bin/env bun
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  loadConfig,
  loadSecrets,
  maskSecret,
  secretStatus,
  startDaemon,
  warrenPaths,
} from "@warren/daemon";
import type { TaskEvent, TaskSummary, TriggerRecord } from "@warren/protocol";
import { seatbeltAvailable } from "@warren/tools";
import ui from "@warren/web/index.html";
import { CliError, DaemonClient } from "./client.ts";
import {
  bold,
  dim,
  green,
  red,
  renderEvent,
  renderTask,
  renderTrigger,
  renderUsage,
  shortId,
  yellow,
} from "./render.ts";
import { installService, plistPath, serviceStatus, uninstallService } from "./service.ts";

const HELP = `warren — a local, long-running agent

Usage:
  warren daemon                      Run the daemon in the foreground
  warren open                        Open the web interface
  warren service install|uninstall|status
                                     Run the daemon at login with launchd
  warren run <instruction…>          Start a task and follow it
      --repo <path>                    Work in a clone of this git repository
      --title <text>                   Task title
      --model <role>                   Model role from the config (default: main)
      --max-calls <n>                  Model call budget (default: 100)
      --network                        Let the task's commands reach the network
      --detach                         Do not follow the task
  warren tasks [--all]               List tasks (default: not ended)
  warren show <id>                   Print a task's whole history
  warren follow <id>                 Follow a task until it needs you or stops
  warren send <id> <text…>           Send a message to a task and follow it
  warren answer <id> <text…>         Answer the task's open question and follow it
  warren approve <id>                Approve the action the task is waiting on
  warren deny <id> [reason…]         Decline it; the reason goes to the task
  warren pause|resume|cancel <id>    Control a task
  warren triggers [--limit n]        Events from GitHub and what Warren decided
  warren doctor                      Check the setup

Ids can be shortened to the 8 characters \`warren tasks\` shows.`;

interface TaskView {
  id: string;
  status: TaskSummary["status"];
  lastSeq: number;
  attention: { attentionId: string; kind: "question" | "approval"; prompt: string }[];
  ended?: { outcome: "completed" | "failed" | "cancelled" };
  usage: Parameters<typeof renderUsage>[0];
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "daemon":
      return daemon();
    case "open":
      return open();
    case "service":
      return service(rest);
    case "run":
      return run(rest);
    case "tasks":
      return tasks(rest);
    case "show":
      return show(rest);
    case "follow":
      return follow(client(), one(rest, "follow"), -1);
    case "send":
      return send(rest);
    case "answer":
      return answer(rest);
    case "approve":
      return decide(rest, true);
    case "deny":
      return decide(rest, false);
    case "pause":
    case "resume":
    case "cancel":
      return control(command, rest);
    case "doctor":
      return doctor();
    case "triggers":
      return triggers(rest);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;
    default:
      throw new CliError(`unknown command "${command}"\n\n${HELP}`);
  }
}

function client(): DaemonClient {
  return DaemonClient.connect();
}

function one(args: string[], command: string): string {
  const [id] = args;
  if (!id) throw new CliError(`usage: warren ${command} <id>`);
  return id;
}

async function daemon(): Promise<number> {
  const running = await startDaemon({ ui });
  console.error(
    `${bold("Warren daemon")} listening on ${running.url} ${dim(`(${warrenPaths().home})`)}`,
  );
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  console.error(dim("stopping…"));
  await running.stop();
  return 0;
}

async function open(): Promise<number> {
  const api = client();
  await api.request("GET", "/health");
  // The token travels in the fragment, which browsers never send to the server.
  const url = `${api.baseUrl}/#token=${encodeURIComponent(api.token)}`;
  if (process.platform === "darwin") Bun.spawnSync(["/usr/bin/open", url]);
  else console.log(url);
  console.log(`Opened ${api.baseUrl}`);
  return 0;
}

async function service(args: string[]): Promise<number> {
  const [action] = args;
  switch (action) {
    case "install": {
      const file = installService();
      console.log(`${green("✓")} installed ${file}`);
      const log = join(warrenPaths().logs, "daemon.log");
      console.log(dim(`  The daemon now starts at login and restarts if it exits. Logs: ${log}`));
      return 0;
    }
    case "uninstall":
      console.log(uninstallService() ? `${green("✓")} removed ${plistPath()}` : "not installed");
      return 0;
    case "status": {
      const status = serviceStatus();
      console.log(
        status.running
          ? `${green("running")} (pid ${status.pid})`
          : status.installed
            ? yellow("installed, not running")
            : "not installed",
      );
      return status.running ? 0 : 1;
    }
    default:
      throw new CliError("usage: warren service install|uninstall|status");
  }
}

async function run(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      title: { type: "string" },
      model: { type: "string" },
      "max-calls": { type: "string" },
      network: { type: "boolean" },
      detach: { type: "boolean" },
    },
  });
  const instruction = positionals.join(" ").trim();
  if (!instruction) throw new CliError('usage: warren run "<instruction>" [--repo <path>]');
  const maxCalls = values["max-calls"] ? Number(values["max-calls"]) : undefined;
  const api = client();
  const { task } = await api.request<{ task: TaskView }>("POST", "/tasks", {
    instruction,
    ...(values.repo && { repo: values.repo }),
    ...(values.title && { title: values.title }),
    ...(values.model && { modelRole: values.model }),
    ...(maxCalls && { budget: { maxModelCalls: maxCalls } }),
    ...(values.network && { network: true }),
  });
  if (values.detach) {
    console.log(shortId(task.id));
    return 0;
  }
  return follow(api, task.id, -1);
}

async function tasks(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { all: { type: "boolean" } } });
  const query = values.all ? "" : "?status=active,waiting,idle,paused";
  const { tasks: list } = await client().request<{ tasks: TaskSummary[] }>("GET", `/tasks${query}`);
  if (list.length === 0) {
    console.log(
      dim(values.all ? "No tasks yet." : "No open tasks. (warren tasks --all shows ended ones)"),
    );
    return 0;
  }
  for (const task of list) console.log(renderTask(task));
  return 0;
}

async function show(args: string[]): Promise<number> {
  const api = client();
  const id = one(args, "show");
  const { events } = await api.request<{ events: TaskEvent[] }>("GET", `/tasks/${id}/events`);
  for (const event of events) print(event);
  const { task } = await api.request<{ task: TaskView }>("GET", `/tasks/${id}`);
  console.log(`${dim(`status: ${task.status}`)}\n${renderUsage(task.usage)}`);
  return 0;
}

async function send(args: string[]): Promise<number> {
  const [id, ...words] = args;
  if (!id || words.length === 0) throw new CliError('usage: warren send <id> "<message>"');
  const api = client();
  const { task } = await api.request<{ task: TaskView }>("POST", `/tasks/${id}/input`, {
    text: words.join(" "),
  });
  return follow(api, task.id, task.lastSeq);
}

async function answer(args: string[]): Promise<number> {
  const [id, ...words] = args;
  if (!id || words.length === 0) throw new CliError('usage: warren answer <id> "<answer>"');
  const api = client();
  const { task } = await api.request<{ task: TaskView }>("GET", `/tasks/${id}`);
  const open = task.attention.find((a) => a.kind === "question");
  if (!open) throw new CliError("this task has no open question");
  const { task: next } = await api.request<{ task: TaskView }>(
    "POST",
    `/tasks/${task.id}/attention/${open.attentionId}`,
    { response: words.join(" ") },
  );
  return follow(api, next.id, next.lastSeq);
}

async function decide(args: string[], approved: boolean): Promise<number> {
  const [id, ...words] = args;
  if (!id) throw new CliError(`usage: warren ${approved ? "approve" : "deny"} <id>`);
  const api = client();
  const { task } = await api.request<{ task: TaskView }>("GET", `/tasks/${id}`);
  const open = task.attention.find((a) => a.kind === "approval");
  if (!open) throw new CliError("this task is not waiting for an approval");
  const { task: next } = await api.request<{ task: TaskView }>(
    "POST",
    `/tasks/${task.id}/attention/${open.attentionId}`,
    { response: words.join(" "), approved },
  );
  return follow(api, next.id, next.lastSeq);
}

async function control(action: "pause" | "resume" | "cancel", args: string[]): Promise<number> {
  const api = client();
  const { task } = await api.request<{ task: TaskView }>(
    "POST",
    `/tasks/${one(args, action)}/${action}`,
  );
  console.log(`${shortId(task.id)} ${task.status}`);
  return 0;
}

/** Prints events until the task stops, waits for a person, or the user presses Ctrl-C. */
async function follow(api: DaemonClient, id: string, afterSeq: number): Promise<number> {
  const controller = new AbortController();
  let detached = false;
  process.once("SIGINT", () => {
    detached = true;
    controller.abort();
  });
  let taskId = id;
  for await (const event of api.stream(id, afterSeq, controller.signal)) {
    taskId = event.taskId;
    print(event);
    if (!mayStop(event)) continue;
    const { task } = await api.request<{ task: TaskView }>("GET", `/tasks/${taskId}`);
    if (task.status === "active") continue;
    controller.abort();
    console.log(renderUsage(task.usage));
    if (task.status === "idle") {
      console.log(dim(`  reply with: warren send ${shortId(taskId)} "<message>"`));
    }
    return task.ended?.outcome === "failed" ? 1 : 0;
  }
  if (detached) {
    console.log(
      dim(`\nThe task keeps running. Follow again with: warren follow ${shortId(taskId)}`),
    );
  }
  return 0;
}

function mayStop(event: TaskEvent): boolean {
  return (
    event.type === "task.ended" ||
    event.type === "task.paused" ||
    event.type === "attention.requested" ||
    (event.type === "model.responded" && !event.data.items.some((i) => i.type === "tool_call"))
  );
}

function print(event: TaskEvent): void {
  const text = renderEvent(event);
  if (text) console.log(text);
}

async function triggers(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { limit: { type: "string" } } });
  const { triggers: list } = await client().request<{ triggers: TriggerRecord[] }>(
    "GET",
    `/triggers?limit=${Number(values.limit ?? 30)}`,
  );
  if (list.length === 0) {
    console.log(dim("No events yet. Configure github in ~/.warren/config.json (see docs/007)."));
    return 0;
  }
  for (const record of list) console.log(renderTrigger(record));
  return 0;
}

async function doctor(): Promise<number> {
  const paths = warrenPaths();
  let ok = true;
  const check = (pass: boolean, label: string, detail = "") => {
    ok &&= pass;
    console.log(`${pass ? green("✓") : red("✗")} ${label}${detail ? dim(`  ${detail}`) : ""}`);
  };

  console.log(dim(`home: ${paths.home}`));
  // A running daemon is the authority on which secrets are loaded: it may have them from its
  // own environment rather than the credentials file.
  let health: { secrets?: Record<string, boolean>; sandbox?: string } | undefined;
  let daemonError = "";
  try {
    health = await client().request("GET", "/health");
  } catch (error) {
    daemonError = error instanceof Error ? error.message : String(error);
  }
  check(Boolean(health), "daemon running", daemonError);

  let config: ReturnType<typeof loadConfig> | undefined;
  try {
    config = loadConfig(paths.config);
    const roles = Object.entries(config.models).map(([role, m]) => `${role}=${m.model}`);
    check(true, "config", roles.join("  "));
  } catch (error) {
    check(false, "config", error instanceof Error ? error.message : String(error));
  }
  // A running daemon knows which secrets it loaded; otherwise look at what this process sees.
  const local = loadSecrets({ file: paths.credentials });
  const needed = health?.secrets ?? (config ? secretStatus(config.models, local) : {});
  for (const [name, loaded] of Object.entries(needed)) {
    const detail = loaded
      ? health
        ? "loaded by the daemon"
        : maskSecret(local[name] ?? "")
      : `set it in ${paths.credentials}`;
    check(loaded, name, detail);
  }
  const sandbox = health?.sandbox ?? (seatbeltAvailable() ? "seatbelt" : "none");
  check(sandbox !== "none", "sandbox", sandbox === "none" ? "commands run unconfined" : sandbox);
  const github = local.WARREN_GITHUB_TOKEN;
  console.log(
    `${github ? green("✓") : yellow("–")} WARREN_GITHUB_TOKEN${dim(
      github ? `  ${maskSecret(github)}` : "  optional; needed to open pull requests",
    )}`,
  );
  check(Boolean(Bun.which("git")), "git");
  console.log(
    `${Bun.which("rg") ? green("✓") : yellow("–")} ripgrep${dim("  optional; search falls back to grep")}`,
  );
  return ok ? 0 : 1;
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      if (error instanceof CliError || isUsageError(error)) {
        console.error(red(error.message));
      } else {
        console.error(error);
      }
      process.exit(1);
    });
}

/** `parseArgs` reports unknown or malformed options as TypeErrors with an ERR_PARSE_ARGS code. */
function isUsageError(error: unknown): error is Error {
  return (
    error instanceof TypeError &&
    String((error as { code?: unknown }).code).startsWith("ERR_PARSE_ARGS")
  );
}

export { main };
