import type { RouteDecision, RuleMode, TaskStatus, TriggerEvent } from "@warren/protocol";

/**
 * Routing: what an event from outside means for Warren. A pure function of the event, the
 * configuration and the tasks already following its conversation.
 *
 * Two kinds of start, as in DeepSeek's Super-Agent:
 * - explicit: a person on the allowed list asks (mentions the handle, or applies the label);
 * - inferred: Warren notices something it could fix (CI failing on the default branch).
 * Every rule has a mode: `off` ignores it, `observe` records what would have started without
 * starting it, `auto` starts it. Inferred rules start in `observe`, so their precision can be
 * judged from the record before they are trusted.
 */

export interface RepoRouting {
  rules: { mention: RuleMode; label: RuleMode; ciFailure: RuleMode };
  /** The label that asks Warren to take an issue. */
  label: string;
  defaultBranch: string;
}

export interface RoutingConfig {
  /** How people address Warren in comments, such as `@warren`. */
  handle: string;
  allowedActors: readonly string[];
  /** Warren's own account; its messages never start or feed work. */
  botLogin?: string;
  /** Hidden text in every message Warren posts, the second guard against answering itself. */
  marker: string;
  repos: Readonly<Record<string, RepoRouting>>;
}

export interface FollowingTask {
  id: string;
  status: TaskStatus;
  /** An open question the next human reply answers. */
  questionId?: string;
}

const MAX_CONTEXT = 4000;

export function route(
  event: TriggerEvent,
  config: RoutingConfig,
  following: readonly FollowingTask[],
): RouteDecision {
  const ignore = (reason: string): RouteDecision => ({ action: "ignore", reason });

  if (
    event.actor &&
    config.botLogin &&
    event.actor.toLowerCase() === config.botLogin.toLowerCase()
  ) {
    return ignore("own message");
  }
  if (event.body?.includes(config.marker)) return ignore("own message");

  const repo = config.repos[event.repo];
  if (!repo) return ignore(`repository ${event.repo} is not configured`);

  const allowed =
    event.actor !== undefined &&
    config.allowedActors.some((actor) => actor.toLowerCase() === event.actor?.toLowerCase());

  // A reply in a conversation that a live task follows belongs to that task.
  const live = following.find((task) => task.status !== "ended");
  if (event.kind === "comment" && live) {
    if (!allowed) return ignore(`@${event.actor ?? "?"} is not on the allowed list`);
    const text = withoutHandle(event.body ?? "", config.handle);
    if (!text) return ignore("empty reply");
    return live.questionId
      ? { action: "answer", taskId: live.id, attentionId: live.questionId, text }
      : { action: "append", taskId: live.id, text };
  }

  if (event.kind === "comment" || event.kind === "issue_opened") {
    if (!mentions(event.body ?? "", config.handle)) return ignore("does not address Warren");
    if (!allowed) return ignore(`@${event.actor ?? "?"} is not on the allowed list`);
    const request = withoutHandle(event.body ?? "", config.handle);
    return apply(repo.rules.mention, "mention", {
      title: event.title ? `${event.title}` : request.slice(0, 72),
      instruction: describe(event, `Request from @${event.actor}:\n${request}`),
    });
  }

  if (event.kind === "issue_labeled") {
    if (event.label?.toLowerCase() !== repo.label.toLowerCase()) return ignore("other label");
    if (!allowed) return ignore(`@${event.actor ?? "?"} is not on the allowed list`);
    return apply(repo.rules.label, "label", {
      title: event.title ?? event.url,
      instruction: describe(event, `@${event.actor} labelled this issue "${repo.label}" for you.`),
    });
  }

  if (event.kind === "ci_failed") {
    if (event.branch !== repo.defaultBranch)
      return ignore(`CI on ${event.branch ?? "?"}, not ${repo.defaultBranch}`);
    if (live) return ignore("a task already follows this failure");
    return apply(repo.rules.ciFailure, "ciFailure", {
      title: `Fix CI: ${event.title ?? "workflow"} on ${event.branch}`,
      instruction: `The CI workflow "${event.title ?? "?"}" failed on ${event.branch} of ${event.repo}: ${event.url}\nReproduce the failure locally, find the cause and fix it. If the cause is outside the repository (an outage, a flaky runner), say so instead of changing code.`,
    });
  }

  return ignore("no rule applies");
}

function apply(
  mode: RuleMode,
  rule: string,
  work: { title: string; instruction: string },
): RouteDecision {
  if (mode === "off") return { action: "ignore", reason: `rule ${rule} is off` };
  if (mode === "observe") {
    return { action: "observe", rule, reason: `rule ${rule} is in observe mode`, ...work };
  }
  return { action: "create", rule, ...work };
}

function describe(event: TriggerEvent, request: string): string {
  const context = event.body && event.kind !== "comment" ? clip(event.body) : undefined;
  return [
    `From GitHub ${event.thread.replace(/^github:/, "")}${event.title ? ` "${event.title}"` : ""}: ${event.url}`,
    request,
    context && `Issue description:\n${context}`,
    "Your questions and final summary are posted back to this conversation.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function mentions(text: string, handle: string): boolean {
  return new RegExp(`(^|\\s)${escapeRegex(handle)}\\b`, "i").test(text);
}

function withoutHandle(text: string, handle: string): string {
  return text.replace(new RegExp(`(^|\\s)${escapeRegex(handle)}\\b[,:]?`, "gi"), " ").trim();
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clip(text: string): string {
  return text.length > MAX_CONTEXT ? `${text.slice(0, MAX_CONTEXT)}…` : text;
}
