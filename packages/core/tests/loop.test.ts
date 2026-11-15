import { describe, expect, test } from "bun:test";
import { textOf } from "@warren/protocol";
import { z } from "zod";
import { INTERRUPTED_EXTERNAL, ModelError, nextStep, runTask, withCost } from "../src/index.ts";
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
const readFile = () =>
  fakeTool(
    "read_file",
    z.object({ path: z.string() }),
    "read",
    ({ path }) => `contents of ${path}`,
  );

function eventTypes(deps: ReturnType<typeof testDeps>, taskId = "t1") {
  return deps.log.events(taskId).map((event) => event.type);
}

describe("runTask", () => {
  test("runs tools and ends when the model completes the task", async () => {
    const tool = readFile();
    const model = new ScriptedModel([
      reply(say("Reading"), toolCall("read_file", { path: "a.ts" })),
      reply(toolCall("complete_task", { summary: "Fixed a.ts" })),
    ]);
    const deps = testDeps({ model, tools: [tool] });
    deps.log.create("t1", testTask);

    const step = await runTask("t1", deps, never);

    expect(step).toEqual({ kind: "ended" });
    expect(tool.calls).toEqual([{ path: "a.ts" }]);
    expect(deps.log.get("t1")?.ended).toMatchObject({
      outcome: "completed",
      summary: "Fixed a.ts",
    });
    expect(eventTypes(deps)).toEqual([
      "task.created",
      "model.responded",
      "tool.started",
      "tool.finished",
      "model.responded",
      "tool.finished",
      "task.ended",
    ]);
    // The second request carries the tool result, and every request lists the tools.
    expect(model.requests[1]?.items.at(-1)).toMatchObject({
      type: "tool_result",
      outcome: "ok",
      content: [{ type: "text", text: "contents of a.ts" }],
    });
    expect(model.requests[0]?.tools.map((t) => t.name)).toEqual([
      "read_file",
      "ask_user",
      "complete_task",
    ]);
    expect(model.requests[0]?.cacheKey).toBe("t1");
  });

  test("a turn without tool calls leaves the task idle; an input wakes it", async () => {
    const model = new ScriptedModel([reply(say("Which file?"))]);
    const deps = testDeps({ model });
    deps.log.create("t1", testTask);

    expect(await runTask("t1", deps, never)).toEqual({ kind: "idle" });

    deps.log.append("t1", [
      {
        type: "input.received",
        data: {
          item: { type: "message", role: "user", content: [{ type: "text", text: "a.ts" }] },
          trigger: { source: "manual" },
        },
      },
    ]);
    model.push(reply(toolCall("complete_task", { summary: "done" })));
    expect(await runTask("t1", deps, never)).toEqual({ kind: "ended" });
  });

  test("bad calls become error results the model can react to", async () => {
    const model = new ScriptedModel([
      reply(
        toolCall("delete_everything"),
        toolCall("read_file", "{not json"),
        toolCall("read_file", { path: 42 }),
        toolCall("complete_task", {}),
      ),
      reply(toolCall("complete_task", { summary: "gave up" })),
    ]);
    const deps = testDeps({ model, tools: [readFile()] });
    deps.log.create("t1", testTask);

    await runTask("t1", deps, never);

    const results = model.requests[1]?.items.filter((item) => item.type === "tool_result") ?? [];
    expect(results.map((r) => r.type === "tool_result" && r.outcome)).toEqual([
      "error",
      "error",
      "error",
      "error",
    ]);
    const texts = results.map((r) => (r.type === "tool_result" ? textOf(r.content) : ""));
    expect(texts[0]).toContain('Unknown tool "delete_everything"');
    expect(texts[1]).toContain("not valid JSON");
    expect(texts[2]).toContain("Invalid arguments for read_file");
    // Invalid calls never reach tool.started: nothing ran.
    expect(eventTypes(deps).filter((type) => type === "tool.started")).toHaveLength(0);
  });

  test("ask_user waits for a person and hands the answer to the model", async () => {
    const model = new ScriptedModel([
      reply(toolCall("ask_user", { question: "Delete the old API?" }, "q1")),
      reply(toolCall("complete_task", { summary: "kept it" })),
    ]);
    const deps = testDeps({ model });
    deps.log.create("t1", testTask);

    const step = await runTask("t1", deps, never);
    expect(step).toMatchObject({
      kind: "wait_for_person",
      attention: [{ attentionId: "id_1", prompt: "Delete the old API?", callId: "q1" }],
    });

    deps.log.append("t1", [
      { type: "attention.resolved", data: { attentionId: "id_1", response: "No, keep it" } },
    ]);
    expect(await runTask("t1", deps, never)).toEqual({ kind: "ended" });
    expect(model.requests[1]?.items.at(-1)).toMatchObject({
      type: "tool_result",
      callId: "q1",
      content: [{ type: "text", text: "No, keep it" }],
    });
  });

  test("retryable failures back off, then the call succeeds", async () => {
    const model = new ScriptedModel([
      new ModelError("retryable", "503"),
      new ModelError("retryable", "429", 10_000),
      reply(toolCall("complete_task", { summary: "ok" })),
    ]);
    const deps = testDeps({ model });
    deps.log.create("t1", testTask);

    expect(await runTask("t1", deps, never)).toEqual({ kind: "ended" });
    expect(deps.sleeps).toEqual([2_000, 10_000]);
    expect(eventTypes(deps).filter((type) => type === "model.failed")).toHaveLength(2);
  });

  test("too many retryable failures in a row pause the task", async () => {
    const failures = Array.from({ length: 3 }, () => new ModelError("retryable", "down"));
    const deps = testDeps({ model: new ScriptedModel(failures), limits: { maxModelRetries: 3 } });
    deps.log.create("t1", testTask);

    expect(await runTask("t1", deps, never)).toEqual({ kind: "paused" });
    expect(deps.log.get("t1")?.paused?.reason).toContain("after 3 attempts");
  });

  test("a fatal error or a context overflow ends the task as failed", async () => {
    for (const kind of ["fatal", "context_overflow"] as const) {
      const deps = testDeps({ model: new ScriptedModel([new ModelError(kind, "nope")]) });
      deps.log.create("t1", testTask);
      expect(await runTask("t1", deps, never)).toEqual({ kind: "ended" });
      expect(deps.log.get("t1")?.ended?.outcome).toBe("failed");
    }
  });

  test("the budget stops the task before the next model call", async () => {
    const model = new ScriptedModel([reply(toolCall("read_file", { path: "a" }))]);
    const deps = testDeps({ model, tools: [readFile()] });
    deps.log.create("t1", {
      ...testTask,
      grant: { ...testTask.grant, budget: { maxModelCalls: 1 } },
    });

    expect(await runTask("t1", deps, never)).toEqual({ kind: "ended" });
    expect(model.requests).toHaveLength(1);
    expect(deps.log.get("t1")?.ended?.summary).toContain("Budget exhausted: 1 of 1 model calls");
  });

  test("an unknown model role ends the task with a clear reason", async () => {
    const deps = testDeps({
      models: {
        resolve: (role) => {
          throw new Error(`no role ${role}`);
        },
      },
    });
    deps.log.create("t1", { ...testTask, modelRole: "turbo" });
    await runTask("t1", deps, never);
    expect(deps.log.get("t1")?.ended?.summary).toBe('Model role "turbo": no role turbo');
  });
});

