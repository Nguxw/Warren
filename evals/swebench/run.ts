/**
 * Runs Warren on SWE-bench instances and writes predictions for the official harness.
 *
 *   bun evals/swebench/run.ts <instances.json> <from> <count> <out-dir>
 *
 * Each instance becomes an ordinary Warren task: the repository at its base commit is the
 * workspace, the issue is the instruction, and the same daemon, sandbox and loop do the work as
 * in daily use. No person is present, so questions get "decide yourself" and an idle task is
 * nudged to continue at most twice. The patch is the workspace's change from the base commit,
 * taken inside the task's sandbox, without the files the hidden tests replace.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TaskState } from "@warren/core";
import { loadSecrets, startDaemon, warrenPaths } from "@warren/daemon";
import { runProcess, SeatbeltSandbox } from "@warren/tools";

interface Instance {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  test_patch: string;
  difficulty?: string;
}

const [file, fromArg, countArg, outArg] = process.argv.slice(2);
if (!file || !outArg)
  throw new Error("usage: bun run.ts <instances.json> <from> <count> <out-dir>");
const instances = (JSON.parse(readFileSync(file, "utf8")) as Instance[]).slice(
  Number(fromArg),
  Number(fromArg) + Number(countArg),
);
const out = resolve(outArg);
const home = join(out, "home");
for (const dir of [home, join(out, "src")]) mkdirSync(dir, { recursive: true });

const TIME_LIMIT_MS = 40 * 60_000;
const MODEL_NAME = "warren-gpt-6.1-terra";

writeFileSync(
  join(home, "config.json"),
  JSON.stringify({ notifications: false, concurrency: 4, tasks: { network: true } }, null, 2),
);
// The key comes from the user's own Warren credentials; the eval home gets none on disk.
const key = loadSecrets({ file: warrenPaths().credentials }).WARREN_OPENAI_API_KEY;
if (!key) throw new Error("WARREN_OPENAI_API_KEY is not set");
process.env.WARREN_OPENAI_API_KEY = key;

async function sh(argv: string[], cwd: string): Promise<string> {
  const result = await runProcess(argv, {
    cwd,
    timeoutMs: 30 * 60_000,
    signal: AbortSignal.timeout(30 * 60_000),
  });
  if (result.exitCode !== 0) throw new Error(`${argv.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout;
}

/**
 * The repository at the instance's base commit: only that commit is fetched (depth 1), which is
 * fast and enough for the patch; GitHub drops long transfers often, so each fetch is retried.
 */
async function source(instance: Instance): Promise<string> {
  const dir = join(out, "src", instance.instance_id);
  if (existsSync(join(dir, ".git", "refs", "heads", "swebench"))) return dir;
  for (let attempt = 1; ; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      await sh(["git", "init", "--quiet", dir], out);
      await sh(
        [
          "git",
          "fetch",
          "--quiet",
          "--depth",
          "1",
          `https://github.com/${instance.repo}.git`,
          instance.base_commit,
        ],
        dir,
      );
      await sh(["git", "checkout", "--quiet", "-B", "swebench", "FETCH_HEAD"], dir);
      return dir;
    } catch (error) {
      if (attempt === 3) throw error;
      await Bun.sleep(5000 * attempt);
    }
  }
}

function instruction(instance: Instance): string {
  return `You are resolving a GitHub issue in ${instance.repo}, checked out in your workspace at commit ${instance.base_commit.slice(0, 10)}.

<issue>
${instance.problem_statement.trim()}
</issue>

Make the smallest change to the project's source code that resolves the issue. Hidden tests check the fix:
- Do not rely on changing test files; changes to the tests the evaluation uses are discarded.
- Reproduce the problem first with a throwaway script in $TMPDIR, then verify your fix with it.
- To run code or tests, create a virtual environment in $TMPDIR, never in the workspace, for example:
  uv venv $TMPDIR/venv --python 3.11 && . $TMPDIR/venv/bin/activate && uv pip install -e .
  Pick an older Python if the project needs one.
- No person is available: do not ask questions, decide yourself.
- Do not commit, publish a branch or open a pull request; the evaluation reads your uncommitted changes.
When the fix is in place and verified, call complete_task with a short summary.`;
}

/** Files the instance's test patch touches: the harness replaces them, so the model's edits go. */
function testFiles(patch: string): string[] {
  return [...patch.matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1] as string);
}

const sandbox = new SeatbeltSandbox({ warrenHome: home });

async function patchOf(instance: Instance, workspace: string, scratch: string) {
  const run = (argv: string[]) =>
    runProcess(["git", "-c", "core.fsmonitor=false", ...argv], {
      cwd: workspace,
      timeoutMs: 120_000,
      signal: AbortSignal.timeout(120_000),
      sandbox: { sandbox, policy: { workspace, scratch, network: false } },
    });
  await run(["add", "-A"]);
  const excluded = [
    ...testFiles(instance.test_patch).map((path) => `:(exclude)${path}`),
    ":(exclude,glob)**/*.egg-info/**",
    ":(exclude,glob)**/__pycache__/**",
  ];
  const diff = await run([
    "diff",
    "--cached",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    instance.base_commit,
    "--",
    ".",
    ...excluded,
  ]);
  return diff.stdout;
}

