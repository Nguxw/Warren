import type {
  ConversationItem,
  Grant,
  TaskEndOutcome,
  TaskEvent,
  ToolCallItem,
  ToolEffect,
  TriggerRef,
  UserMessageItem,
} from "@warren/protocol";

/**
 * A task's state is a fold over its event log. Nothing else is stored about a task that
 * the log does not already say, so a restart rebuilds exactly what was there before.
 *
 * `applyEvent` also guards the log: an event that cannot follow the current state throws,
 * and the store refuses to commit it.
 */

export interface RunningCall {
  callId: string;
  name: string;
  effect: ToolEffect;
  startedAt: number;
}

export interface OpenAttention {
  attentionId: string;
  kind: "question" | "approval";
  prompt: string;
  callId?: string;
  requestedAt: number;
}

export interface UsageTotals {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  costUsd: number;
}

export interface TaskState {
  id: string;
  title: string;
  instruction: string;
  grant: Grant;
  trigger: TriggerRef;
  createdAt: number;
  updatedAt: number;
  lastSeq: number;
  /** Conversation in the order a model must see it; always valid to send as is. */
  history: ConversationItem[];
  /** Tool calls from the latest model response that have no result yet, in order. */
  pendingCalls: ToolCallItem[];
  /** Calls with `tool.started` and no `tool.finished`. Non-empty after a crash mid-call. */
  running: RunningCall[];
  /**
   * Inputs that arrived while tool calls were pending. Providers require tool results to follow
   * their calls directly, so these join the history once the last pending call has a result.
   */
  queuedInputs: UserMessageItem[];
  attention: OpenAttention[];
  paused?: { reason: string; at: number };
  ended?: { outcome: TaskEndOutcome; summary?: string; at: number };
  usage: UsageTotals;
  modelFailuresInARow: number;
}

export class LogInvariantError extends Error {
  override name = "LogInvariantError";
}

function fail(event: TaskEvent, message: string): never {
  throw new LogInvariantError(`${event.taskId}#${event.seq} ${event.type}: ${message}`);
}

export function foldEvents(events: Iterable<TaskEvent>): TaskState {
  let state: TaskState | undefined;
  for (const event of events) {
    if (state) applyEvent(state, event);
    else state = createState(event);
  }
  if (!state) throw new LogInvariantError("empty log");
  return state;
}

export function createState(event: TaskEvent): TaskState {
  if (event.type !== "task.created") fail(event, "a log must start with task.created");
  if (event.seq !== 0) fail(event, "task.created must have seq 0");
  const { title, instruction, grant, trigger } = event.data;
  return {
    id: event.taskId,
    title,
    instruction,
    grant,
    trigger,
    createdAt: event.at,
    updatedAt: event.at,
    lastSeq: 0,
    history: [{ type: "message", role: "user", content: [{ type: "text", text: instruction }] }],
    pendingCalls: [],
    running: [],
    queuedInputs: [],
    attention: [],
    usage: {
      modelCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      costUsd: 0,
    },
    modelFailuresInARow: 0,
  };
}

