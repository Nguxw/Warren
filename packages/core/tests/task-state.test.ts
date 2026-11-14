import { describe, expect, test } from "bun:test";
import { EVENT_VERSIONS, type EventDraft, type TaskEvent, text } from "@warren/protocol";
import {
  applyEvent,
  foldEvents,
  LogInvariantError,
  nextStep,
  statusOf,
  type TaskState,
} from "../src/index.ts";

/** Builds a valid-envelope log from drafts, numbering seq and time from 0. */
function log(...drafts: EventDraft[]): TaskEvent[] {
  return drafts.map(
    (draft, seq) =>
      ({ ...draft, v: EVENT_VERSIONS[draft.type], taskId: "t1", seq, at: seq * 1000 }) as TaskEvent,
  );
}

const created: EventDraft = {
  type: "task.created",
  data: {
    title: "Fix bug",
    instruction: "Fix the bug in parser.ts",
    grant: { workspace: { kind: "none" }, network: false, privilegedTools: [], budget: {} },
    trigger: { source: "manual" },
  },
};

const model = { provider: "fake", model: "scripted" };
const usage = { inputTokens: 100, outputTokens: 20, cachedInputTokens: 50, costUsd: 0.01 };

function respond(...items: Extract<EventDraft, { type: "model.responded" }>["data"]["items"]) {
  const hasCalls = items.some((item) => item.type === "tool_call");
  return {
    type: "model.responded",
    data: { model, items, stopReason: hasCalls ? "tool_calls" : "end_turn", usage, latencyMs: 5 },
  } satisfies EventDraft;
}

const call = (callId: string, name = "read_file") =>
  ({ type: "tool_call", callId, name, arguments: "{}" }) as const;
const say = (value: string) =>
  ({ type: "message", role: "assistant", content: text(value) }) as const;
const started = (callId: string, effect: "read" | "write" | "external" = "read") =>
  ({ type: "tool.started", data: { callId, name: "read_file", effect } }) satisfies EventDraft;
const finished = (callId: string) =>
  ({
    type: "tool.finished",
    data: { callId, outcome: "ok", content: text("ok") },
  }) satisfies EventDraft;
const input = (value: string) =>
  ({
    type: "input.received",
    data: {
      item: { type: "message", role: "user", content: text(value) },
      trigger: { source: "manual" },
    },
  }) satisfies EventDraft;

