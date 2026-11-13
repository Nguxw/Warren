import { describe, expect, test } from "bun:test";
import { text } from "@warren/protocol";
import { z } from "zod";
import {
  estimateTokens,
  foldEvents,
  isSafeCut,
  ModelError,
  planCompaction,
  runTask,
  transcript,
} from "../src/index.ts";
import {
  fakeTool,
  reply,
  ScriptedModel,
  say,
  testDeps,
  testTask,
  toolCall,
} from "../src/testing/index.ts";

const never = new AbortController().signal;
const big = "x".repeat(1200); // about 300 tokens per tool result

function deps(model: ScriptedModel, contextWindow: number) {
  const read = fakeTool("read_file", z.object({ n: z.number() }), "read", () => big);
  return testDeps({
    model,
    tools: [read],
    models: { resolve: () => ({ client: model, model: "scripted", contextWindow }) },
  });
}

describe("planning", () => {
  const history = [
    { type: "message", role: "user", content: text("task") },
    { type: "tool_call", callId: "a", name: "read_file", arguments: "{}" },
    { type: "tool_result", callId: "a", outcome: "ok", content: text(big) },
    { type: "message", role: "assistant", content: text("next") },
    { type: "tool_call", callId: "b", name: "read_file", arguments: "{}" },
    { type: "tool_result", callId: "b", outcome: "ok", content: text(big) },
  ] as const;

  test("never separates a call from its result", () => {
    expect(isSafeCut(history, 2)).toBe(false); // the result of a would follow without its call
    expect(isSafeCut(history, 3)).toBe(true);
    expect(isSafeCut(history, 5)).toBe(false);
    expect(planCompaction(history, 400)).toBe(2); // keeps "next", the last call and its result
    expect(planCompaction(history, 100_000)).toBeUndefined();
  });

  test("estimates and transcripts are proportionate", () => {
    expect(estimateTokens(history)).toBeGreaterThan(600);
    expect(transcript(history)).toContain("TOOL CALL read_file {}");
    expect(transcript(history).length).toBeLessThan(big.length * 2 + 200);
  });
});

describe("compaction in the loop", () => {
  test("a long task compacts before its window fills, and the log replays to the same context", async () => {
    const model = new ScriptedModel([
      reply(toolCall("read_file", { n: 1 })),
      reply(toolCall("read_file", { n: 2 })),
      reply(toolCall("read_file", { n: 3 })),
      reply(toolCall("read_file", { n: 4 })),
      reply(say("Read files 1 to 3; each held 1200 x characters.")), // the summary
      reply(toolCall("complete_task", { summary: "done" })),
    ]);
    const d = deps(model, 1500);
    d.log.create("t1", testTask);

    expect(await runTask("t1", d, never)).toEqual({ kind: "ended" });
    const events = d.log.events("t1");
    const compacted = events.find((e) => e.type === "context.compacted");
    expect(compacted).toBeDefined();
    const state = foldEvents(events);
    expect(state.compactions).toBe(1);
    expect(state.history[1]).toMatchObject({
      type: "message",
      role: "user",
      content: [{ text: expect.stringContaining("Read files 1 to 3") }],
    });
    // The summariser saw a transcript, not tool items; the next request is smaller.
    expect(model.requests[4]?.tools).toEqual([]);
    expect(model.requests[4]?.items[0]?.type).toBe("message");
    const before = estimateTokens(model.requests[3]?.items ?? []);
    const after = estimateTokens(model.requests[5]?.items ?? []);
    expect(after).toBeLessThan(before);
  });

  test("a context overflow compacts and retries instead of failing", async () => {
    const model = new ScriptedModel([
      reply(toolCall("read_file", { n: 1 })),
      reply(toolCall("read_file", { n: 2 })),
      reply(toolCall("read_file", { n: 3 })),
      new ModelError("context_overflow", "prompt is too long"),
      reply(say("Summary of reads.")),
      reply(toolCall("complete_task", { summary: "done" })),
    ]);
    const d = deps(model, 100_000);
    d.log.create("t1", { ...testTask });
    // A large window never triggers proactive compaction; only the overflow does.
    d.models = { resolve: () => ({ client: model, model: "scripted", contextWindow: 1600 }) };
    expect(await runTask("t1", d, never)).toEqual({ kind: "ended" });
    expect(foldEvents(d.log.events("t1")).ended?.outcome).toBe("completed");
    expect(d.log.events("t1").map((e) => e.type)).toContain("context.compacted");
  });
});
