import type { Database } from "bun:sqlite";
import { applyEvent, createState, foldEvents, statusOf, type TaskState } from "@warren/core";
import {
  EVENT_VERSIONS,
  type EventDraft,
  type EventOf,
  parseEvent,
  type TaskEvent,
  TaskEvent as TaskEventSchema,
  type TaskStatus,
  type TaskSummary,
} from "@warren/protocol";

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** An event with its position in the global order across all tasks. */
export interface StoredEvent {
  id: number;
  event: TaskEvent;
}

export class UnknownTaskError extends Error {
  override name = "UnknownTaskError";
}

interface EventRow {
  id: number;
  task_id: string;
  seq: number;
  type: string;
  v: number;
  at: number;
  data: string;
}

interface TaskRow {
  id: string;
  title: string;
  status: string;
  trigger_source: string;
  created_at: number;
  updated_at: number;
  last_seq: number;
}

/**
 * The only writer of task logs.
 *
 * Every append is checked by folding the new events onto the task's current state; an event
 * that breaks the log's rules throws and the whole append rolls back. The `tasks` row is a
 * projection of the log for listing, updated in the same transaction.
 *
 * The daemon must be the only process that opens the database for writing, which lets this
 * class keep folded states in memory.
 */
export class TaskStore {
  private readonly states = new Map<string, TaskState>();

  constructor(
    private readonly db: Database,
    private readonly clock: Clock = systemClock,
    /** Called after every committed write with its events, to wake streams and notify. */
    private readonly onCommit: (events: TaskEvent[]) => void = () => {},
  ) {}

  create(taskId: string, data: EventOf<"task.created">["data"]): TaskState {
    const created = this.db.transaction(() => {
      const event = this.build(taskId, 0, { type: "task.created", data });
      const state = createState(event);
      this.db
        .query(
          `INSERT INTO tasks (id, title, status, trigger_source, created_at, updated_at, last_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          state.id,
          state.title,
          statusOf(state),
          state.trigger.source,
          state.createdAt,
          state.updatedAt,
          state.lastSeq,
        );
      this.insert(event);
      this.states.set(taskId, state);
      return { state, event };
    })();
    this.onCommit([created.event]);
    return created.state;
  }

  /** Appends events in order and returns the task's new state. All or nothing. */
  append(taskId: string, drafts: readonly EventDraft[]): TaskState {
    if (drafts.length === 0) return this.require(taskId);
    let state: TaskState;
    const committed: TaskEvent[] = [];
    try {
      state = this.db.transaction(() => {
        const current = this.require(taskId);
        for (const draft of drafts) {
          const event = this.build(taskId, current.lastSeq + 1, draft);
          applyEvent(current, event);
          this.insert(event);
          committed.push(event);
        }
        this.db
          .query("UPDATE tasks SET status = ?, updated_at = ?, last_seq = ? WHERE id = ?")
          .run(statusOf(current), current.updatedAt, current.lastSeq, taskId);
        return current;
      })();
    } catch (error) {
      // The cached state may hold part of a rolled-back append; the next read refolds it.
      this.states.delete(taskId);
      throw error;
    }
    this.onCommit(committed);
    return state;
  }

  /**
   * Removes a task and its whole log. Events are never edited, but a person may drop a task
   * entirely; nothing of it stays. The caller makes sure no loop is still writing to it.
   */
  delete(taskId: string): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM events WHERE task_id = ?").run(taskId);
      this.db.query("DELETE FROM tasks WHERE id = ?").run(taskId);
    })();
    this.states.delete(taskId);
  }

  /** Resolves a full id, or a unique suffix of one as the CLI shows it. */
  resolveId(idOrSuffix: string): string | undefined {
    const exact = this.db.query<{ id: string }, [string]>("SELECT id FROM tasks WHERE id = ?");
    if (exact.get(idOrSuffix)) return idOrSuffix;
    if (!/^[0-9a-f-]{4,}$/i.test(idOrSuffix)) return undefined;
    const matches = this.db
      .query<{ id: string }, [string]>("SELECT id FROM tasks WHERE id LIKE ? LIMIT 2")
      .all(`%${idOrSuffix}`);
    return matches.length === 1 ? matches[0]?.id : undefined;
  }

  /** The task's current state, or undefined if no such task exists. */
  get(taskId: string): TaskState | undefined {
    const cached = this.states.get(taskId);
    if (cached) return cached;
    const events = this.events(taskId);
    if (events.length === 0) return undefined;
    const state = foldEvents(events);
    this.states.set(taskId, state);
    return state;
  }

  /** The task's events with `seq` greater than `afterSeq`, in order. */
  events(taskId: string, afterSeq = -1): TaskEvent[] {
    return this.db
      .query<EventRow, [string, number]>(
        "SELECT * FROM events WHERE task_id = ? AND seq > ? ORDER BY seq",
      )
      .all(taskId, afterSeq)
      .map(toEvent);
  }

  /** The global position of the latest event; streams start after it. */
  latestEventId(): number {
    return (
      this.db.query<{ id: number | null }, []>("SELECT max(id) AS id FROM events").get()?.id ?? 0
    );
  }

  /** Events of all tasks after a global position, for streaming to clients. */
  eventsSince(afterId: number, limit = 500): StoredEvent[] {
    return this.db
      .query<EventRow, [number, number]>("SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?")
      .all(afterId, limit)
      .map((row) => ({ id: row.id, event: toEvent(row) }));
  }

  list(options: { status?: readonly TaskStatus[]; limit?: number } = {}): TaskSummary[] {
    const { status, limit = 100 } = options;
    const filter = status?.length ? `WHERE status IN (${status.map(() => "?").join(", ")})` : "";
    return this.db
      .query<TaskRow, (string | number)[]>(
        `SELECT * FROM tasks ${filter} ORDER BY updated_at DESC, id DESC LIMIT ?`,
      )
      .all(...(status ?? []), limit)
      .map((row) => ({
        id: row.id,
        title: row.title,
        status: row.status as TaskStatus,
        triggerSource: row.trigger_source,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastSeq: row.last_seq,
      }));
  }

  private require(taskId: string): TaskState {
    const state = this.get(taskId);
    if (!state) throw new UnknownTaskError(`no task ${taskId}`);
    return state;
  }

  private build(taskId: string, seq: number, draft: EventDraft): TaskEvent {
    // Validates writer input too: a bad model response fails here, not on the next read.
    return TaskEventSchema.parse({
      type: draft.type,
      v: EVENT_VERSIONS[draft.type],
      taskId,
      seq,
      at: this.clock.now(),
      data: draft.data,
    });
  }

  private insert(event: TaskEvent): void {
    this.db
      .query("INSERT INTO events (task_id, seq, type, v, at, data) VALUES (?, ?, ?, ?, ?, ?)")
      .run(event.taskId, event.seq, event.type, event.v, event.at, JSON.stringify(event.data));
  }
}

function toEvent(row: EventRow): TaskEvent {
  return parseEvent({
    type: row.type,
    v: row.v,
    taskId: row.task_id,
    seq: row.seq,
    at: row.at,
    data: JSON.parse(row.data),
  });
}