describe("foldEvents", () => {
  test("a new task starts with its instruction and asks for the model", () => {
    const state = foldEvents(log(created));
    expect(state.history).toEqual([
      { type: "message", role: "user", content: text("Fix the bug in parser.ts") },
    ]);
    expect(nextStep(state)).toEqual({ kind: "call_model" });
    expect(statusOf(state)).toBe("active");
  });

  test("a turn of tool calls runs them in order, then returns to the model", () => {
    const events = log(
      created,
      respond(say("Looking"), call("c1"), call("c2")),
      started("c1"),
      finished("c1"),
    );
    let state = foldEvents(events);
    expect(nextStep(state)).toEqual({ kind: "run_tool", call: call("c2") });

    state = foldEvents(log(...draftsOf(events), started("c2"), finished("c2")));
    expect(nextStep(state)).toEqual({ kind: "call_model" });
    expect(state.history.map((item) => item.type)).toEqual([
      "message",
      "message",
      "tool_call",
      "tool_call",
      "tool_result",
      "tool_result",
    ]);
  });

  test("ending a turn without tool calls leaves the task idle until an input arrives", () => {
    const state = foldEvents(log(created, respond(say("Done, see diff"))));
    expect(nextStep(state)).toEqual({ kind: "idle" });
    expect(statusOf(state)).toBe("idle");

    const woken = foldEvents(log(created, respond(say("Done")), input("Also fix lexer.ts")));
    expect(nextStep(woken)).toEqual({ kind: "call_model" });
  });

  test("inputs during pending tool calls wait until the calls have results", () => {
    const state = foldEvents(
      log(created, respond(call("c1")), input("by the way"), started("c1"), finished("c1")),
    );
    // The tool result must directly follow its call, so the input comes after it.
    expect(state.history.slice(-3).map((item) => item.type)).toEqual([
      "tool_call",
      "tool_result",
      "message",
    ]);
    expect(state.queuedInputs).toEqual([]);
    expect(nextStep(state)).toEqual({ kind: "call_model" });
  });

  test("a call started but never finished is reported for recovery", () => {
    const state = foldEvents(log(created, respond(call("c1")), started("c1", "external")));
    expect(nextStep(state)).toEqual({
      kind: "recover_tools",
      calls: [{ callId: "c1", name: "read_file", effect: "external", startedAt: 2000 }],
    });
  });

  test("open attention makes the task wait for a person", () => {
    const events = log(created, respond(call("c1", "push")), {
      type: "attention.requested",
      data: { attentionId: "a1", kind: "approval", prompt: "Push branch?", callId: "c1" },
    });
    const waiting = foldEvents(events);
    expect(statusOf(waiting)).toBe("waiting");

    const approved = foldEvents(
      log(...draftsOf(events), {
        type: "attention.resolved",
        data: { attentionId: "a1", response: "yes", approved: true },
      }),
    );
    expect(nextStep(approved)).toEqual({ kind: "run_tool", call: call("c1", "push") });
  });

  test("pause, resume and end", () => {
    const paused = foldEvents(log(created, { type: "task.paused", data: { reason: "battery" } }));
    expect(statusOf(paused)).toBe("paused");
    const resumed = foldEvents(
      log(
        created,
        { type: "task.paused", data: { reason: "x" } },
        { type: "task.resumed", data: {} },
      ),
    );
    expect(statusOf(resumed)).toBe("active");
    const ended = foldEvents(log(created, { type: "task.ended", data: { outcome: "cancelled" } }));
    expect(statusOf(ended)).toBe("ended");
  });

  test("saving a finished task's files is recorded after its end, without reopening it", () => {
    const state = foldEvents(
      log(
        { ...created, data: { ...created.data, outputDir: "/Users/me/Reports" } },
        { type: "task.ended", data: { outcome: "completed" } },
        {
          type: "artifacts.exported",
          data: { destination: "/Users/me/Reports/Fix bug", files: 3 },
        },
      ),
    );
    expect(state.outputDir).toBe("/Users/me/Reports");
    expect(state.exports).toEqual([
      { destination: "/Users/me/Reports/Fix bug", files: 3, at: 2000 },
    ]);
    expect(statusOf(state)).toBe("ended");
    expect(state.lastSeq).toBe(2);
  });

  test("usage adds up across responses and a response resets the failure count", () => {
    const state = foldEvents(
      log(
        created,
        { type: "model.failed", data: { model, kind: "retryable", message: "503" } },
        respond(call("c1")),
        finished("c1"),
        respond(say("done")),
      ),
    );
    expect(state.usage).toEqual({
      modelCalls: 2,
      inputTokens: 200,
      outputTokens: 40,
      cachedInputTokens: 100,
      reasoningTokens: 0,
      costUsd: 0.02,
    });
    expect(state.modelFailuresInARow).toBe(0);
  });
});

describe("log invariants", () => {
  const cases: [string, EventDraft[]][] = [
    ["a model response while calls are pending", [respond(call("c1")), respond(say("x"))]],
    ["a result for an unknown call", [finished("nope")]],
    ["starting an unknown call", [started("nope")]],
    ["duplicate call ids in one response", [respond(call("c1"), call("c1"))]],
    ["events after the end", [{ type: "task.ended", data: { outcome: "completed" } }, input("x")]],
    [
      "resolving attention that is not open",
      [{ type: "attention.resolved", data: { attentionId: "a9", response: "" } }],
    ],
    ["a second task.created", [created]],
  ];

  for (const [name, drafts] of cases) {
    test(`rejects ${name}`, () => {
      expect(() => foldEvents(log(created, ...drafts))).toThrow(LogInvariantError);
    });
  }

  test("rejects gaps and foreign events", () => {
    const state: TaskState = foldEvents(log(created));
    const [, next] = log(created, input("x"));
    expect(() => applyEvent(state, { ...next, seq: 5 } as TaskEvent)).toThrow(/expected seq 1/);
    expect(() => applyEvent(state, { ...next, taskId: "t2" } as TaskEvent)).toThrow(/another task/);
    expect(() => foldEvents(log(input("x")))).toThrow(/must start with task.created/);
  });
});

function draftsOf(events: TaskEvent[]): EventDraft[] {
  return events.map(({ type, data }) => ({ type, data }) as EventDraft);
}
