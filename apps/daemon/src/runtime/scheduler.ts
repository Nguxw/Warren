import { type LoopDeps, runTask } from "@warren/core";
import type { TaskStore } from "../store/task-store.ts";
import type { Workspaces } from "./workspace.ts";

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export const stderrLogger: Logger = {
  info: (message, fields) => write("info", message, fields),
  error: (message, fields) => write("error", message, fields),
};

function write(level: string, message: string, fields?: Record<string, unknown>) {
  console.error(JSON.stringify({ at: new Date().toISOString(), level, message, ...fields }));
}

/**
 * Runs task loops in the daemon process, at most `concurrency` at a time.
 *
 * `wake` is the only way work starts. Waking a running task makes its loop look again once the
 * current pass ends, so an input that arrives mid-step is never missed. Each task has its own
 * abort signal: pausing or cancelling interrupts the step in progress, and the log decides what
 * happens to it on the next run.
 */
export class Scheduler {
  private readonly running = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  private readonly again = new Set<string>();
  private readonly queue: string[] = [];
  /** Tasks being deleted: never started again. */
  private readonly released = new Set<string>();
  private stopped = false;

  constructor(
    private readonly options: {
      store: TaskStore;
      workspaces: Workspaces;
      loop: Omit<LoopDeps, "log" | "workspaceOf" | "scratchOf">;
      concurrency: number;
      logger?: Logger;
    },
  ) {}

  private get logger(): Logger {
    return this.options.logger ?? stderrLogger;
  }

  wake(taskId: string): void {
    if (this.stopped || this.released.has(taskId)) return;
    if (this.running.has(taskId)) {
      this.again.add(taskId);
      return;
    }
    if (this.queue.includes(taskId)) return;
    if (this.running.size >= this.options.concurrency) {
      this.queue.push(taskId);
      return;
    }
    this.start(taskId);
  }

  /** Changes how many loops run at once; queued tasks start if there is now room. */
  setConcurrency(concurrency: number): void {
    this.options.concurrency = concurrency;
    while (!this.stopped && this.running.size < concurrency) {
      const next = this.queue.shift();
      if (next === undefined) break;
      this.start(next);
    }
  }

  /**
   * Stops a task for good, before it is deleted: drops it from the queue, interrupts its step and
   * waits until its loop has returned, so nothing writes to it afterwards.
   */
  async release(taskId: string): Promise<void> {
    this.released.add(taskId);
    const queued = this.queue.indexOf(taskId);
    if (queued >= 0) this.queue.splice(queued, 1);
    this.again.delete(taskId);
    const running = this.running.get(taskId);
    if (!running) return;
    running.controller.abort();
    await running.done;
    this.again.delete(taskId);
  }

  /** Stops the step a task is taking now, for pause and cancel. */
  interrupt(taskId: string): void {
    this.running.get(taskId)?.controller.abort();
  }

  /** Wakes every task that has work to do, after a start or restart. */
  resumeAll(): void {
    for (const task of this.options.store.list({ status: ["active"], limit: 10_000 })) {
      this.wake(task.id);
    }
  }

  isRunning(taskId: string): boolean {
    return this.running.has(taskId);
  }

  async idle(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.allSettled([...this.running.values()].map((r) => r.done));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.queue.length = 0;
    for (const { controller } of this.running.values()) controller.abort();
    await this.idle();
  }

  private start(taskId: string): void {
    const controller = new AbortController();
    const done = this.drive(taskId, controller.signal).finally(() => {
      this.running.delete(taskId);
      // A wake that arrived while an interrupted loop was winding down still counts.
      const wokenMeanwhile = this.again.delete(taskId);
      if (this.stopped) return;
      const next = wokenMeanwhile && !this.released.has(taskId) ? taskId : this.queue.shift();
      if (next !== undefined) this.start(next);
    });
    this.running.set(taskId, { controller, done });
  }

  private async drive(taskId: string, signal: AbortSignal): Promise<void> {
    const { store, workspaces, loop } = this.options;
    try {
      const state = store.get(taskId);
      if (!state) return;
      try {
        await workspaces.prepare(state, signal);
      } catch (error) {
        if (signal.aborted) return;
        store.append(taskId, [
          { type: "task.ended", data: { outcome: "failed", summary: `Workspace: ${text(error)}` } },
        ]);
        return;
      }
      do {
        this.again.delete(taskId);
        const step = await runTask(
          taskId,
          {
            ...loop,
            log: store,
            workspaceOf: (id) => workspaces.pathOf(id),
            scratchOf: (id) => workspaces.scratchOf(id),
          },
          signal,
        );
        this.logger.info("task stopped", { taskId, step: step.kind });
      } while (this.again.has(taskId) && !signal.aborted);
    } catch (error) {
      if (signal.aborted) return;
      // A bug, not a model or tool failure: park the task where a person will see it.
      this.logger.error("task loop crashed", { taskId, error: text(error) });
      try {
        store.append(taskId, [
          { type: "task.paused", data: { reason: `Internal error: ${text(error)}` } },
        ]);
      } catch (inner) {
        this.logger.error("could not pause task", { taskId, error: text(inner) });
      }
    }
  }
}

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
