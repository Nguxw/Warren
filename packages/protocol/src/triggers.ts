import { z } from "zod";

/**
 * An event from outside, normalised by its connector. Whether it arrived by webhook or by a
 * reconcile poll, the same happening gets the same `externalId`, which is how duplicates from
 * the two paths collapse into one.
 */
export const TriggerEvent = z.object({
  source: z.string(),
  externalId: z.string(),
  kind: z.enum(["comment", "issue_opened", "issue_labeled", "ci_failed"]),
  /** `owner/name` for GitHub. */
  repo: z.string(),
  /** The conversation it belongs to, such as `github:owner/name#12`. */
  thread: z.string(),
  actor: z.string().optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  url: z.string(),
  label: z.string().optional(),
  branch: z.string().optional(),
  /** When it happened at the source, epoch ms. */
  at: z.number().int(),
});
export type TriggerEvent = z.infer<typeof TriggerEvent>;

export type RuleMode = "off" | "observe" | "auto";

/** What routing decided for a trigger event. `observe` records work that would have started. */
export type RouteDecision =
  | { action: "ignore"; reason: string }
  | { action: "observe"; rule: string; reason: string; title: string; instruction: string }
  | { action: "create"; rule: string; title: string; instruction: string }
  | { action: "append"; taskId: string; text: string }
  | { action: "answer"; taskId: string; attentionId: string; text: string };

/** A stored trigger event with what was decided and done. */
export interface TriggerRecord {
  id: number;
  event: TriggerEvent;
  decision: RouteDecision;
  taskId?: string;
  receivedAt: number;
}
