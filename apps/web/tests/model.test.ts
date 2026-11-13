import { describe, expect, test } from "bun:test";
import {
  EVENT_VERSIONS,
  type EventDraft,
  type TaskEvent,
  type TaskSummary,
  text,
} from "@warren/protocol";
import { argsPreview, groupTasks, timeline } from "../src/model.ts";

function log(...drafts: EventDraft[]): TaskEvent[] {
  return drafts.map(
    (draft, seq) =>
      ({ ...draft, v: EVENT_VERSIONS[draft.type], taskId: "t", seq, at: seq }) as TaskEvent,
  );
}

const model = { provider: "p", model: "m" };
const usage = { inputTokens: 1, outputTokens: 1 };

describe("timeline", () => {
  test("pairs tool calls with results and hides control tools", () => {
    const entries = timeline(
      log(
        {
          type: "task.created",
          data: {
            title: "T",
            instruction: "Fix it",
            grant: { workspace: { kind: "none" }, network: false, privilegedTools: [], budget: {} },
            trigger: { source: "manual" },
          },
        },
        {
          type: "model.responded",
          data: {
            model,
            usage,
            latencyMs: 1,
            stopReason: "tool_calls",
            items: [
              { type: "message", role: "assistant", content: text("Looking") },
              {
                type: "tool_call",
                callId: "a",
                name: "shell",
                arguments: '{"command":"bun test"}',
              },
              { type: "tool_call", callId: "b", name: "read_file", arguments: '{"path":"x"}' },
            ],
          },
        },
        { type: "tool.started", data: { callId: "a", name: "shell", effect: "write" } },
        { type: "tool.finished", data: { callId: "a", outcome: "ok", content: text("1 pass") } },
        {
          type: "tool.finished",
          data: { callId: "b", outcome: "error", content: text("missing") },
        },
        {
          type: "model.responded",
          data: {
            model,
            usage,
            latencyMs: 1,
            stopReason: "tool_calls",
            items: [{ type: "tool_call", callId: "c", name: "complete_task", arguments: "{}" }],
          },
        },
        {
          type: "tool.finished",
          data: { callId: "c", outcome: "ok", content: text("Task completed.") },
        },
        { type: "task.ended", data: { outcome: "completed", summary: "Fixed" } },
      ),
    );
    expect(entries.map((e) => e.kind)).toEqual([
      "instruction",
      "assistant",
      "tool",
      "tool",
      "notice",
    ]);
    expect(entries[2]).toMatchObject({ name: "shell", status: "ok", output: "1 pass" });
    expect(entries[3]).toMatchObject({ name: "read_file", status: "error", output: "missing" });
    expect(entries[4]).toMatchObject({
      tone: "success",
      notice: { type: "completed", summary: "Fixed" },
    });
  });

  test("shows a call awaiting approval, then the person's decision", () => {
    const base = log(
      {
        type: "task.created",
        data: {
          title: "T",
          instruction: "Open a PR",
          grant: { workspace: { kind: "none" }, network: false, privilegedTools: [], budget: {} },
          trigger: { source: "manual" },
        },
      },
      {
        type: "model.responded",
        data: {
          model,
          usage,
          latencyMs: 1,
          stopReason: "tool_calls",
          items: [{ type: "tool_call", callId: "p", name: "open_pull_request", arguments: "{}" }],
        },
      },
      {
        type: "attention.requested",
        data: { attentionId: "a1", kind: "approval", prompt: "Open PR?", callId: "p" },
      },
    );
    const waiting = timeline(base);
    expect(waiting[1]).toMatchObject({ kind: "tool", status: "awaiting approval" });
    expect(waiting[2]).toMatchObject({ kind: "attention", type: "approval", prompt: "Open PR?" });

    const decided = timeline([
      ...base,
      {
        type: "attention.resolved",
        v: 1,
        taskId: "t",
        seq: 3,
        at: 3,
        data: { attentionId: "a1", response: "not yet", approved: false },
      },
    ]);
    expect(decided[2]).toMatchObject({ resolved: { response: "not yet", approved: false } });
    expect(decided[1]).toMatchObject({ status: "pending" });
  });
});

test("groupTasks puts what needs a person first and sorts by recency", () => {
  const task = (id: string, status: TaskSummary["status"], updatedAt: number): TaskSummary => ({
    id,
    title: id,
    status,
    triggerSource: "manual",
    createdAt: 0,
    updatedAt,
    lastSeq: 0,
  });
  const groups = groupTasks([
    task("a", "ended", 5),
    task("b", "waiting", 1),
    task("c", "active", 2),
    task("d", "waiting", 3),
    task("e", "idle", 4),
  ]);
  expect(groups.needsYou.map((t) => t.id)).toEqual(["d", "b"]);
  expect(groups.working.map((t) => t.id)).toEqual(["c"]);
  expect(groups.idle.map((t) => t.id)).toEqual(["e"]);
  expect(groups.ended.map((t) => t.id)).toEqual(["a"]);
});

test("argsPreview shows the most telling argument", () => {
  expect(argsPreview('{"command":"bun test --watch"}')).toBe("bun test --watch");
  expect(argsPreview('{"path":"src/a.ts","offset":3}')).toBe("src/a.ts");
  expect(argsPreview("{broken")).toBe("{broken");
});
