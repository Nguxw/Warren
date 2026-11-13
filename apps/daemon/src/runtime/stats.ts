import type { TaskState } from "@warren/core";
import type { TriggerRecord } from "@warren/protocol";

/**
 * What Warren's record says about how well it works: outcomes, cost and time per task, how often
 * it needed a person, and what came in from connectors. Computed from the logs on request.
 */
export interface Stats {
  tasks: {
    total: number;
    open: number;
    completed: number;
    failed: number;
    cancelled: number;
    /** Completed among tasks that ended other than by cancellation. */
    successRate: number | null;
  };
  perEndedTask: {
    medianCostUsd: number | null;
    medianDurationMs: number | null;
    meanModelCalls: number | null;
    /** Questions and approvals per task: the attention it cost. */
    meanInterruptions: number | null;
  };
  usage: {
    costUsd: number;
    modelCalls: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    /** Share of input tokens served from the provider's prompt cache. */
    cacheHitRate: number | null;
    compactions: number;
  };
  triggers: {
    total: number;
    byDecision: Record<string, number>;
    /** Work that observe-mode rules would have started. */
    observed: number;
  };
}

export function computeStats(
  states: readonly TaskState[],
  triggers: readonly TriggerRecord[],
): Stats {
  const ended = states.filter((s) => s.ended);
  const count = (outcome: string) => ended.filter((s) => s.ended?.outcome === outcome).length;
  const completed = count("completed");
  const failed = count("failed");
  const decided = completed + failed;

  const usage = {
    costUsd: 0,
    modelCalls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    compactions: 0,
  };
  for (const s of states) {
    usage.costUsd += s.usage.costUsd;
    usage.modelCalls += s.usage.modelCalls;
    usage.inputTokens += s.usage.inputTokens;
    usage.cachedInputTokens += s.usage.cachedInputTokens;
    usage.outputTokens += s.usage.outputTokens;
    usage.compactions += s.compactions;
  }

  const byDecision: Record<string, number> = {};
  for (const t of triggers)
    byDecision[t.decision.action] = (byDecision[t.decision.action] ?? 0) + 1;

  return {
    tasks: {
      total: states.length,
      open: states.length - ended.length,
      completed,
      failed,
      cancelled: count("cancelled"),
      successRate: decided > 0 ? completed / decided : null,
    },
    perEndedTask: {
      medianCostUsd: median(ended.map((s) => s.usage.costUsd)),
      medianDurationMs: median(ended.map((s) => (s.ended?.at ?? s.updatedAt) - s.createdAt)),
      meanModelCalls: mean(ended.map((s) => s.usage.modelCalls)),
      meanInterruptions: mean(ended.map((s) => s.asked.questions + s.asked.approvals)),
    },
    usage: {
      ...usage,
      cacheHitRate: usage.inputTokens > 0 ? usage.cachedInputTokens / usage.inputTokens : null,
    },
    triggers: { total: triggers.length, byDecision, observed: byDecision.observe ?? 0 },
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}
