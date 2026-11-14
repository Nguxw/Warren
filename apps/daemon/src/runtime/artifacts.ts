import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { extname, isAbsolute, join, relative, sep } from "node:path";

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
}

export interface ArtifactList {
  root: string;
  files: ArtifactFile[];
  truncated: boolean;
}

export type ArtifactContent =
  | { kind: "text"; path: string; size: number; text: string; truncated: boolean }
  | { kind: "image"; path: string; size: number; mime: string; base64: string }
  | { kind: "binary"; path: string; size: number };

/** A path that is not a file of the workspace. */
export class ArtifactPathError extends Error {}

const SKIP = new Set([
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

/** Every file in the workspace, newest first. */
export function listArtifacts(root: string): ArtifactList {
  const files: ArtifactFile[] = [];
  let truncated = false;
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (truncated) return;
      if (SKIP.has(name)) continue;
      const full = join(dir, name);
      const stat = lstatSync(full, { throwIfNoEntry: false });
      if (stat?.isDirectory()) walk(full);
      else if (stat?.isFile()) {
        if (files.length >= MAX_FILES) truncated = true;
        else files.push({ path: relative(root, full), size: stat.size, modifiedAt: stat.mtimeMs });
      }
    }
  };
  walk(root);
  files.sort((a, b) => b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path));
  return { root, files, truncated };
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
