import { z } from "zod";

/**
 * A Grant is everything a task is allowed to touch. It is fixed when the task is created;
 * wider access means a new task, so the log always says under which limits work was done.
 */

export const Workspace = z.discriminatedUnion("kind", [
  /** No files: conversation and read-only tools only. */
  z.object({ kind: z.literal("none") }),
  /** A self-contained `git clone --local` of `source`, owned by the task. */
  z.object({
    kind: z.literal("clone"),
    source: z.string(),
    ref: z.string().optional(),
  }),
]);
export type Workspace = z.infer<typeof Workspace>;

export const Budget = z.object({
  maxModelCalls: z.number().int().positive().optional(),
  maxCostUsd: z.number().positive().optional(),
});
export type Budget = z.infer<typeof Budget>;

export const Grant = z.object({
  workspace: Workspace,
  /** Whether sandboxed tool processes may reach the network. */
  network: z.boolean(),
  /** Names of privileged tools (push, open PR, send message) the task may call. */
  privilegedTools: z.array(z.string()),
  budget: Budget,
});
export type Grant = z.infer<typeof Grant>;

/** Where a task or an input came from. `externalId` is the connector's dedupe key. */
export const TriggerRef = z.object({
  source: z.string(),
  externalId: z.string().optional(),
  url: z.string().optional(),
});
export type TriggerRef = z.infer<typeof TriggerRef>;
