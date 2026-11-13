import type { Database } from "bun:sqlite";
import { type RouteDecision, TriggerEvent, type TriggerRecord } from "@warren/protocol";

interface Row {
  id: number;
  event: string;
  decision: string;
  task_id: string | null;
  received_at: number;
}

/** Trigger events with their routing decisions, and connector cursors. */
export class TriggerStore {
  constructor(private readonly db: Database) {}

  has(source: string, externalId: string): boolean {
    return Boolean(
      this.db
        .query("SELECT 1 FROM trigger_events WHERE source = ? AND external_id = ?")
        .get(source, externalId),
    );
  }

  record(
    event: TriggerEvent,
    decision: RouteDecision,
    receivedAt: number,
    taskId?: string,
  ): number {
    const result = this.db
      .query(
        `INSERT INTO trigger_events (source, external_id, event, decision, task_id, received_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.source,
        event.externalId,
        JSON.stringify(event),
        JSON.stringify(decision),
        taskId ?? null,
        receivedAt,
      );
    return Number(result.lastInsertRowid);
  }

  list(limit = 100): TriggerRecord[] {
    return this.db
      .query<Row, [number]>("SELECT * FROM trigger_events ORDER BY id DESC LIMIT ?")
      .all(limit)
      .map((row) => ({
        id: row.id,
        event: TriggerEvent.parse(JSON.parse(row.event)),
        decision: JSON.parse(row.decision) as RouteDecision,
        ...(row.task_id && { taskId: row.task_id }),
        receivedAt: row.received_at,
      }));
  }

  cursor(name: string): string | undefined {
    return this.db
      .query<{ value: string }, [string]>("SELECT value FROM cursors WHERE name = ?")
      .get(name)?.value;
  }

  setCursor(name: string, value: string): void {
    this.db
      .query(
        "INSERT INTO cursors (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value",
      )
      .run(name, value);
  }
}
