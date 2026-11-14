import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelClient } from "@warren/core";
import { reply, ScriptedModel, toolCall } from "@warren/core/testing";
import { type Logger, type RunningDaemon, startDaemon } from "../src/index.ts";

const quiet: Logger = { info() {}, error() {} };
// Local times, so the tests hold in any time zone. 14 November 2026 is a Saturday.
const at = (day: number, hours: number, minutes = 0) =>
  new Date(2026, 10, day, hours, minutes).getTime();

let root: string;
let home: string;
let daemon: RunningDaemon | undefined;
let now: number;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "warren-automations-")));
  home = join(root, "warren");
  mkdirSync(home);
  now = at(14, 8);
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  rmSync(root, { recursive: true, force: true });
});

/** A model that completes every task at once, as often as asked. */
function finishing(): ModelClient {
  return {
    provider: "fake",
    complete: (request) =>
      new ScriptedModel([reply(toolCall("complete_task", { summary: "done" }))]).complete(request),
  };
}

async function start(model: ModelClient = finishing()) {
  daemon = await startDaemon({
    home,
    port: 0,
    models: { resolve: () => ({ client: model, model: "scripted-1" }) },
    clock: { now: () => now },
    logger: quiet,
    sleep: async () => {},
    notify: () => {},
    // Far in the future: the tests drive the runner with tick().
    automationIntervalMs: 3_600_000,
  });
  const d = daemon;
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${d.url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${d.info.token}`, "Content-Type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    // biome-ignore lint/suspicious/noExplicitAny: tests inspect JSON responses loosely
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
}

const morning = {
  name: "Morning report",
  instruction: "Research today's GitHub trending",
  schedule: { kind: "daily", time: "09:00" },
};

describe("automations", () => {
  test("start a task when due, once for runs missed while asleep, and say when next", async () => {
    const call = await start();
    const created = await call("POST", "/automations", morning);
    expect(created.status).toBe(201);
    const id: string = created.body.automation.id;
    expect(created.body.automation.nextRunAt).toBe(at(14, 9));

    expect(daemon?.automations.tick()).toEqual([]);
    now = at(14, 9);
    const [first] = daemon?.automations.tick() ?? [];
    expect(first).toBeDefined();
    await daemon?.scheduler.idle();
    const task = (await call("GET", `/tasks/${first}`)).body.task;
    expect(task).toMatchObject({
      title: "Morning report",
      instruction: morning.instruction,
      trigger: { source: "automation", externalId: `${id}@${at(14, 9)}` },
      status: "ended",
    });
    expect(daemon?.automations.tick()).toEqual([]);

    // Three mornings pass with the computer asleep: one run when it wakes.
    now = at(17, 12);
    expect(daemon?.automations.tick()).toHaveLength(1);
    expect(daemon?.automations.tick()).toEqual([]);
    const listed = (await call("GET", "/automations")).body.automations[0];
    expect(listed.lastRun).toMatchObject({ at: at(17, 9), status: "started" });
    expect(listed.nextRunAt).toBe(at(18, 9));
  });

  test("a run is skipped while the previous one is still going", async () => {
    // A model that thinks until it is interrupted.
    const call = await start({
      provider: "slow",
      complete: (request) =>
        new Promise((_, reject) =>
          request.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    });
    await call("POST", "/automations", morning);
    now = at(14, 9);
    const [running] = daemon?.automations.tick() ?? [];
    now = at(15, 9);
    expect(daemon?.automations.tick()).toEqual([]);
    const listed = (await call("GET", "/automations")).body.automations[0];
    expect(listed.lastRun).toMatchObject({
      at: at(15, 9),
      status: "skipped",
      taskId: running,
      reason: "the previous run is still going",
    });
    // By hand, the overlap is refused rather than skipped.
    expect((await call("POST", `/automations/${listed.id}/run`)).status).toBe(400);
  });

  test("a run with a folder to save to saves its files when it completes", async () => {
    const out = join(root, "Desktop");
    mkdirSync(out);
    const model: ModelClient = {
      provider: "fake",
      complete: (() => {
        const script = new ScriptedModel([
          reply(toolCall("write_file", { path: "report.md", content: "# Trending\n" })),
          reply(toolCall("complete_task", { summary: "Wrote report.md" })),
        ]);
        return (request) => script.complete(request);
      })(),
    };
    const call = await start(model);
    const id = (await call("POST", "/automations", { ...morning, outputDir: out })).body.automation
      .id;
    const { taskId } = (await call("POST", `/automations/${id}/run`)).body;
    await daemon?.scheduler.idle();
    await Bun.sleep(10);
    expect(readFileSync(join(out, "Morning report", "report.md"), "utf8")).toBe("# Trending\n");
    const task = (await call("GET", `/tasks/${taskId}`)).body.task;
    expect(task.exports).toHaveLength(1);
  });

  test("a changed schedule counts from the change; paused ones do not run", async () => {
    const call = await start();
    const id = (await call("POST", "/automations", morning)).body.automation.id;
    now = at(14, 12);
    // Moved to 10:00 at noon: today's 10:00 has passed and is not run.
    const moved = await call("PATCH", `/automations/${id}`, {
      schedule: { kind: "daily", time: "10:00" },
    });
    expect(moved.body.automation.nextRunAt).toBe(at(15, 10));
    expect(daemon?.automations.tick()).toEqual([]);

    const out = join(root, "out");
    mkdirSync(out);
    expect(
      (await call("PATCH", `/automations/${id}`, { outputDir: out })).body.automation.outputDir,
    ).toBe(out);
    // An empty folder clears it.
    expect(
      (await call("PATCH", `/automations/${id}`, { outputDir: "" })).body.automation.outputDir,
    ).toBeUndefined();

    await call("PATCH", `/automations/${id}`, { enabled: false });
    now = at(16, 12);
    expect(daemon?.automations.tick()).toEqual([]);
    expect((await call("GET", "/automations")).body.automations[0].nextRunAt).toBeUndefined();
  });

  test("bad requests are refused clearly; deleting keeps the tasks it started", async () => {
    const call = await start();
    expect(
      (await call("POST", "/automations", { ...morning, schedule: { kind: "daily", time: "9" } }))
        .status,
    ).toBe(400);
    expect((await call("POST", "/automations", { ...morning, outputDir: home })).status).toBe(400);
    expect((await call("POST", "/automations", { ...morning, modelRole: "turbo" })).status).toBe(
      400,
    );
    expect((await call("PATCH", "/automations/nope", { enabled: false })).status).toBe(404);

    const id = (await call("POST", "/automations", morning)).body.automation.id;
    const { taskId } = (await call("POST", `/automations/${id}/run`)).body;
    await daemon?.scheduler.idle();
    expect((await call("DELETE", `/automations/${id}`)).status).toBe(200);
    expect((await call("GET", "/automations")).body.automations).toEqual([]);
    expect((await call("GET", `/tasks/${taskId}`)).status).toBe(200);
    expect(existsSync(join(home, "tasks", taskId))).toBe(true);
  });
});
