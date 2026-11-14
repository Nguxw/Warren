import { z } from "zod";

/**
 * Automations: tasks that start on a schedule, such as a report every morning. Each run is an
 * ordinary task; the automation only says what to do and when.
 */

const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM");

/** When an automation runs, in the computer's local time. */
export const Schedule = z.discriminatedUnion("kind", [
  /** Every day at `time`. */
  z.object({ kind: z.literal("daily"), time: Time }),
  /** On the given weekdays (0 = Sunday) at `time`. */
  z.object({
    kind: z.literal("weekly"),
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    time: Time,
  }),
  /** Every `hours` hours, counted from the previous run. */
  z.object({ kind: z.literal("interval"), hours: z.number().int().min(1).max(168) }),
]);
export type Schedule = z.infer<typeof Schedule>;

/** What an automation does each time: the same fields as a task started by hand. */
export const AutomationSpec = z.object({
  name: z.string().trim().min(1).max(80),
  instruction: z.string().trim().min(1),
  schedule: Schedule,
  /** A folder each run works on (cloned or copied, as for a task). */
  repo: z.string().optional(),
  /** Where each run's files are saved when it completes. */
  outputDir: z.string().optional(),
  modelRole: z.string().optional(),
  network: z.boolean().optional(),
});
export type AutomationSpec = z.infer<typeof AutomationSpec>;

export const AutomationPatch = AutomationSpec.partial().extend({ enabled: z.boolean().optional() });
export type AutomationPatch = z.infer<typeof AutomationPatch>;

/** How the last scheduled run went. */
export type AutomationRunStatus = "started" | "skipped";

/** An automation as the API shows it. */
export interface Automation extends AutomationSpec {
  id: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  /** When it is due next; absent while it is paused. */
  nextRunAt?: number;
  lastRun?: {
    /** The scheduled time of the run (or when it was run by hand). */
    at: number;
    status: AutomationRunStatus;
    taskId?: string;
    /** Why a run was skipped. */
    reason?: string;
  };
}

/** The trigger of a task an automation started: its id and the scheduled time, unique per run. */
export function automationTrigger(automationId: string, at: number) {
  return { source: "automation", externalId: `${automationId}@${at}` } as const;
}

/** The automation a task came from, if any. */
export function automationOf(trigger: { source: string; externalId?: string }): string | undefined {
  if (trigger.source !== "automation" || !trigger.externalId) return undefined;
  return trigger.externalId.split("@")[0];
}
