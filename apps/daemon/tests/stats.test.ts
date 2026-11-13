import { expect, test } from "bun:test";
import { foldEvents } from "@warren/core";
import {
  EVENT_VERSIONS,
  type EventDraft,
  type TaskEvent,
  type TriggerRecord,
  text,
} from "@warren/protocol";
import { computeStats } from "../src/index.ts";

function task(id: string, start: number, drafts: EventDraft[]) {
  const all: EventDraft[] = [
    {
      type: "task.created",
      data: {
        title: id,
        instruction: "x",
        grant: { workspace: { kind: "none" }, network: false, privilegedTools: [], budget: {} },
        trigger: { source: "manual" },
      },
    },
    ...drafts,
  ];
  return foldEvents(
    all.map(
      (d, seq) =>
        ({
          ...d,
          v: EVENT_VERSIONS[d.type],
          taskId: id,
          seq,
          at: start + seq * 60_000,
        }) as TaskEvent,
    ),
  );
}

const responded = (cost: number, cached: number): EventDraft => ({
  type: "model.responded",
  data: {
    model: { provider: "p", model: "m" },
    items: [{ type: "tool_call", callId: "q", name: "ask_user", arguments: "{}" }],
    stopReason: "tool_calls",
    usage: { inputTokens: 1000, cachedInputTokens: cached, outputTokens: 100, costUsd: cost },
    latencyMs: 1,
  },
});

test("stats summarise outcomes, cost, time, interruptions and incoming events", () => {
  const states = [
    task("a", 0, [
      responded(0.02, 800),
      {
        type: "attention.requested",
        data: { attentionId: "1", kind: "question", prompt: "?", callId: "q" },
      },
      { type: "attention.resolved", data: { attentionId: "1", response: "ok" } },
      { type: "tool.finished", data: { callId: "q", outcome: "ok", content: text("ok") } },
      { type: "task.ended", data: { outcome: "completed" } },
    ]),
    task("b", 0, [responded(0.04, 0), { type: "task.ended", data: { outcome: "failed" } }]),
    task("c", 0, [{ type: "task.ended", data: { outcome: "cancelled" } }]),
    task("d", 0, []),
  ];
  const triggers = [
    { decision: { action: "create" } },
    { decision: { action: "observe" } },
    { decision: { action: "ignore" } },
    { decision: { action: "ignore" } },
  ] as unknown as TriggerRecord[];

  const stats = computeStats(states, triggers);
  expect(stats.tasks).toEqual({
    total: 4,
    open: 1,
    completed: 1,
    failed: 1,
    cancelled: 1,
    successRate: 0.5,
  });
  expect(stats.perEndedTask.medianCostUsd).toBeCloseTo(0.02);
  expect(stats.perEndedTask.medianDurationMs).toBe(120_000);
  expect(stats.perEndedTask.meanInterruptions).toBeCloseTo(1 / 3);
  expect(stats.usage.cacheHitRate).toBeCloseTo(0.4);
  expect(stats.triggers).toEqual({
    total: 4,
    byDecision: { create: 1, observe: 1, ignore: 2 },
    observed: 1,
  });
});
