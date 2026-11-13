import { existsSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/** A tool failure the model should see as an error result. */
export class ToolError extends Error {
  override name = "ToolError";
}

/**
 * Resolves `path` against the workspace and refuses anything outside it, following symlinks.
 * This keeps honest mistakes inside the workspace; the OS sandbox (M3) is the security boundary.
 */
export function resolveInside(workspace: string, path: string): string {
  const root = realpathSync(workspace);
  const target = resolve(root, path);
  let existing = target;
  while (!existsSync(existing)) existing = dirname(existing);
  const real = join(realpathSync(existing), relative(existing, target));
  if (real !== root && !real.startsWith(root + sep)) {
    throw new ToolError(`${path} is outside the workspace`);
  }
  return real;
}

/** Path relative to the workspace, for messages the model reads. */
export function display(workspace: string, absolute: string): string {
  return relative(realpathSync(workspace), absolute) || ".";
}

/** Keeps the start and end of long output, which is where errors and summaries usually are. */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  const dropped = text.length - 2 * half;
  return `${text.slice(0, half)}\n\n[… ${dropped} characters omitted …]\n\n${text.slice(-half)}`;
}

/** Output limit for one tool result, in characters. */
export const MAX_OUTPUT_CHARS = 30_000;

const PASSED_ENV = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR"];

/**
 * The environment for processes a tool starts: an allowlist, so Warren's own secrets and any
 * other credential in the daemon's environment never reach model-chosen commands.
 */
export function toolEnv(
  source: Record<string, string | undefined> = process.env,
  scratch?: string,
): Record<string, string> {
  const env: Record<string, string> = {
    TERM: "dumb",
    NO_COLOR: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
  };
  for (const name of PASSED_ENV) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  if (scratch) {
    // The sandbox lets a task write only its workspace and scratch, so temp files and package
    // manager caches go to scratch instead of the home directory.
    Object.assign(env, {
      PATH: `${join(scratch, "bin")}:${env.PATH ?? "/usr/bin:/bin"}`,
      TMPDIR: join(scratch, "tmp"),
      XDG_CACHE_HOME: join(scratch, "cache"),
      npm_config_cache: join(scratch, "cache", "npm"),
      BUN_INSTALL_CACHE_DIR: join(scratch, "cache", "bun"),
      PIP_CACHE_DIR: join(scratch, "cache", "pip"),
      GOCACHE: join(scratch, "cache", "go"),
    });
  }
  return env;
}
