import type { Database } from "bun:sqlite";
import { type Automation, AutomationSpec } from "@warren/protocol";

interface Row {
  id: string;
  spec: string;
  enabled: number;
  anchor: number;
  created_at: number;
  updated_at: number;
  last_run: string | null;
}

/** An automation as stored: its spec, state and the time its schedule counts from. */
export interface StoredAutomation extends Omit<Automation, "nextRunAt"> {
  anchor: number;
}

export type AutomationRun = NonNullable<Automation["lastRun"]>;

export class AutomationStore {
  constructor(private readonly db: Database) {}

  list(): StoredAutomation[] {
    return this.db
      .query<Row, []>("SELECT * FROM automations ORDER BY created_at")
      .all()
      .map(fromRow);
  }

  get(id: string): StoredAutomation | undefined {
    const row = this.db.query<Row, [string]>("SELECT * FROM automations WHERE id = ?").get(id);
    return row ? fromRow(row) : undefined;
  }

  create(id: string, spec: AutomationSpec, now: number): StoredAutomation {
    this.db
      .query(
        "INSERT INTO automations (id, spec, enabled, anchor, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)",
      )
      .run(id, JSON.stringify(spec), now, now, now);
    return this.require(id);
  }

  /** Saves a new spec or state; `anchor` restarts the schedule's count when it changed. */
  update(
    id: string,
    change: { spec: AutomationSpec; enabled: boolean; anchor: number },
    now: number,
  ): StoredAutomation {
    this.db
      .query(
        "UPDATE automations SET spec = ?, enabled = ?, anchor = ?, updated_at = ? WHERE id = ?",
      )
      .run(JSON.stringify(change.spec), change.enabled ? 1 : 0, change.anchor, now, id);
    return this.require(id);
  }

  recordRun(id: string, run: AutomationRun): void {
    this.db.query("UPDATE automations SET last_run = ? WHERE id = ?").run(JSON.stringify(run), id);
  }

  delete(id: string): boolean {
    return this.db.query("DELETE FROM automations WHERE id = ?").run(id).changes > 0;
  }

  private require(id: string): StoredAutomation {
    const automation = this.get(id);
    if (!automation) throw new Error(`no automation ${id}`);
    return automation;
  }
}

function fromRow(row: Row): StoredAutomation {
  return {
    ...AutomationSpec.parse(JSON.parse(row.spec)),
    id: row.id,
    enabled: row.enabled === 1,
    anchor: row.anchor,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_run && { lastRun: JSON.parse(row.last_run) as AutomationRun }),
  };
}
