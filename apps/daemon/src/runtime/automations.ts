import type { Database } from "bun:sqlite";
import { dueRun, nextRun } from "@warren/core";
import {
  type Automation,
  type AutomationPatch,
  AutomationSpec,
  automationTrigger,
} from "@warren/protocol";
import type { Config } from "../config/config.ts";
import type { AutomationStore, StoredAutomation } from "../store/automation-store.ts";
import type { TaskStore } from "../store/task-store.ts";
import { checkFolder, type FolderRules } from "./folders.ts";
import type { Logger } from "./scheduler.ts";
import { TaskRequestError, taskData } from "./tasks.ts";

/** No automation with that id. */
export class UnknownAutomationError extends Error {}

/**
 * Starts automations' tasks on their schedules.
 *
 * - **Due:** the latest scheduled time since the previous run (or since the schedule was set).
 *   Runs missed while the computer slept or Warren was not running collapse into one.
 * - **No overlap:** while the previous run's task has not ended, a due run is skipped, and the
 *   skip is recorded with its reason.
 * - **Once:** the task and the record of the run are written in one transaction, and the task's
 *   trigger names the automation and the scheduled time; a crash cannot start a run twice.
 */
export class AutomationRunner {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly deps: {
      db: Database;
      automations: AutomationStore;
      tasks: TaskStore;
      config: Config;
      folders: FolderRules;
      newId(): string;
      now(): number;
      /** Starts a created task's loop. */
      wake(taskId: string): void;
      logger: Logger;
    },
  ) {}

  /** Checks for due runs now and then every `intervalMs`. */
  start(intervalMs = 30_000): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Starts every run that is due; returns the ids of the tasks started. */
  tick(): string[] {
    const now = this.deps.now();
    const started: string[] = [];
    for (const automation of this.deps.automations.list()) {
      if (!automation.enabled) continue;
      const due = dueRun(automation.schedule, sinceOf(automation), now);
      if (due === undefined) continue;
      const taskId = this.run(automation, due);
      if (taskId) started.push(taskId);
    }
    return started;
  }

  /** Runs an automation now, whatever its schedule, paused or not. */
  runNow(id: string): string | undefined {
    return this.run(this.require(id), this.deps.now(), true);
  }

  list(): Automation[] {
    return this.deps.automations.list().map((a) => this.view(a));
  }

  create(spec: AutomationSpec): Automation {
    const checked = this.check(spec);
    return this.view(this.deps.automations.create(this.deps.newId(), checked, this.deps.now()));
  }

  update(id: string, patch: AutomationPatch): Automation {
    const current = this.require(id);
    const { enabled = current.enabled, ...change } = patch;
    const spec = this.check(AutomationSpec.parse({ ...specOf(current), ...change }));
    // A new schedule, or turning it back on, counts from now: no run for times already past.
    const restart =
      (enabled && !current.enabled) ||
      JSON.stringify(spec.schedule) !== JSON.stringify(current.schedule);
    const now = this.deps.now();
    return this.view(
      this.deps.automations.update(
        id,
        { spec, enabled, anchor: restart ? now : current.anchor },
        now,
      ),
    );
  }

  delete(id: string): void {
    if (!this.deps.automations.delete(id)) throw new UnknownAutomationError(`no automation ${id}`);
  }

  private run(automation: StoredAutomation, at: number, byHand = false): string | undefined {
    const { db, tasks, automations, logger } = this.deps;
    const previous = automation.lastRun?.taskId ? tasks.get(automation.lastRun.taskId) : undefined;
    if (previous && !previous.ended) {
      if (byHand) throw new TaskRequestError("the previous run is still going");
      automations.recordRun(automation.id, {
        at,
        status: "skipped",
        taskId: previous.id,
        reason: "the previous run is still going",
      });
      logger.info("automation skipped", { automationId: automation.id, reason: "overlap" });
      return undefined;
    }
    const taskId = this.deps.newId();
    try {
      db.transaction(() => {
        tasks.create(
          taskId,
          taskData(
            {
              instruction: automation.instruction,
              title: automation.name,
              ...(automation.repo && { repo: automation.repo }),
              ...(automation.outputDir && { outputDir: automation.outputDir }),
              ...(automation.modelRole && { modelRole: automation.modelRole }),
              ...(automation.network !== undefined && { network: automation.network }),
            },
            automationTrigger(automation.id, at),
            this.deps,
          ),
        );
        automations.recordRun(automation.id, { at, status: "started", taskId });
      })();
    } catch (error) {
      // A folder that is gone, a model role removed: the run cannot start, and says why.
      const reason = error instanceof Error ? error.message : String(error);
      if (byHand) throw error;
      automations.recordRun(automation.id, { at, status: "skipped", reason });
      logger.error("automation could not start", { automationId: automation.id, reason });
      return undefined;
    }
    logger.info("automation started", { automationId: automation.id, taskId });
    this.deps.wake(taskId);
    return taskId;
  }

  /**
   * The folders and model role an automation names must be usable, as for a task. An empty
   * folder means none, which is how an edit clears one.
   */
  private check(spec: AutomationSpec): AutomationSpec {
    const { config, folders } = this.deps;
    const role = spec.modelRole ?? "main";
    if (!config.models[role]) {
      throw new TaskRequestError(`unknown model role "${role}"`);
    }
    const { repo, outputDir, ...rest } = spec;
    return {
      ...rest,
      ...(repo && { repo: checkFolder(repo, folders) }),
      ...(outputDir && { outputDir: checkFolder(outputDir, folders) }),
    };
  }

  private view(automation: StoredAutomation): Automation {
    const { anchor, ...rest } = automation;
    return {
      ...rest,
      ...(automation.enabled && { nextRunAt: nextRun(automation.schedule, sinceOf(automation)) }),
    };
  }

  /** By full id, or by a unique suffix of one as the CLI shows it. */
  private require(id: string): StoredAutomation {
    const automation =
      this.deps.automations.get(id) ??
      ((matches) => (matches.length === 1 ? matches[0] : undefined))(
        id.length >= 4 ? this.deps.automations.list().filter((a) => a.id.endsWith(id)) : [],
      );
    if (!automation) throw new UnknownAutomationError(`no automation ${id}`);
    return automation;
  }
}

/** The time the schedule counts from: the previous run, or when the schedule was set. */
function sinceOf(automation: StoredAutomation): number {
  return Math.max(automation.anchor, automation.lastRun?.at ?? 0);
}

function specOf(automation: StoredAutomation): AutomationSpec {
  return AutomationSpec.parse(automation);
}