const daemon = await startDaemon({ home, port: 0, logger: { info() {}, error() {} } });
const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const res = await fetch(`${daemon.url}${path}`, {
    method,
    headers: { Authorization: `Bearer ${daemon.info.token}`, "Content-Type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return (await res.json()) as T;
};

interface Running {
  instance: Instance;
  taskId: string;
  started: number;
  nudges: number;
}
const running: Running[] = [];
const results: Record<string, unknown>[] = [];
const predictions: string[] = [];
// Resumable: a task created by an earlier, interrupted run is picked up by its title; the
// daemon has already resumed it from its log.
const existing = new Map(daemon.store.list({ limit: 1000 }).map((t) => [t.title, t]));
for (const instance of instances) {
  const known = existing.get(instance.instance_id);
  if (known) {
    running.push({ instance, taskId: known.id, started: known.createdAt, nudges: 0 });
    console.log(`resumed ${instance.instance_id} → ${known.id.slice(-8)} (${known.status})`);
    continue;
  }
  let repo: string;
  try {
    repo = await source(instance);
  } catch (error) {
    // One repository that cannot be fetched must not stop the others.
    console.log(`error ${instance.instance_id}: ${String(error).slice(0, 200)}`);
    results.push({
      instance_id: instance.instance_id,
      difficulty: instance.difficulty,
      outcome: "setup failed",
    });
    predictions.push(
      JSON.stringify({
        instance_id: instance.instance_id,
        model_name_or_path: MODEL_NAME,
        model_patch: "",
      }),
    );
    continue;
  }
  const { task } = await api<{ task: { id: string } }>("POST", "/tasks", {
    title: instance.instance_id,
    instruction: instruction(instance),
    repo,
    network: true,
    budget: { maxModelCalls: 80 },
  });
  running.push({ instance, taskId: task.id, started: Date.now(), nudges: 0 });
  console.log(`started ${instance.instance_id} → ${task.id.slice(-8)}`);
}

while (running.length > 0) {
  await Bun.sleep(5000);
  for (const item of [...running]) {
    const { task } = await api<{ task: TaskState & { status: string } }>(
      "GET",
      `/tasks/${item.taskId}`,
    );
    if (task.status === "waiting") {
      for (const a of task.attention) {
        await api("POST", `/tasks/${item.taskId}/attention/${a.attentionId}`, {
          response: "No one is available to answer. Decide yourself and continue.",
          ...(a.kind === "approval" && { approved: false }),
        });
      }
      continue;
    }
    const overTime = Date.now() - item.started > TIME_LIMIT_MS;
    if (task.status === "idle" && item.nudges < 2 && !overTime) {
      item.nudges += 1;
      await api("POST", `/tasks/${item.taskId}/input`, {
        text: "Continue until the issue is resolved and verified, then call complete_task.",
      });
      continue;
    }
    if (task.status !== "ended" && task.status !== "idle" && !overTime) continue;
    if (task.status !== "ended") await api("POST", `/tasks/${item.taskId}/cancel`);

    const paths = warrenPaths(home);
    const workspace = join(paths.tasks, item.taskId, "workspace");
    const scratch = join(paths.tasks, item.taskId, "scratch");
    const patch = existsSync(workspace) ? await patchOf(item.instance, workspace, scratch) : "";
    predictions.push(
      JSON.stringify({
        instance_id: item.instance.instance_id,
        model_name_or_path: MODEL_NAME,
        model_patch: patch,
      }),
    );
    const final = daemon.store.get(item.taskId);
    results.push({
      instance_id: item.instance.instance_id,
      difficulty: item.instance.difficulty,
      outcome: final?.ended?.outcome ?? (overTime ? "timeout" : task.status),
      summary: final?.ended?.summary,
      modelCalls: final?.usage.modelCalls,
      costUsd: final?.usage.costUsd,
      inputTokens: final?.usage.inputTokens,
      cachedInputTokens: final?.usage.cachedInputTokens,
      compactions: final?.compactions,
      durationMs: (final?.ended?.at ?? Date.now()) - (final?.createdAt ?? item.started),
      patchLines: patch.split("\n").filter((l: string) => /^[+-][^+-]/.test(l)).length,
    });
    running.splice(running.indexOf(item), 1);
    console.log(
      `done ${item.instance.instance_id}: ${String(results.at(-1)?.outcome)} · ${final?.usage.modelCalls} calls · $${final?.usage.costUsd.toFixed(3)} · ${String(results.at(-1)?.patchLines)} changed lines`,
    );
  }
}

writeFileSync(join(out, "predictions.jsonl"), `${predictions.join("\n")}\n`);
writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));
await daemon.stop();
console.log(`wrote ${predictions.length} predictions to ${join(out, "predictions.jsonl")}`);
