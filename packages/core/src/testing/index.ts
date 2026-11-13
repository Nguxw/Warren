import {
  EVENT_VERSIONS,
  type EventDraft,
  type EventOf,
  type ModelOutputItem,
  type TaskEvent,
  TaskEvent as TaskEventSchema,
  text,
} from "@warren/protocol";
import type { LoopDeps } from "../loop.ts";
import {
  type ModelClient,
  ModelError,
  type ModelRequest,
  type ModelResponse,
  type TaskLog,
  type Tool,
} from "../ports.ts";
import { foldEvents, type TaskState } from "../task-state.ts";

/**
 * Test doubles for the core's ports. Exported as `@warren/core/testing` so adapters and the
 * daemon test against the same fakes.
 */

type ScriptStep = ModelResponse | ModelError | ((request: ModelRequest) => ModelResponse);

/** A model that answers from a script, in order, and records every request it received. */
export class ScriptedModel implements ModelClient {
  readonly provider = "scripted";
  readonly requests: ModelRequest[] = [];
  private readonly script: ScriptStep[];

  constructor(script: ScriptStep[] = []) {
    this.script = [...script];
  }

  push(...steps: ScriptStep[]): void {
    this.script.push(...steps);
  }

  get remaining(): number {
    return this.script.length;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const step = this.script.shift();
    if (!step) throw new ModelError("fatal", "scripted model: script exhausted");
    if (step instanceof ModelError) throw step;
    return typeof step === "function" ? step(request) : step;
  }
}

/** A log kept in memory that refolds on every read, so it checks the same rules as the store. */
export class MemoryTaskLog implements TaskLog {
  private readonly logs = new Map<string, TaskEvent[]>();
  private time = 0;

  create(taskId: string, data: EventOf<"task.created">["data"]): TaskState {
    if (this.logs.has(taskId)) throw new Error(`task ${taskId} exists`);
    this.logs.set(taskId, [this.build(taskId, 0, { type: "task.created", data })]);
    return this.require(taskId);
  }

  get(taskId: string): TaskState | undefined {
    const events = this.logs.get(taskId);
    return events ? foldEvents(events) : undefined;
  }

  append(taskId: string, drafts: readonly EventDraft[]): TaskState {
    const events = this.logs.get(taskId);
    if (!events) throw new Error(`no task ${taskId}`);
    const next = [...events];
    for (const draft of drafts) next.push(this.build(taskId, next.length, draft));
    const state = foldEvents(next); // throws before anything is kept
    this.logs.set(taskId, next);
    return state;
  }

  events(taskId: string): TaskEvent[] {
    return [...(this.logs.get(taskId) ?? [])];
  }

  /** Keeps only the first `count` events, as if the process died right after writing them. */
  truncate(taskId: string, count: number): void {
    this.logs.set(taskId, this.events(taskId).slice(0, count));
  }

  private require(taskId: string): TaskState {
    const state = this.get(taskId);
    if (!state) throw new Error(`no task ${taskId}`);
    return state;
  }

  private build(taskId: string, seq: number, draft: EventDraft): TaskEvent {
    this.time += 1;
    return TaskEventSchema.parse({
      ...draft,
      v: EVENT_VERSIONS[draft.type],
      taskId,
      seq,
      at: this.time,
    });
  }
}

export const testTask: EventOf<"task.created">["data"] = {
  title: "Test task",
  instruction: "Do the thing",
  grant: { workspace: { kind: "none" }, network: false, privilegedTools: [], budget: {} },
  trigger: { source: "manual" },
};

let callCounter = 0;

export function toolCall(name: string, args: unknown = {}, callId?: string): ModelOutputItem {
  callCounter += 1;
  return {
    type: "tool_call",
    callId: callId ?? `call_${callCounter}`,
    name,
    arguments: typeof args === "string" ? args : JSON.stringify(args),
  };
}

export function say(value: string): ModelOutputItem {
  return { type: "message", role: "assistant", content: text(value) };
}

export function reply(...items: ModelOutputItem[]): ModelResponse {
  const calls = items.some((item) => item.type === "tool_call");
  return {
    items,
    stopReason: calls ? "tool_calls" : "end_turn",
    usage: { inputTokens: 100, outputTokens: 10 },
  };
}

/** A tool that records its calls and answers with a function of its arguments. */
export function fakeTool<A>(
  name: string,
  parameters: Tool<A>["parameters"],
  effect: Tool["effect"],
  run: (args: A) => string = () => "ok",
): Tool<A> & { calls: A[] } {
  const calls: A[] = [];
  return {
    name,
    description: `fake ${name}`,
    parameters,
    effect,
    calls,
    async run(args) {
      calls.push(args);
      return { outcome: "ok", text: run(args) };
    },
  };
}

export function testDeps(
  overrides: Partial<LoopDeps> & { model?: ModelClient } = {},
): LoopDeps & { log: MemoryTaskLog; sleeps: number[] } {
  const { model = new ScriptedModel(), ...rest } = overrides;
  const sleeps: number[] = [];
  let ids = 0;
  return {
    log: new MemoryTaskLog(),
    models: { resolve: () => ({ client: model, model: "scripted-1" }) },
    tools: [],
    workspaceOf: () => "/tmp/warren-test-workspace",
    newId: () => `id_${++ids}`,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    sleeps,
    ...rest,
  } as LoopDeps & { log: MemoryTaskLog; sleeps: number[] };
}
