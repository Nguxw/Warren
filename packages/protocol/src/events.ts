import { z } from "zod";
import { Grant, TriggerRef } from "./grant.ts";
import { ContentPart, ModelOutputItem, ToolOutcome, Usage, UserMessageItem } from "./items.ts";

/**
 * Task event log, format v1.
 *
 * A task's log is the only source of truth for that task. Every event shares one envelope;
 * `v` versions each event type on its own, so changing one type never rewrites the others.
 * Events are never edited after they are written: an old shape is upcast when it is read
 * (see `upcast.ts`). Adding a new event type needs no version change.
 */

const envelope = {
  taskId: z.string(),
  /** Position in the task's log, starting at 0 with `task.created`, without gaps. */
  seq: z.number().int().nonnegative(),
  /** Unix epoch milliseconds, from the daemon's clock. */
  at: z.number().int().nonnegative(),
};

function event<T extends string, D extends z.ZodType>(type: T, data: D) {
  return z.object({ type: z.literal(type), v: z.literal(1), ...envelope, data });
}

export const ModelRef = z.object({
  /** Adapter id, e.g. `openai-responses`, `openai-compatible`, `anthropic`. */
  provider: z.string(),
  model: z.string(),
});
export type ModelRef = z.infer<typeof ModelRef>;

export const StopReason = z.enum(["end_turn", "tool_calls", "max_tokens", "refusal", "other"]);
export type StopReason = z.infer<typeof StopReason>;

/** How a model call failed, normalised across providers so the loop decides retries in one place. */
export const ModelErrorKind = z.enum(["retryable", "fatal", "context_overflow"]);
export type ModelErrorKind = z.infer<typeof ModelErrorKind>;

/** What a tool may change, which decides how a call cut off by a crash is recovered. */
export const ToolEffect = z.enum([
  /** No side effects: run again. */
  "read",
  /** Changes only the task's own workspace: run again, the workspace shows the truth. */
  "write",
  /** Changes something outside Warren: never run again blindly. */
  "external",
]);
export type ToolEffect = z.infer<typeof ToolEffect>;

export const TaskEndOutcome = z.enum(["completed", "failed", "cancelled"]);
export type TaskEndOutcome = z.infer<typeof TaskEndOutcome>;

export const TaskCreated = event(
  "task.created",
  z.object({
    title: z.string(),
    instruction: z.string(),
    grant: Grant,
    trigger: TriggerRef,
    /** Model role from the config (`main` when absent); the model actually used is in each response. */
    modelRole: z.string().optional(),
    /**
     * Conversations the task follows, such as `github:owner/repo#12`: later messages there reach
     * the task, and its questions and result are posted back there.
     */
    follows: z.array(z.string()).optional(),
  }),
);

/** A message for the task from a person or a connector; it wakes an idle task. */
export const InputReceived = event(
  "input.received",
  z.object({
    item: UserMessageItem,
    trigger: TriggerRef,
  }),
);

export const ModelResponded = event(
  "model.responded",
  z.object({
    model: ModelRef,
    items: z.array(ModelOutputItem),
    stopReason: StopReason,
    usage: Usage,
    latencyMs: z.number().int().nonnegative(),
  }),
);

export const ModelFailed = event(
  "model.failed",
  z.object({
    model: ModelRef,
    kind: ModelErrorKind,
    message: z.string(),
  }),
);

/** Written before a tool runs. A `tool.started` without `tool.finished` means a crash cut it off. */
export const ToolStarted = event(
  "tool.started",
  z.object({
    callId: z.string(),
    name: z.string(),
    effect: ToolEffect,
  }),
);

export const ToolFinished = event(
  "tool.finished",
  z.object({
    callId: z.string(),
    outcome: ToolOutcome,
    content: z.array(ContentPart),
  }),
);

/** The task needs a person: a question to answer or a privileged call to approve. */
export const AttentionRequested = event(
  "attention.requested",
  z.object({
    attentionId: z.string(),
    kind: z.enum(["question", "approval"]),
    prompt: z.string(),
    /** For an approval, the tool call waiting on it. */
    callId: z.string().optional(),
  }),
);

export const AttentionResolved = event(
  "attention.resolved",
  z.object({
    attentionId: z.string(),
    response: z.string(),
    approved: z.boolean().optional(),
  }),
);

/**
 * Older conversation replaced by a summary, so a long task fits the model's context. The first
 * `replaces` items after the instruction give way to one summary message; the log keeps them all.
 */
export const ContextCompacted = event(
  "context.compacted",
  z.object({
    summary: z.string(),
    replaces: z.number().int().positive(),
    model: ModelRef,
    usage: Usage,
  }),
);

export const TaskPaused = event("task.paused", z.object({ reason: z.string() }));
export const TaskResumed = event("task.resumed", z.object({}));

export const TaskEnded = event(
  "task.ended",
  z.object({
    outcome: TaskEndOutcome,
    summary: z.string().optional(),
  }),
);

export const TaskEvent = z.discriminatedUnion("type", [
  TaskCreated,
  InputReceived,
  ModelResponded,
  ModelFailed,
  ToolStarted,
  ToolFinished,
  AttentionRequested,
  AttentionResolved,
  ContextCompacted,
  TaskPaused,
  TaskResumed,
  TaskEnded,
]);
export type TaskEvent = z.infer<typeof TaskEvent>;
export type TaskEventType = TaskEvent["type"];
export type EventOf<T extends TaskEventType> = Extract<TaskEvent, { type: T }>;

/** What a writer supplies; the store assigns `v`, `taskId`, `seq` and `at`. */
export type EventDraft = {
  [T in TaskEventType]: { type: T; data: EventOf<T>["data"] };
}[TaskEventType];

/** Current version of each event type; the store writes this version. */
export const EVENT_VERSIONS: { readonly [T in TaskEventType]: EventOf<T>["v"] } = {
  "task.created": 1,
  "input.received": 1,
  "model.responded": 1,
  "model.failed": 1,
  "tool.started": 1,
  "tool.finished": 1,
  "attention.requested": 1,
  "attention.resolved": 1,
  "context.compacted": 1,
  "task.paused": 1,
  "task.resumed": 1,
  "task.ended": 1,
};
