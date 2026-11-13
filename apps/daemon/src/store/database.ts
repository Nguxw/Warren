import { Database } from "bun:sqlite";
import { migrate } from "./migrations.ts";

/**
 * Opens Warren's database and brings its schema up to date.
 *
 * `synchronous = FULL` is deliberate: a `tool.started` event must be on disk before an external
 * action runs, or a power loss could erase the record and the action would run twice.
 * Warren commits a few times per second at most, so the fsync cost does not matter.
 */
export function openDatabase(path: string): Database {
  const db = new Database(path, { create: true, strict: true });
  try {
    if (path !== ":memory:") db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = FULL");
    db.run("PRAGMA foreign_keys = ON");
    db.run("PRAGMA busy_timeout = 5000");
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
