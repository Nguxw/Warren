/**
 * Scores a run with the official SWE-bench harness, writes a report, and frees the disk it used.
 *
 *   bun evals/swebench/score.ts <run-dir> [batch-size] [--keep]
 *
 * The harness applies each patch in the instance's official Docker image, runs the hidden tests
 * (FAIL_TO_PASS and PASS_TO_PASS) and decides resolved or not. Images are 2-5 GB each, so they
 * are pulled, used and removed a batch at a time. When the report is written, the task
 * workspaces, their virtual environments and the repository clones are deleted too; the patches,
 * results, report, harness logs and Warren's event logs stay. `--keep` skips that cleanup.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const [dirArg, batchArg] = args.filter((a) => a !== "--keep");
if (!dirArg) throw new Error("usage: bun score.ts <run-dir> [batch-size] [--keep]");
const dir = resolve(dirArg);
const batchSize = Number(batchArg ?? 4);
const runId = `warren-${basename(dir)}`;
const results = JSON.parse(readFileSync(join(dir, "results.json"), "utf8")) as {
  instance_id: string;
  difficulty?: string;
  outcome: string;
  modelCalls?: number;
  costUsd?: number;
  durationMs?: number;
  patchLines?: number;
  compactions?: number;
}[];

const dockerEnv = {
  ...process.env,
  DOCKER_HOST: `unix://${join(homedir(), ".colima/default/docker.sock")}`,
};
const imageOf = (id: string) =>
  `swebench/sweb.eval.x86_64.${id.replace("__", "_1776_").toLowerCase()}:latest`;

async function run(argv: string[], quiet = false): Promise<number> {
  const child = Bun.spawn(argv, {
    cwd: dir,
    env: dockerEnv,
    stdout: quiet ? "ignore" : "inherit",
    stderr: "inherit",
  });
  return child.exited;
}

const resolved = new Set<string>();
const errored = new Set<string>();
const empty = new Set<string>();

/**
 * Pulls a batch's images in parallel. The harness would pull for the host's architecture (arm64
 * here), but the official images are x86_64 only; pulled first with the platform named, they run
 * under emulation. One registry stream is slow, so images download side by side.
 */
async function pullAll(ids: string[]): Promise<void> {
  await Promise.all(
    ids.map(async (id) => {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const code = await run(
          ["docker", "pull", "--platform", "linux/amd64", "-q", imageOf(id)],
          true,
        );
        if (code === 0) return;
      }
      console.error(`could not pull ${imageOf(id)}`);
    }),
  );
}

// Instances of one repository share most image layers, so they are batched together.
const ids = results.map((r) => r.instance_id).sort();
const batches: string[][] = [];
for (let i = 0; i < ids.length; i += batchSize) batches.push(ids.slice(i, i + batchSize));

// The next batch downloads while the current one is evaluated.
let pulling = batches[0] ? pullAll(batches[0]) : Promise.resolve();
for (const [n, batch] of batches.entries()) {
  await pulling;
  const following = batches[n + 1];
  pulling = following ? pullAll(following) : Promise.resolve();
  console.log(`batch ${n + 1}/${batches.length}: ${batch.join(" ")}`);
  const code = await run([
    "uv",
    "run",
    "--python",
    "3.11",
    "--with",
    "swebench",
    "python",
    "-m",
    "swebench.harness.run_evaluation",
    "--dataset_name",
    "SWE-bench/SWE-bench_Verified",
    "--predictions_path",
    join(dir, "predictions.jsonl"),
    "--run_id",
    runId,
    "--max_workers",
    String(batchSize),
    "--report_dir",
    dir,
    "--instance_ids",
    ...batch,
  ]);
  const reportFile = readdirSync(dir).find((f) => f.endsWith(`.${runId}.json`));
  if (code === 0 && reportFile) {
    const report = JSON.parse(readFileSync(join(dir, reportFile), "utf8")) as {
      resolved_ids: string[];
      error_ids?: string[];
      empty_patch_ids?: string[];
    };
    for (const id of report.resolved_ids) if (batch.includes(id)) resolved.add(id);
    for (const id of report.error_ids ?? []) if (batch.includes(id)) errored.add(id);
    for (const id of report.empty_patch_ids ?? []) if (batch.includes(id)) empty.add(id);
    // Each call rewrites the report for its own batch; keep a copy per batch.
    writeFileSync(join(dir, `harness-batch-${n + 1}.json`), JSON.stringify(report, null, 2));
  } else {
    // The batch counts as harness errors; the other batches still run.
    console.error(`the SWE-bench harness failed on batch ${n + 1}`);
    for (const id of batch) errored.add(id);
  }

  // Free this batch's images; layers the next batch shares stay.
  await run(["docker", "rmi", "-f", ...batch.map(imageOf)], true);
  await run(["docker", "image", "prune", "-f"], true);
}

const sum = (f: (r: (typeof results)[number]) => number) => results.reduce((a, r) => a + f(r), 0);
const median = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
};
const verdict = (id: string) =>
  resolved.has(id)
    ? "resolved"
    : empty.has(id)
      ? "empty patch"
      : errored.has(id)
        ? "harness error"
        : "not resolved";

const lines = [
  `# SWE-bench Verified: ${basename(dir)}`,
  "",
  `Resolved **${resolved.size} / ${results.length}** (${Math.round((resolved.size / results.length) * 100)}%) with Warren on gpt-6.1-terra, scored by the official harness (run id \`${runId}\`; ${errored.size} harness errors).`,
  "",
  `Total cost $${sum((r) => r.costUsd ?? 0).toFixed(2)} · median $${median(results.map((r) => r.costUsd ?? 0)).toFixed(3)} and ${(median(results.map((r) => r.durationMs ?? 0)) / 60_000).toFixed(1)} min per instance · ${sum((r) => r.compactions ?? 0)} compactions.`,
  "",
  "| Instance | Difficulty | Verdict | Task outcome | Calls | Cost | Minutes | Changed lines |",
  "|---|---|---|---|---|---|---|---|",
  ...results.map(
    (r) =>
      `| ${r.instance_id} | ${r.difficulty ?? ""} | ${verdict(r.instance_id)} | ${r.outcome} | ${r.modelCalls ?? ""} | $${(r.costUsd ?? 0).toFixed(3)} | ${((r.durationMs ?? 0) / 60_000).toFixed(1)} | ${r.patchLines ?? ""} |`,
  ),
  "",
];
writeFileSync(join(dir, "REPORT.md"), lines.join("\n"));
console.log(lines.join("\n"));

if (!keep && existsSync(join(dir, "REPORT.md"))) {
  // The report is written: workspaces, virtual environments and clones are no longer needed.
  for (const path of [join(dir, "home", "tasks"), join(dir, "src")]) {
    rmSync(path, { recursive: true, force: true });
  }
  console.log("removed task workspaces, repository clones and Docker images for this run");
}
