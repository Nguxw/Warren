import { fromWebhook, GitHubClient, parseIssueThread, verifySignature } from "@warren/connectors";
import type { TaskEvent } from "@warren/protocol";
import type { GitHubConfig } from "../config/config.ts";
import type { TaskStore } from "../store/task-store.ts";
import type { TriggerStore } from "../store/trigger-store.ts";
import { type Intake, REPLY_MARKER } from "./intake.ts";
import type { Logger } from "./scheduler.ts";

/**
 * GitHub at run time: webhook ingress, reconcile polls, and replies.
 *
 * - Webhooks give immediacy. They listen on their own port, separate from the control API, so a
 *   tunnel exposes nothing but signed deliveries.
 * - Reconcile polls give completeness: a delivery lost while the laptop slept or the tunnel was
 *   down is found on the next poll, and a wake (a gap much longer than the interval) polls at
 *   once. Both paths meet in the intake's dedupe.
 * - Replies close the loop: a task started from a conversation posts its questions and its
 *   result there, marked so they are never read back as requests.
 */
export class GitHubRuntime {
  private client: GitHubClient | undefined;
  private botLogin: string | undefined;
  private server: ReturnType<typeof Bun.serve> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastTick = 0;
  private polling = false;

  constructor(
    private readonly options: {
      config: GitHubConfig;
      token: string | undefined;
      webhookSecret: string | undefined;
      intake: Intake;
      triggers: TriggerStore;
      tasks: TaskStore;
      logger: Logger;
      now(): number;
    },
  ) {}

  /** Warren's own login, once known; routing ignores its messages. */
  get login(): string | undefined {
    return this.options.config.botLogin ?? this.botLogin;
  }

  get webhookPort(): number | undefined {
    return this.server?.port;
  }

  async start(): Promise<void> {
    const { config, token, logger } = this.options;
    if (token) {
      this.client = new GitHubClient(token, config.apiBase);
      if (!config.botLogin) {
        this.botLogin = await this.client.login().catch((error: unknown) => {
          logger.error("could not read the GitHub account of the token", { error: String(error) });
          return undefined;
        });
      }
    } else {
      logger.error("WARREN_GITHUB_TOKEN is not set: no polling or replies, webhooks only");
    }

    if (config.webhookPort !== undefined) {
      if (!this.options.webhookSecret) {
        logger.error(
          "github.webhookPort is set but WARREN_GITHUB_WEBHOOK_SECRET is not; webhooks stay off",
        );
      } else {
        this.server = Bun.serve({
          hostname: "127.0.0.1",
          port: config.webhookPort,
          fetch: (req) => this.webhook(req),
        });
        logger.info("github webhooks listening", { port: this.server.port });
      }
    }

    if (this.client) {
      const interval = config.pollSeconds * 1000;
      this.lastTick = this.options.now();
      void this.reconcile();
      // Ticks often and polls when due, so a wake from sleep (a long gap) polls at once.
      this.timer = setInterval(
        () => {
          const now = this.options.now();
          if (now - this.lastTick >= interval) void this.reconcile();
        },
        Math.min(interval, 15_000),
      );
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.server?.stop(true);
  }

  private async webhook(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/github")
      return new Response("not found", { status: 404 });
    const body = await req.text();
    if (
      !verifySignature(
        this.options.webhookSecret ?? "",
        body,
        req.headers.get("x-hub-signature-256"),
      )
    ) {
      return new Response("bad signature", { status: 401 });
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body);
    } catch {
      return new Response("bad json", { status: 400 });
    }
    const events = fromWebhook(req.headers.get("x-github-event") ?? "", payload);
    for (const event of events) this.options.intake.ingest(event);
    return new Response(null, { status: 202 });
  }

  /** Polls every configured repository from its cursor. Safe to call at any time. */
  async reconcile(): Promise<void> {
    if (!this.client || this.polling) return;
    this.polling = true;
    const started = this.options.now();
    this.lastTick = started;
    try {
      for (const repo of Object.keys(this.options.config.repos)) {
        const name = `github:${repo}`;
        const saved = this.options.triggers.cursor(name);
        // The first poll starts from now: Warren takes new requests, not the repository's past.
        const since = saved ? Number(saved) : started;
        try {
          for (const event of await this.client.reconcile(repo, since))
            this.options.intake.ingest(event);
          // Overlap a minute: late-indexed items are caught, and the dedupe drops repeats.
          this.options.triggers.setCursor(name, String(started - 60_000));
        } catch (error) {
          this.options.logger.error("github reconcile failed", { repo, error: String(error) });
        }
      }
    } finally {
      this.polling = false;
    }
  }

  /** Posts a task's questions and its result to the conversation it came from. */
  onCommit(events: readonly TaskEvent[]): void {
    if (!this.client) return;
    for (const event of events) {
      let text: string | undefined;
      if (event.type === "attention.requested" && event.data.kind === "question") {
        text = `**Warren has a question:**\n\n${event.data.prompt}\n\n_Reply in this conversation to answer._`;
      } else if (event.type === "task.ended") {
        const verb = { completed: "finished", failed: "could not finish", cancelled: "stopped" }[
          event.data.outcome
        ];
        text = `**Warren ${verb} this task.**${event.data.summary ? `\n\n${event.data.summary}` : ""}`;
      }
      if (!text) continue;
      const state = this.options.tasks.get(event.taskId);
      for (const thread of state?.follows ?? []) {
        const issue = parseIssueThread(thread);
        if (issue) void this.post(issue.repo, issue.number, `${REPLY_MARKER}\n${text}`);
      }
    }
  }

  private async post(repo: string, issue: number, body: string): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.client?.comment(repo, issue, body);
        return;
      } catch (error) {
        if (attempt === 3) {
          this.options.logger.error("could not reply on GitHub", {
            repo,
            issue,
            error: String(error),
          });
        } else {
          await Bun.sleep(1000 * 2 ** attempt);
        }
      }
    }
  }
}