describe("recovery after a crash", () => {
  function crashedMidCall(effect: "read" | "external") {
    const tool = fakeTool("act", z.object({}), effect);
    // Only what the model says after the restart; its earlier reply is already in the log.
    const model = new ScriptedModel([reply(toolCall("complete_task", { summary: "done" }))]);
    const deps = testDeps({ model, tools: [tool] });
    deps.log.create("t1", testTask);
    // The process wrote the model response and tool.started, then died.
    deps.log.append("t1", [
      {
        type: "model.responded",
        data: {
          model: { provider: "scripted", model: "scripted-1" },
          items: [{ type: "tool_call", callId: "c1", name: "act", arguments: "{}" }],
          stopReason: "tool_calls",
          usage: { inputTokens: 1, outputTokens: 1 },
          latencyMs: 1,
        },
      },
      { type: "tool.started", data: { callId: "c1", name: "act", effect } },
    ]);
    return { deps, tool, model };
  }

  test("an external call is never run again; the model is told the outcome is unknown", async () => {
    const { deps, tool, model } = crashedMidCall("external");
    const crashed = deps.log.get("t1");
    expect(crashed && nextStep(crashed)).toMatchObject({ kind: "recover_tools" });

    expect(await runTask("t1", deps, never)).toEqual({ kind: "ended" });
    expect(tool.calls).toHaveLength(0);
    expect(model.requests[0]?.items.at(-1)).toMatchObject({
      type: "tool_result",
      outcome: "interrupted",
      content: [{ type: "text", text: INTERRUPTED_EXTERNAL }],
    });
  });

  test("a read or write call runs again without a second tool.started", async () => {
    const { deps, tool } = crashedMidCall("read");
    expect(await runTask("t1", deps, never)).toEqual({ kind: "ended" });
    expect(tool.calls).toHaveLength(1);
    expect(eventTypes(deps).filter((type) => type === "tool.started")).toHaveLength(1);
  });

  test("a shutdown during a tool leaves the call open for recovery", async () => {
    const controller = new AbortController();
    const slow = fakeTool("slow", z.object({}), "write");
    slow.run = async () => {
      controller.abort();
      return { outcome: "ok", text: "too late" };
    };
    const deps = testDeps({
      model: new ScriptedModel([reply(toolCall("slow", {}, "c1"))]),
      tools: [slow],
    });
    deps.log.create("t1", testTask);

    expect(await runTask("t1", deps, controller.signal)).toMatchObject({ kind: "recover_tools" });
    expect(eventTypes(deps).at(-1)).toBe("tool.started");
  });
});

