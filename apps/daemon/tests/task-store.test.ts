import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogInvariantError, nextStep } from "@warren/core";
import { type EventDraft, type EventOf, text } from "@warren/protocol";
import {
  type Clock,
  MIGRATIONS,
  MigrationError,
  migrate,
  openDatabase,
  TaskStore,
  UnknownTaskError,
} from "../src/index.ts";

const task: EventOf<"task.created">["data"] = {
  title: "Fix bug",
  instruction: "Fix it",
  grant: { workspace: { kind: "none" }, network: false, privilegedTools: [], budget: {} },
  trigger: { source: "manual" },
};

const model = { provider: "fake", model: "scripted" };
const usage = { inputTokens: 1, outputTokens: 1 };

function tickingClock(start = 1000): Clock {
  let now = start;
  return { now: () => now++ };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "warren-store-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("TaskStore", () => {
  test("survives reopening: the state is rebuilt from the log on disk", () => {
    const path = join(dir, "warren.db");
    const first = openDatabase(path);
    const store = new TaskStore(first, tickingClock());
    store.create("t1", task);
    store.append("t1", [
      {
        type: "model.responded",
        data: {
          model,
          items: [{ type: "tool_call", callId: "c1", name: "shell", arguments: "{}" }],
          stopReason: "tool_calls",
          usage,
          latencyMs: 1,
        },
      },
      { type: "tool.started", data: { callId: "c1", name: "shell", effect: "external" } },
    ]);
    first.close(); // the daemon dies mid-call

    const reopened = new TaskStore(openDatabase(path));
    const state = reopened.get("t1");
    expect(state?.lastSeq).toBe(2);
    expect(state && nextStep(state)).toMatchObject({ kind: "recover_tools" });
  });

  test("an append that breaks the log rolls back entirely", () => {
    const store = new TaskStore(openDatabase(":memory:"), tickingClock());
    store.create("t1", task);
    const good = {
      type: "input.received",
      data: {
        item: { type: "message", role: "user", content: text("more") },
        trigger: { source: "manual" },
      },
    } satisfies EventDraft;
    const bad = {
      type: "tool.finished",
      data: { callId: "ghost", outcome: "ok", content: [] },
    } satisfies EventDraft;

    expect(() => store.append("t1", [good, bad])).toThrow(LogInvariantError);
    expect(store.events("t1")).toHaveLength(1);
    expect(store.get("t1")?.history).toHaveLength(1);
    expect(store.list()[0]?.lastSeq).toBe(0);

    store.append("t1", [good]);
    expect(store.get("t1")?.lastSeq).toBe(1);
  });

  test("rejects data that does not match the event schema", () => {
    const store = new TaskStore(openDatabase(":memory:"));
    store.create("t1", task);
    const malformed = { type: "task.paused", data: { reason: 42 } } as never;
    expect(() => store.append("t1", [malformed])).toThrow();
    expect(store.events("t1")).toHaveLength(1);
  });

  test("lists by status and streams events in global order", () => {
    const store = new TaskStore(openDatabase(":memory:"), tickingClock());
    store.create("a", task);
    store.create("b", task);
    store.append("a", [{ type: "task.ended", data: { outcome: "completed" } }]);

    expect(store.list({ status: ["ended"] }).map((t) => t.id)).toEqual(["a"]);
    expect(store.list({ status: ["active"] }).map((t) => t.id)).toEqual(["b"]);
    expect(store.list().map((t) => t.id)).toEqual(["a", "b"]);

    const all = store.eventsSince(0);
    expect(all.map(({ event }) => `${event.taskId}#${event.seq}`)).toEqual(["a#0", "b#0", "a#1"]);
    const lastId = all[1]?.id ?? 0;
    expect(store.eventsSince(lastId).map(({ event }) => event.type)).toEqual(["task.ended"]);
  });

  test("unknown tasks and duplicate ids are refused", () => {
    const store = new TaskStore(openDatabase(":memory:"));
    expect(store.get("nope")).toBeUndefined();
    expect(() => store.append("nope", [{ type: "task.resumed", data: {} }])).toThrow(
      UnknownTaskError,
    );
    store.create("t1", task);
    expect(() => store.create("t1", task)).toThrow();
  });
});

describe("migrate", () => {
  test("is idempotent and refuses a newer schema", () => {
    const db = new Database(":memory:");
    expect(migrate(db)).toBe(MIGRATIONS.length);
    expect(migrate(db)).toBe(MIGRATIONS.length);
    db.run("PRAGMA user_version = 999");
    expect(() => migrate(db)).toThrow(MigrationError);
  });
});
