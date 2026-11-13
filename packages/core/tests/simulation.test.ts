import { describe, expect, test } from "bun:test";
import { type NextStep, runTask } from "../src/index.ts";
import {
  Crash,
  CrashingLog,
  MemoryTaskLog,
  newPushWorld,
  type PushWorld,
  pushPolicyModel,
  pushScenarioTools,
  seededRandom,
  testDeps,
  testTask,
} from "../src/testing/index.ts";

/**
 * Crash-injection simulation.
 *
 * A task reads a file, rewrites it, pushes (an external action) and completes. The process is
 * made to die after every durable step in turn, including between the push and the event that
 * records it, and then restarted on the same log. Whatever the crash points, the task must end
 * completed, the file must be rewritten, and the push must have happened exactly once.
 *
 * Exactly once needs both halves of the design: the loop never re-runs an external call cut off
 * by a crash (at most once), and it tells the model the outcome is unknown, so a model that
 * checks before retrying pushes when the first attempt never happened (at least once).
 */

interface Outcome {
  world: PushWorld;
  memory: MemoryTaskLog;
  step: NextStep;
  lifetimes: number;
  steps: number;
}

/** Runs the task across process lifetimes; lifetime i dies after `crashPoints[i]` steps. */
async function simulate(crashPoints: readonly number[]): Promise<Outcome> {
  const world = newPushWorld();
  const memory = new MemoryTaskLog();
  memory.create("t1", testTask);
  const current = { log: new CrashingLog(memory) };
  // The process may die after an effect, before its result is recorded.
  const tools = pushScenarioTools(world, () => current.log.step());
  const never = new AbortController().signal;

  for (let lifetime = 0; lifetime < 20; lifetime += 1) {
    current.log = new CrashingLog(memory, crashPoints[lifetime]);
    try {
      const deps = { ...testDeps({ model: pushPolicyModel(), tools }), log: current.log };
      const step = await runTask("t1", deps, never);
      return { world, memory, step, lifetimes: lifetime + 1, steps: current.log.steps };
    } catch (error) {
      if (!(error instanceof Crash)) throw error;
    }
  }
  throw new Error("the task made no progress across 20 restarts");
}

function expectInvariants(outcome: Outcome, label: string) {
  const state = outcome.memory.get("t1");
  expect({ label, step: outcome.step.kind }).toEqual({ label, step: "ended" });
  expect({ label, outcome: state?.ended?.outcome }).toEqual({ label, outcome: "completed" });
  expect({ label, file: outcome.world.file }).toEqual({ label, file: "v2" });
  expect({ label, pushes: outcome.world.pushes }).toEqual({ label, pushes: 1 });
}

function usedCheck(outcome: Outcome): boolean {
  return outcome.memory
    .events("t1")
    .some(
      (event) =>
        event.type === "model.responded" &&
        event.data.items.some((item) => item.type === "tool_call" && item.name === "check_remote"),
    );
}

describe("crash-injection simulation", () => {
  test("a run without crashes pushes once and completes", async () => {
    const clean = await simulate([]);
    expectInvariants(clean, "no crash");
    expect(usedCheck(clean)).toBe(false);
  });

  test("a crash after any single durable step still pushes exactly once", async () => {
    const total = (await simulate([])).steps;
    expect(total).toBeGreaterThan(8);
    let checked = 0;
    for (let crashAt = 1; crashAt <= total; crashAt += 1) {
      const outcome = await simulate([crashAt]);
      expectInvariants(outcome, `crash after step ${crashAt}`);
      expect(outcome.lifetimes).toBe(2);
      if (usedCheck(outcome)) checked += 1;
    }
    // Two crash points fall around the push: before it ran, and after it ran but before the
    // result was recorded. Both must go through the check.
    expect(checked).toBe(2);
  });

  test("random sequences of up to four crashes keep every invariant", async () => {
    const total = (await simulate([])).steps;
    const random = seededRandom(20261113);
    const runs = 500;
    let crashes = 0;
    for (let run = 0; run < runs; run += 1) {
      const count = 1 + Math.floor(random() * 4);
      const points = Array.from({ length: count }, () => 1 + Math.floor(random() * (total + 2)));
      const outcome = await simulate(points);
      expectInvariants(outcome, `run ${run}: crashes at ${points.join(",")}`);
      crashes += outcome.lifetimes - 1;
    }
    expect(crashes).toBeGreaterThan(runs);
  });
});
