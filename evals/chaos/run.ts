/**
 * Chaos run: kills the real daemon with SIGKILL at random moments until a task finishes, many
 * times over, and checks that no kill ever broke the task or repeated its external action.
 *
 *   bun evals/chaos/run.ts [iterations=50] [seed]
 *
 * Each iteration starts a fresh home, then loops: start a daemon process, wait a random time,
 * SIGKILL it, until the task has ended. Afterwards it checks the scenario's invariants against
 * the database and the fsynced world file.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldEvents } from "@warren/core";
import { type PushWorld, seededRandom } from "@warren/core/testing";
import { parseEvent, type TaskEvent } from "@warren/protocol";

const TASK_ID = "chaos";
const iterations = Number(process.argv[2] ?? 50);
const seed = Number(process.argv[3] ?? Date.now() % 1_000_000);
const random = seededRandom(seed);
const child = join(import.meta.dir, "child.ts");

function readEvents(home: string): TaskEvent[] {
  const file = join(home, "warren.db");
  if (!existsSync(file)) return [];
  const db = new Database(file, { readonly: true });
  try {
    return db
      .query<{ type: string; v: number; seq: number; at: number; data: string }, [string]>(
        "SELECT type, v, seq, at, data FROM events WHERE task_id = ? ORDER BY seq",
      )
      .all(TASK_ID)
      .map((row) => parseEvent({ ...row, taskId: TASK_ID, data: JSON.parse(row.data) }));
  } catch {
    return []; // the schema may not exist yet if a kill landed during the first startup
  } finally {
    db.close();
  }
}

function ended(home: string): boolean {
  return readEvents(home).some((event) => event.type === "task.ended");
}

interface IterationResult {
  kills: number;
  interrupted: number;
  checks: number;
  violations: string[];
}

async function iteration(): Promise<IterationResult> {
  const home = mkdtempSync(join(tmpdir(), "warren-chaos-"));
  let kills = 0;
  try {
    while (!ended(home)) {
      if (kills > 300) throw new Error("no progress after 300 kills");
      const proc = Bun.spawn(["bun", child, home], { stdout: "ignore", stderr: "inherit" });
      // Most kills land inside the run; some during startup, where the stale lock is taken over.
      await Promise.race([Bun.sleep(60 + random() * 240), proc.exited]);
      proc.kill("SIGKILL");
      await proc.exited;
      if (proc.signalCode === "SIGKILL") kills += 1;
    }

    const events = readEvents(home);
    const state = foldEvents(events);
    const world = JSON.parse(readFileSync(join(home, "world.json"), "utf8")) as PushWorld;
    const violations: string[] = [];
    if (state.ended?.outcome !== "completed") violations.push(`ended ${state.ended?.outcome}`);
    if (world.pushes !== 1) violations.push(`pushed ${world.pushes} times`);
    if (world.file !== "v2") violations.push(`file is ${world.file}`);
    return {
      kills,
      interrupted: events.filter(
        (e) => e.type === "tool.finished" && e.data.outcome === "interrupted",
      ).length,
      checks: state.history.filter((i) => i.type === "tool_call" && i.name === "check_remote")
        .length,
      violations,
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const started = Date.now();
let kills = 0;
let interrupted = 0;
let checks = 0;
const failures: string[] = [];
for (let i = 1; i <= iterations; i += 1) {
  const result = await iteration();
  kills += result.kills;
  interrupted += result.interrupted;
  checks += result.checks;
  for (const violation of result.violations) failures.push(`iteration ${i}: ${violation}`);
  process.stdout.write(result.violations.length ? "x" : ".");
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(`

chaos: ${iterations} tasks, ${kills} SIGKILLs, ${seconds}s (seed ${seed})
  external calls cut off mid-flight and recovered as "interrupted": ${interrupted}
  checks the model made before deciding whether to push again:      ${checks}
  invariant violations:                                            ${failures.length}`);
for (const failure of failures) console.log(`  ✗ ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
