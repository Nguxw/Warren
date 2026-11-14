import { copyFileSync, lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { SKIPPED_DIRS } from "./folders.ts";

/**
 * The files a task produced, for the person to look at.
 *
 * The workspace is model-writable, so it is read defensively:
 * - listing never follows symbolic links, and skips version control and dependency folders;
 * - a file is read only when its real path lies inside the workspace's real path and it is a
 *   regular file, so a link planted by the model cannot point the daemon at ~/.ssh;
 * - content goes back as data (text, or a raster image as base64), never served as a page on the
 *   daemon's origin, where model-written HTML or SVG could run with the interface's token.
 */

export interface ArtifactFile {
  path: string;
  size: number;
  modifiedAt: number;
  /** Against the folder the workspace was copied from; absent for other workspaces. */
  status?: "added" | "modified";
}

export interface ArtifactList {
  root: string;
  files: ArtifactFile[];
  truncated: boolean;
  /** For a copied folder: files the task left as they were, and files it removed. */
  unchanged?: number;
  deleted?: string[];
}

/** Each file of a copied folder as it was before the task ran: path → [size, mtime]. */
export type Baseline = Record<string, [number, number]>;

export type ArtifactContent =
  | { kind: "text"; path: string; size: number; text: string; truncated: boolean }
  | { kind: "image"; path: string; size: number; mime: string; base64: string }
  | { kind: "binary"; path: string; size: number };

/** A path that is not a file of the workspace. */
export class ArtifactPathError extends Error {}

const MAX_FILES = 500;
const MAX_TEXT = 1_000_000;
const MAX_IMAGE = 8_000_000;
const IMAGES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Every regular file under `root`, without following links or entering skipped folders. */
function walkFiles(root: string, visit: (path: string, size: number, mtime: number) => boolean) {
  const walk = (dir: string): boolean => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return true;
    }
    for (const name of names) {
      if (SKIPPED_DIRS.has(name)) continue;
      const full = join(dir, name);
      const stat = lstatSync(full, { throwIfNoEntry: false });
      if (stat?.isDirectory()) {
        if (!walk(full)) return false;
      } else if (stat?.isFile() && !visit(relative(root, full), stat.size, stat.mtimeMs)) {
        return false;
      }
    }
    return true;
  };
  walk(root);
}

/** What a copied folder holds before the task starts, to tell its changes apart later. */
export function snapshot(root: string): Baseline {
  const baseline: Baseline = {};
  walkFiles(root, (path, size, mtime) => {
    baseline[path] = [size, mtime];
    return true;
  });
  return baseline;
}

/**
 * The workspace's files, newest first. With a baseline, only what the task added or changed,
 * plus how many files it left alone and which it removed.
 */
export function listArtifacts(root: string, baseline?: Baseline): ArtifactList {
  const files: ArtifactFile[] = [];
  const seen = new Set<string>();
  let truncated = false;
  let unchanged = 0;
  walkFiles(root, (path, size, modifiedAt) => {
    seen.add(path);
    const before = baseline?.[path];
    if (baseline && before && before[0] === size && before[1] === modifiedAt) {
      unchanged += 1;
      return true;
    }
    if (files.length >= MAX_FILES) {
      truncated = true;
      return Boolean(baseline);
    }
    files.push({
      path,
      size,
      modifiedAt,
      ...(baseline && { status: before ? ("modified" as const) : ("added" as const) }),
    });
    return true;
  });
  files.sort((a, b) => b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path));
  if (!baseline) return { root, files, truncated };
  const deleted = Object.keys(baseline)
    .filter((path) => !seen.has(path))
    .sort();
  return { root, files, truncated, unchanged, deleted };
}

/**
 * Copies files of the workspace to `destination`, keeping their relative paths. Each is
 * checked like a read: a link or a path out of the workspace is skipped, never followed.
 */
export function exportArtifacts(root: string, paths: string[], destination: string): number {
  let copied = 0;
  for (const path of paths) {
    let real: string;
    try {
      real = resolveArtifact(root, path);
    } catch {
      continue;
    }
    if (!lstatSync(real).isFile()) continue;
    const target = join(destination, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(real, target);
    copied += 1;
  }
  return copied;
}

/** The real path of a workspace file, or an error if it is not one. */
export function resolveArtifact(root: string, path: string): string {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
    throw new ArtifactPathError(`not a path in the workspace: ${path}`);
  }
  let real: string;
  try {
    real = realpathSync(join(root, path));
  } catch {
    throw new ArtifactPathError(`no file ${path}`);
  }
  const realRoot = realpathSync(root);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new ArtifactPathError(`${path} leads outside the workspace`);
  }
  return real;
}

export async function readArtifact(root: string, path: string): Promise<ArtifactContent> {
  const real = resolveArtifact(root, path);
  const stat = lstatSync(real);
  if (!stat.isFile()) throw new ArtifactPathError(`${path} is not a file`);
  const size = stat.size;
  const file = Bun.file(real);

  const mime = IMAGES[extname(path).toLowerCase()];
  if (mime) {
    if (size > MAX_IMAGE) return { kind: "binary", path, size };
    const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    return { kind: "image", path, size, mime, base64 };
  }
  const bytes = new Uint8Array(await file.slice(0, MAX_TEXT).arrayBuffer());
  if (bytes.includes(0)) return { kind: "binary", path, size };
  return {
    kind: "text",
    path,
    size,
    text: new TextDecoder().decode(bytes),
    truncated: size > MAX_TEXT,
  };
}
