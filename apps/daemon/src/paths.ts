import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Warren keeps everything under its own home directory and never reads or writes the
 * configuration of other agents (`~/.codex`, `~/.claude`) or tools such as `gh`.
 * `WARREN_HOME` moves it, which tests and a development instance use.
 */
export function warrenHome(env: Record<string, string | undefined> = process.env): string {
  return env.WARREN_HOME ?? join(homedir(), ".warren");
}

export function warrenPaths(home = warrenHome()) {
  return {
    home,
    database: join(home, "warren.db"),
    /** Secrets such as WARREN_OPENAI_API_KEY, mode 0600. See config/secrets.ts. */
    credentials: join(home, "credentials.env"),
    config: join(home, "config.json"),
    /** Where a running daemon tells clients its port and token. */
    daemonInfo: join(home, "daemon.json"),
    /** The API token, stable across restarts. */
    token: join(home, "token"),
    /** One directory per task: its workspace clone and large tool outputs. */
    tasks: join(home, "tasks"),
    /** Uploaded files waiting to be attached to a task or a message. */
    uploads: join(home, "uploads"),
    /** One folder per installed skill (docs/011). */
    skills: join(home, "skills"),
    logs: join(home, "logs"),
  };
}
