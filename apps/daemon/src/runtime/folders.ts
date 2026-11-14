import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { defaultHiddenPaths } from "@warren/tools";

/**
 * The person's own folders, where Warren reads a task's input from and saves its results to.
 *
 * A copied folder becomes readable to the model, so it must not hold credentials: the home
 * folder itself, anything above it, Warren's home and the locations the sandbox hides are
 * refused, both as the folder and as anything inside it. The same places are refused as a
 * destination, so a task's files can never be written over keys or Warren's own state.
 */

/** A folder that cannot be used; the request was wrong, not the daemon. */
export class FolderError extends Error {}

export interface FolderRules {
  warrenHome: string;
  home?: string;
  /** Locations the sandbox hides; defaults to the sandbox's list. */
  hidden?: string[];
}

/** Directories never copied, listed or saved: version control, dependencies, caches. */
export const SKIPPED_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".DS_Store",
]);

const MAX_COPY_FILES = 50_000;
const MAX_COPY_BYTES = 4_000_000_000;

/** The folder's real path, if the person may use it as a task's input or output. */
export function checkFolder(path: string, rules: FolderRules): string {
  if (!isAbsolute(path)) throw new FolderError(`${path} is not an absolute path`);
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new FolderError(`${path} is not a folder`);
  }
  const real = realpathSync(path);
  const home = realOr(rules.home ?? homedir());
  const protectedPaths = [
    realOr(rules.warrenHome),
    ...(rules.hidden ?? defaultHiddenPaths(home)).map(realOr),
  ];
  if (real === home || isInside(home, real)) {
    throw new FolderError(`${path} contains your home folder; pick a folder inside it`);
  }
  for (const guarded of protectedPaths) {
    if (real === guarded || isInside(real, guarded) || isInside(guarded, real)) {
      throw new FolderError(`${path} holds credentials or Warren's own data`);
    }
  }
  return real;
}

/** Refuses a folder too large to copy, so a mistaken pick fails at once, not mid-task. */
export function checkCopySize(root: string): void {
  let files = 0;
  let bytes = 0;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (SKIPPED_DIRS.has(name)) continue;
      const stat = lstatSync(join(dir, name), { throwIfNoEntry: false });
      if (stat?.isDirectory()) walk(join(dir, name));
      else if (stat?.isFile()) {
        files += 1;
        bytes += stat.size;
        if (files > MAX_COPY_FILES || bytes > MAX_COPY_BYTES) {
          throw new FolderError(
            `${root} is too large to copy (over ${MAX_COPY_FILES} files or 4 GB); pick a smaller folder`,
          );
        }
      }
    }
  };
  walk(root);
}

/**
 * A new folder for one save, named after the task: `<dir>/<title>`, or `<title> 2` and so on
 * when that exists, so a save never mixes with or overwrites earlier files.
 */
export function exportFolder(dir: string, title: string, fallback: string): string {
  // Characters a folder name cannot hold, and control characters, become spaces.
  const cleaned = [...title]
    .map((ch) => (ch.charCodeAt(0) < 32 || '/\\:*?"<>|'.includes(ch) ? " " : ch))
    .join("");
  const base =
    cleaned.replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 60).trim() || fallback;
  let candidate = join(dir, base);
  for (let n = 2; existsSync(candidate); n += 1) candidate = join(dir, `${base} ${n}`);
  return candidate;
}

/** Whether `child` lies strictly inside `parent`. */
function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** A path's real form; for one that does not exist, its nearest existing parent's. */
function realOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realOr(parent), basename(path));
  }
}