/** Applies one event to `state` in place. Throws `LogInvariantError` if it cannot follow. */
export function applyEvent(state: TaskState, event: TaskEvent): void {
  if (event.taskId !== state.id) fail(event, `belongs to another task (${state.id})`);
  if (event.seq !== state.lastSeq + 1) fail(event, `expected seq ${state.lastSeq + 1}`);
  if (state.ended) fail(event, "the task has ended");

  switch (event.type) {
    case "task.created":
      fail(event, "the task already exists");
      break;

    case "input.received":
      if (state.pendingCalls.length > 0) state.queuedInputs.push(event.data.item);
      else state.history.push(event.data.item);
      break;

    case "model.responded": {
      if (state.pendingCalls.length > 0) fail(event, "tool calls are still pending");
      const calls = event.data.items.filter((item) => item.type === "tool_call");
      const ids = new Set(calls.map((call) => call.callId));
      if (ids.size !== calls.length) fail(event, "duplicate callId in one response");
      state.history.push(...event.data.items);
      state.pendingCalls = calls;
      const { usage } = event.data;
      state.usage.modelCalls += 1;
      state.usage.inputTokens += usage.inputTokens;
      state.usage.outputTokens += usage.outputTokens;
      state.usage.cachedInputTokens += usage.cachedInputTokens ?? 0;
      state.usage.reasoningTokens += usage.reasoningTokens ?? 0;
      state.usage.costUsd += usage.costUsd ?? 0;
      state.modelFailuresInARow = 0;
      break;
    }

    case "model.failed":
      state.modelFailuresInARow += 1;
      break;

    case "tool.started": {
      const { callId, name, effect } = event.data;
      const call = state.pendingCalls.find((c) => c.callId === callId);
      if (!call) fail(event, `no pending call ${callId}`);
      if (call.name !== name) fail(event, `call ${callId} is ${call.name}, not ${name}`);
      if (state.running.some((r) => r.callId === callId)) fail(event, `${callId} already started`);
      state.running.push({ callId, name, effect, startedAt: event.at });
      break;
    }

    case "tool.finished": {
      const { callId, outcome, content } = event.data;
      const index = state.pendingCalls.findIndex((c) => c.callId === callId);
      if (index < 0) fail(event, `no pending call ${callId}`);
      state.pendingCalls.splice(index, 1);
      state.running = state.running.filter((r) => r.callId !== callId);
      state.history.push({ type: "tool_result", callId, outcome, content });
      if (state.pendingCalls.length === 0 && state.queuedInputs.length > 0) {
        state.history.push(...state.queuedInputs);
        state.queuedInputs = [];
      }
      break;
    }

    case "attention.requested": {
      const { attentionId, kind, prompt, callId } = event.data;
      if (state.attention.some((a) => a.attentionId === attentionId)) {
        fail(event, `attention ${attentionId} is already open`);
      }
      if (callId !== undefined && !state.pendingCalls.some((c) => c.callId === callId)) {
        fail(event, `no pending call ${callId}`);
      }
      state.attention.push({
        attentionId,
        kind,
        prompt,
        requestedAt: event.at,
        ...(callId !== undefined && { callId }),
      });
      break;
    }

    case "attention.resolved": {
      const index = state.attention.findIndex((a) => a.attentionId === event.data.attentionId);
      if (index < 0) fail(event, `attention ${event.data.attentionId} is not open`);
      state.attention.splice(index, 1);
      break;
    }

    case "task.paused":
      if (state.paused) fail(event, "already paused");
      state.paused = { reason: event.data.reason, at: event.at };
      break;

    case "task.resumed":
      if (!state.paused) fail(event, "not paused");
      state.paused = undefined;
      break;

    case "task.ended":
      state.ended = {
        outcome: event.data.outcome,
        at: event.at,
        ...(event.data.summary !== undefined && { summary: event.data.summary }),
      };
      break;

    default: {
      const unreachable: never = event;
      throw new LogInvariantError(`unhandled event ${JSON.stringify(unreachable)}`);
    }
  }

  state.lastSeq = event.seq;
  state.updatedAt = event.at;
}

/** What the loop should do next. Derived from state only, so it is the same after a restart. */
export type NextStep =
  | { kind: "ended" }
  | { kind: "paused" }
  /** A crash cut these calls off; how to recover depends on each call's effect. */
  | { kind: "recover_tools"; calls: RunningCall[] }
  | { kind: "wait_for_person"; attention: OpenAttention[] }
  | { kind: "run_tool"; call: ToolCallItem }
  | { kind: "call_model" }
  /** The model ended its turn; an input wakes the task. */
  | { kind: "idle" };

export function nextStep(state: TaskState): NextStep {
  if (state.ended) return { kind: "ended" };
  if (state.paused) return { kind: "paused" };
  if (state.running.length > 0) return { kind: "recover_tools", calls: state.running };
  if (state.attention.length > 0) return { kind: "wait_for_person", attention: state.attention };
  const call = state.pendingCalls[0];
  if (call) return { kind: "run_tool", call };
  const last = state.history.at(-1);
  if (last?.type === "tool_result" || (last?.type === "message" && last.role === "user")) {
    return { kind: "call_model" };
  }
  return { kind: "idle" };
}

export type TaskStatus = "active" | "waiting" | "idle" | "paused" | "ended";

export function statusOf(state: TaskState): TaskStatus {
  switch (nextStep(state).kind) {
    case "ended":
      return "ended";
    case "paused":
      return "paused";
    case "wait_for_person":
      return "waiting";
    case "idle":
      return "idle";
    default:
      return "active";
  }
}
