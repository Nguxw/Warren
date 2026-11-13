import type { Database } from "bun:sqlite";

/**
 * Schema migrations, forward only. Each migration runs once, in its own transaction, and the
 * database's `user_version` records the last one applied. A migration is never edited after it
 * is released; a later change is a new migration.
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "tasks and events",
    sql: `
      CREATE TABLE tasks (
        id             TEXT PRIMARY KEY,
        title          TEXT NOT NULL,
        status         TEXT NOT NULL,
        trigger_source TEXT NOT NULL,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        last_seq       INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX tasks_by_status ON tasks (status, updated_at);

      -- One row per event. (task_id, seq) is the task's own order; id is the global order
      -- that lets a client stream every task's events and resume after a disconnect.
      CREATE TABLE events (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks (id),
        seq     INTEGER NOT NULL,
        type    TEXT NOT NULL,
        v       INTEGER NOT NULL,
        at      INTEGER NOT NULL,
        data    TEXT NOT NULL,
        UNIQUE (task_id, seq)
      ) STRICT;
    `,
  },
];

export class MigrationError extends Error {
  override name = "MigrationError";
}

/** Applies pending migrations and returns the resulting schema version. */
export function migrate(db: Database, migrations: readonly Migration[] = MIGRATIONS): number {
  const current = userVersion(db);
  const latest = migrations.at(-1)?.version ?? 0;
  if (current > latest) {
    throw new MigrationError(`database schema v${current} is newer than this build (v${latest})`);
  }
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    db.transaction(() => {
      db.run(migration.sql);
      db.run(`PRAGMA user_version = ${migration.version}`);
    })();
  }
  return userVersion(db);
}

function userVersion(db: Database): number {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  return row?.user_version ?? 0;
}
