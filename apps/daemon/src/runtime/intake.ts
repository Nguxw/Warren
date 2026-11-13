import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { type FollowingTask, type RoutingConfig, route } from "@warren/core";
import type { TriggerEvent, TriggerRecord } from "@warren/protocol";
import type { GitHubConfig } from "../config/config.ts";
import type { TaskStore } from "../store/task-store.ts";
import type { TriggerStore } from "../store/trigger-store.ts";

/**
 * Turns connector events into work. One SQLite transaction covers the dedupe check, the task it
 * creates or feeds, and the record of the decision: a crash can neither lose an event nor start
 * its task twice, and a webhook and a poll of the same event can race without effect.
 */
export class Intake {
  constructor(
    private readonly options: {
      db: Database;
      tasks: TaskStore;
      triggers: TriggerStore;
      github: () => GitHubConfig | undefined;
      botLogin: () => string | undefined;
      newId(): string;
      wake(taskId: string): void;
      now(): number;
    },
  ) {}

  /** Handles one event; undefined when it was seen before. */
  ingest(event: TriggerEvent): TriggerRecord | undefined {
    const { db, tasks, triggers } = this.options;
    const github = this.options.github();
    let woken: string | undefined;
    const record = db.transaction((): TriggerRecord | undefined => {
      if (triggers.has(event.source, event.externalId)) return undefined;
      let decision = route(event, this.routing(github), this.following(event.thread));
      let taskId: string | undefined;

      if (decision.action === "create") {
        const repo = github?.repos[event.repo];
        const source = repo && resolve(repo.path);
        if (!source || !existsSync(join(source, ".git"))) {
          decision = {
            action: "ignore",
            reason: `${repo?.path ?? event.repo} is not a git repository`,
          };
        } else {
          taskId = this.options.newId();
          tasks.create(taskId, {
            title: decision.title,
            instruction: decision.instruction,
            grant: {
              workspace: { kind: "clone", source },
              network: repo.network,
              privilegedTools: ["publish_branch", "open_pull_request"],
              budget: { maxModelCalls: 100 },
            },
            trigger: { source: event.source, externalId: event.externalId, url: event.url },
            follows: [event.thread],
            ...(repo.modelRole && { modelRole: repo.modelRole }),
          });
        }
      } else if (decision.action === "append") {
        taskId = decision.taskId;
        tasks.append(taskId, [
          {
            type: "input.received",
            data: {
              item: {
                type: "message",
                role: "user",
                content: [{ type: "text", text: `@${event.actor}: ${decision.text}` }],
              },
              trigger: { source: event.source, externalId: event.externalId, url: event.url },
            },
          },
        ]);
      } else if (decision.action === "answer") {
        taskId = decision.taskId;
        tasks.append(taskId, [
          {
            type: "attention.resolved",
            data: { attentionId: decision.attentionId, response: decision.text },
          },
        ]);
      }

      const receivedAt = this.options.now();
      const id = triggers.record(event, decision, receivedAt, taskId);
      woken = taskId;
      return { id, event, decision, receivedAt, ...(taskId && { taskId }) };
    })();
    if (woken) this.options.wake(woken);
    return record;
  }

  private routing(github: GitHubConfig | undefined): RoutingConfig {
    const botLogin = github?.botLogin ?? this.options.botLogin();
    return {
      handle: github?.handle ?? "@warren",
      allowedActors: github?.allowedActors ?? [],
      marker: REPLY_MARKER,
      ...(botLogin && { botLogin }),
      repos: Object.fromEntries(
        Object.entries(github?.repos ?? {}).map(([name, repo]) => [
          name,
          { rules: repo.rules, label: repo.label, defaultBranch: repo.defaultBranch },
        ]),
      ),
    };
  }

  /** Tasks following a conversation, newest first, with any question waiting for a reply. */
  private following(thread: string): FollowingTask[] {
    const result: FollowingTask[] = [];
    for (const summary of this.options.tasks.list({ limit: 500 })) {
      const state = this.options.tasks.get(summary.id);
      if (!state?.follows.includes(thread)) continue;
      const question = state.attention.find((a) => a.kind === "question");
      result.push({
        id: state.id,
        status: summary.status,
        ...(question && { questionId: question.attentionId }),
      });
    }
    return result;
  }
}

/** Hidden in every comment Warren posts, so reading it back never starts or feeds work. */
export const REPLY_MARKER = "<!-- warren -->";
