import { describe, expect, test } from "bun:test";
import { EventFormatError, parseEvent, upcast } from "../src/index.ts";

const created = {
  type: "task.created",
  v: 1,
  taskId: "t1",
  seq: 0,
  at: 1_700_000_000_000,
  data: {
    title: "Fix flaky test",
    instruction: "Make tests/foo pass reliably",
    grant: {
      workspace: { kind: "clone", source: "/repo" },
      network: false,
      privilegedTools: [],
      budget: { maxModelCalls: 50 },
    },
    trigger: { source: "manual" },
  },
};

describe("parseEvent", () => {
  test("accepts a current event", () => {
    expect(parseEvent(created)).toEqual(created as never);
  });

  test("keeps provider-private reasoning data opaque", () => {
    const responded = {
      type: "model.responded",
      v: 1,
      taskId: "t1",
      seq: 1,
      at: 1,
      data: {
        model: { provider: "openai-responses", model: "gpt-x" },
        items: [
          { type: "reasoning", provider: "openai-responses", data: { encrypted: "abc" } },
          { type: "tool_call", callId: "c1", name: "read_file", arguments: '{"path":"a"}' },
        ],
        stopReason: "tool_calls",
        usage: { inputTokens: 10, outputTokens: 5 },
        latencyMs: 120,
      },
    };
    expect(parseEvent(responded)).toEqual(responded as never);
  });

  test("rejects unknown types, newer versions and bad data", () => {
    expect(() => parseEvent({ ...created, type: "task.exploded" })).toThrow(EventFormatError);
    expect(() => parseEvent({ ...created, v: 2 })).toThrow(/newer than this build/);
    expect(() => parseEvent({ ...created, data: { title: 1 } })).toThrow(EventFormatError);
    expect(() => parseEvent("nope")).toThrow(EventFormatError);
  });

  test("upcast runs each step in order and fails on a gap", () => {
    const chain = [
      (data: unknown) => ({ ...(data as object), b: 2 }),
      (data: unknown) => ({ ...(data as object), c: 3 }),
    ];
    expect(upcast("x", { a: 1 }, 1, 3, chain)).toEqual({ a: 1, b: 2, c: 3 });
    expect(upcast("x", { a: 1 }, 2, 3, chain)).toEqual({ a: 1, c: 3 });
    expect(upcast("x", { a: 1 }, 3, 3, chain)).toEqual({ a: 1 });
    expect(() => upcast("x", {}, 1, 4, chain)).toThrow(/no upcaster for "x" v3/);
  });
});
