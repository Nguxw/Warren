import { createHmac, timingSafeEqual } from "node:crypto";
import type { TriggerEvent } from "@warren/protocol";

/**
 * GitHub as a source of work.
 *
 * Events arrive two ways: webhooks (immediate, through a tunnel to this machine) and reconcile
 * polls (catch-up after sleep or a dropped tunnel). Both are normalised here into TriggerEvents
 * whose `externalId` depends only on what happened, never on how it arrived, so the store's
 * unique key turns the overlap into a no-op.
 */

// biome-ignore lint/suspicious/noExplicitAny: GitHub payloads are read loosely and normalised here.
type Json = Record<string, any>;

const thread = (repo: string, number: number) => `github:${repo}#${number}`;
const time = (iso: unknown) => (typeof iso === "string" ? Date.parse(iso) : Date.now());

// ------------------------------------------------------------------ webhooks

/** Checks `X-Hub-Signature-256` against the raw body. */
export function verifySignature(secret: string, body: string, header: string | null): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** The events a webhook delivery carries; most deliveries carry none Warren cares about. */
export function fromWebhook(name: string, payload: Json): TriggerEvent[] {
  const repo: string | undefined = payload.repository?.full_name;
  if (!repo) return [];

  if (name === "issue_comment" && payload.action === "created") {
    return [comment(repo, payload.issue, payload.comment, "comment")];
  }
  if (name === "pull_request_review_comment" && payload.action === "created") {
    return [comment(repo, payload.pull_request, payload.comment, "review-comment")];
  }
  if (name === "issues" && payload.action === "opened") {
    return [opened(repo, payload.issue)];
  }
  if (name === "issues" && payload.action === "labeled" && payload.label?.name) {
    return [labeled(repo, payload.issue, payload.label.name, payload.sender?.login, Date.now())];
  }
  if (
    name === "workflow_run" &&
    payload.action === "completed" &&
    payload.workflow_run?.conclusion === "failure"
  ) {
    return [failedRun(repo, payload.workflow_run)];
  }
  return [];
}

function comment(repo: string, issue: Json, body: Json, prefix: string): TriggerEvent {
  return {
    source: "github",
    externalId: `${prefix}:${body.id}`,
    kind: "comment",
    repo,
    thread: thread(repo, issue.number),
    actor: body.user?.login,
    ...(issue.title && { title: issue.title }),
    body: body.body ?? "",
    url: body.html_url,
    at: time(body.created_at),
  };
}

function opened(repo: string, issue: Json): TriggerEvent {
  return {
    source: "github",
    externalId: `opened:${repo}#${issue.number}`,
    kind: "issue_opened",
    repo,
    thread: thread(repo, issue.number),
    actor: issue.user?.login,
    title: issue.title,
    body: issue.body ?? "",
    url: issue.html_url,
    at: time(issue.created_at),
  };
}

function labeled(
  repo: string,
  issue: Json,
  label: string,
  actor: string | undefined,
  at: number,
): TriggerEvent {
  return {
    source: "github",
    externalId: `labeled:${repo}#${issue.number}:${label}`,
    kind: "issue_labeled",
    repo,
    thread: thread(repo, issue.number),
    ...(actor && { actor }),
    title: issue.title,
    body: issue.body ?? "",
    url: issue.html_url,
    label,
    at,
  };
}

function failedRun(repo: string, run: Json): TriggerEvent {
  return {
    source: "github",
    externalId: `run:${run.id}`,
    kind: "ci_failed",
    repo,
    thread: `github:${repo}@${run.head_branch}`,
    title: run.name,
    url: run.html_url,
    branch: run.head_branch,
    at: time(run.updated_at ?? run.created_at),
  };
}

// ------------------------------------------------------------------ REST

export class GitHubClient {
  constructor(
    private readonly token: string,
    private readonly apiBase = "https://api.github.com",
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "warren-agent",
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await res.json().catch(() => ({}))) as T & { message?: string };
    if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${json.message ?? ""}`);
    return json;
  }

  /** The account the token belongs to: Warren's own login, whose messages it ignores. */
  async login(): Promise<string> {
    return (await this.request<{ login: string }>("GET", "/user")).login;
  }

  async comment(repo: string, issue: number, body: string): Promise<void> {
    await this.request("POST", `/repos/${repo}/issues/${issue}/comments`, { body });
  }

  /**
   * Everything that happened in a repository since `since`, as TriggerEvents: conversation
   * comments, opened issues, labels applied, and failed workflow runs.
   */
  async reconcile(repo: string, since: number): Promise<TriggerEvent[]> {
    const iso = new Date(since).toISOString();
    const [comments, issues, issueEvents, runs] = await Promise.all([
      this.request<Json[]>(
        "GET",
        `/repos/${repo}/issues/comments?since=${iso}&per_page=100&sort=created`,
      ),
      this.request<Json[]>("GET", `/repos/${repo}/issues?since=${iso}&state=all&per_page=50`),
      this.request<Json[]>("GET", `/repos/${repo}/issues/events?per_page=100`),
      this.request<{ workflow_runs: Json[] }>(
        "GET",
        `/repos/${repo}/actions/runs?status=failure&per_page=20`,
      ),
    ]);
    const events: TriggerEvent[] = [];
    for (const c of comments) {
      const number = Number(
        String(c.issue_url ?? "")
          .split("/")
          .pop(),
      );
      if (time(c.created_at) >= since && number) {
        events.push(comment(repo, { number }, c, "comment"));
      }
    }
    for (const issue of issues) {
      if (!issue.pull_request && time(issue.created_at) >= since) events.push(opened(repo, issue));
    }
    for (const e of issueEvents) {
      if (e.event === "labeled" && e.issue && time(e.created_at) >= since) {
        events.push(
          labeled(repo, e.issue, e.label?.name ?? "", e.actor?.login, time(e.created_at)),
        );
      }
    }
    for (const run of runs.workflow_runs ?? []) {
      if (time(run.updated_at ?? run.created_at) >= since) events.push(failedRun(repo, run));
    }
    return events.sort((a, b) => a.at - b.at);
  }
}

/** `github:owner/name#12` → repository and issue number, or undefined for other threads. */
export function parseIssueThread(thread: string): { repo: string; number: number } | undefined {
  const match = /^github:([^#@]+)#(\d+)$/.exec(thread);
  return match?.[1] && match[2] ? { repo: match[1], number: Number(match[2]) } : undefined;
}