test("withCost prices cached input separately", () => {
  const usage = { inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 100_000 };
  expect(withCost(usage, { input: 1, cachedInput: 0.1, output: 5 }).costUsd).toBeCloseTo(
    0.6 + 0.04 + 0.5,
  );
  expect(withCost(usage, undefined).costUsd).toBeUndefined();
});

describe("privileged tools", () => {
  function push(approval: "required" | "auto") {
    const tool = fakeTool("push", z.object({ branch: z.string() }), "external", () => "pushed");
    return Object.assign(tool, {
      privileged: true,
      approval,
      describe: ({ branch }: { branch: string }) => `Push ${branch} to origin`,
    });
  }
  const granted = { ...testTask, grant: { ...testTask.grant, privilegedTools: ["push"] } };

  test("a task without the grant neither sees nor runs the tool", async () => {
    const tool = push("auto");
    const model = new ScriptedModel([
      reply(toolCall("push", { branch: "main" })),
      reply(toolCall("complete_task", { summary: "could not push" })),
    ]);
    const deps = testDeps({ model, tools: [tool] });
    deps.log.create("t1", testTask);

    await runTask("t1", deps, never);
    expect(model.requests[0]?.tools.map((t) => t.name)).not.toContain("push");
    expect(tool.calls).toHaveLength(0);
    expect(model.requests[1]?.items.at(-1)).toMatchObject({
      type: "tool_result",
      outcome: "denied",
      content: [{ type: "text", text: "push is not granted to this task." }],
    });
  });

  test("an auto-approved tool runs when granted", async () => {
    const tool = push("auto");
    const deps = testDeps({
      model: new ScriptedModel([
        reply(toolCall("push", { branch: "warren/1" })),
        reply(toolCall("complete_task", { summary: "pushed" })),
      ]),
      tools: [tool],
    });
    deps.log.create("t1", granted);
    expect(await runTask("t1", deps, never)).toEqual({ kind: "ended" });
    expect(tool.calls).toEqual([{ branch: "warren/1" }]);
  });

  test("a required approval waits for a person, then runs", async () => {
    const tool = push("required");
    const deps = testDeps({
      model: new ScriptedModel([
        reply(toolCall("push", { branch: "warren/1" }, "p1")),
        reply(toolCall("complete_task", { summary: "pushed" })),
      ]),
      tools: [tool],
    });
    deps.log.create("t1", granted);

    expect(await runTask("t1", deps, never)).toMatchObject({
      kind: "wait_for_person",
      attention: [{ kind: "approval", prompt: "Push warren/1 to origin", callId: "p1" }],
    });
    expect(tool.calls).toHaveLength(0);
    // Waiting for approval writes no tool.started: nothing has run yet.
    expect(eventTypes(deps)).not.toContain("tool.started");

    deps.log.append("t1", [
      { type: "attention.resolved", data: { attentionId: "id_1", response: "", approved: true } },
    ]);
    expect(await runTask("t1", deps, never)).toEqual({ kind: "ended" });
    expect(tool.calls).toHaveLength(1);
  });

  test("a declined approval reaches the model as denied, with the person's reason", async () => {
    const tool = push("required");
    const model = new ScriptedModel([
      reply(toolCall("push", { branch: "warren/1" })),
      reply(toolCall("complete_task", { summary: "left unpushed" })),
    ]);
    const deps = testDeps({ model, tools: [tool] });
    deps.log.create("t1", granted);
    await runTask("t1", deps, never);
    deps.log.append("t1", [
      {
        type: "attention.resolved",
        data: { attentionId: "id_1", response: "not before review", approved: false },
      },
    ]);

    await runTask("t1", deps, never);
    expect(tool.calls).toHaveLength(0);
    expect(model.requests[1]?.items.at(-1)).toMatchObject({
      outcome: "denied",
      content: [{ text: "The user did not approve this call. They said: not before review" }],
    });
  });
});
