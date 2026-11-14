import type {
  ConversationItem,
  Grant,
  TaskEndOutcome,
  TaskEvent,
  TaskStatus,
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
  modelRole?: string;
  follows: string[];
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
  /** Answers to attention tied to a tool call, kept until that call has its result. */
  answers: Record<string, { response: string; approved?: boolean }>;
  paused?: { reason: string; at: number };
  ended?: { outcome: TaskEndOutcome; summary?: string; at: number };
  /** Where the person wants the task's files saved, chosen when it was created. */
  outputDir?: string;
  /** Skills the person chose for the task. */
  skills: string[];
  /** Times the task's files were saved out of its workspace, oldest first. */
  exports: { destination: string; files: number; at: number }[];
  usage: UsageTotals;
  modelFailuresInARow: number;
  compactions: number;
  /** How often the task needed a person: questions asked, approvals requested. */
  asked: { questions: number; approvals: number };
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
  const { title, instruction, grant, trigger, modelRole, follows, outputDir, skills } = event.data;
  return {
    id: event.taskId,
    title,
    instruction,
    grant,
    trigger,
    ...(modelRole !== undefined && { modelRole }),
    follows: follows ?? [],
    ...(outputDir !== undefined && { outputDir }),
    skills: skills ?? [],
    exports: [],
    createdAt: event.at,
    updatedAt: event.at,
    lastSeq: 0,
    history: [{ type: "message", role: "user", content: [{ type: "text", text: instruction }] }],
    pendingCalls: [],
    running: [],
    queuedInputs: [],
    attention: [],
    answers: {},
    usage: {
      modelCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      costUsd: 0,
    },
    modelFailuresInARow: 0,
    compactions: 0,
    asked: { questions: 0, approvals: 0 },
  };
}

/** Applies one event to `state` in place. Throws `LogInvariantError` if it cannot follow. */
export function applyEvent(state: TaskState, event: TaskEvent): void {
  if (event.taskId !== state.id) fail(event, `belongs to another task (${state.id})`);
  if (event.seq !== state.lastSeq + 1) fail(event, `expected seq ${state.lastSeq + 1}`);
  // Saving files out is the person's action on a finished result, so it may follow the end.
  if (state.ended && event.type !== "artifacts.exported") fail(event, "the task has ended");

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
      delete state.answers[callId];
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
      if (kind === "question") state.asked.questions += 1;
      else state.asked.approvals += 1;
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
      const [resolved] = state.attention.splice(index, 1);
      if (resolved?.callId !== undefined) {
        const { response, approved } = event.data;
        state.answers[resolved.callId] = { response, ...(approved !== undefined && { approved }) };
      }
      break;
    }

    case "context.compacted": {
      const { replaces, summary, usage } = event.data;
      if (state.pendingCalls.length > 0) fail(event, "tool calls are pending");
      if (!isSafeCut(state.history, 1 + replaces))
        fail(event, `cannot replace ${replaces} items here`);
      state.history = [
        state.history[0] as ConversationItem,
        summaryItem(summary),
        ...state.history.slice(1 + replaces),
      ];
      state.compactions += 1;
      state.usage.inputTokens += usage.inputTokens;
      state.usage.outputTokens += usage.outputTokens;
      state.usage.cachedInputTokens += usage.cachedInputTokens ?? 0;
      state.usage.costUsd += usage.costUsd ?? 0;
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

    case "artifacts.exported":
      state.exports.push({ ...event.data, at: event.at });
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

/** How a summary appears to the model, in place of the conversation it replaces. */
export function summaryItem(summary: string): UserMessageItem {
  return {
    type: "message",
    role: "user",
    content: [{ type: "text", text: `[Summary of the earlier part of this task]\n${summary}` }],
  };
}

/**
 * Whether history items 1..end-1 can be replaced: every tool call in that range has its result
 * in it too, and the item after it is not a tool result, so no call and result are separated.
 */
export function isSafeCut(history: readonly ConversationItem[], end: number): boolean {
  if (end < 2 || end > history.length) return false;
  const open = new Set<string>();
  for (let i = 1; i < end; i += 1) {
    const item = history[i];
    if (item?.type === "tool_call") open.add(item.callId);
    if (item?.type === "tool_result") open.delete(item.callId);
  }
  return open.size === 0 && history[end]?.type !== "tool_result";
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
