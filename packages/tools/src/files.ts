import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Tool } from "@warren/core";
import { z } from "zod";
import { display, MAX_OUTPUT_CHARS, resolveInside, ToolError, truncateMiddle } from "./common.ts";

const MAX_LINES = 2000;
const MAX_LINE_CHARS = 2000;

function readText(path: string, shown: string): string {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) throw new ToolError(`${shown} does not exist`);
  if (stat.isDirectory()) throw new ToolError(`${shown} is a directory; use list_files`);
  const buffer = readFileSync(path);
  if (buffer.subarray(0, 8192).includes(0)) throw new ToolError(`${shown} is a binary file`);
  return buffer.toString("utf8");
}

export const readFile: Tool<{
  path: string;
  offset?: number | undefined;
  limit?: number | undefined;
}> = {
  name: "read_file",
  description: `Read a text file from the workspace. Lines are numbered. Reads up to ${MAX_LINES} lines; use offset and limit for longer files.`,
  effect: "read",
  parameters: z.object({
    path: z.string().describe("Path relative to the workspace"),
    offset: z.number().int().min(1).optional().describe("First line to read, starting at 1"),
    limit: z.number().int().min(1).max(MAX_LINES).optional().describe("Number of lines to read"),
  }),
  async run({ path, offset = 1, limit = MAX_LINES }, { workspace }) {
    const absolute = resolveInside(workspace, path);
    const shown = display(workspace, absolute);
    const lines = readText(absolute, shown).split("\n");
    if (lines.at(-1) === "") lines.pop();
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const body = slice
      .map((line, i) => {
        const cut = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
        return `${String(offset + i).padStart(6)}\t${cut}`;
      })
      .join("\n");
    const end = offset - 1 + slice.length;
    const more =
      end < lines.length
        ? `\n[lines ${offset}-${end} of ${lines.length}; read on with offset ${end + 1}]`
        : "";
    if (lines.length === 0) return { outcome: "ok", text: `${shown} is empty` };
    return { outcome: "ok", text: truncateMiddle(body + more, MAX_OUTPUT_CHARS) };
  },
};

export const writeFile: Tool<{ path: string; content: string }> = {
  name: "write_file",
  description:
    "Create a file or replace its whole content. Prefer edit_file for changes to an existing file.",
  effect: "write",
  parameters: z.object({
    path: z.string().describe("Path relative to the workspace"),
    content: z.string().describe("The complete new content"),
  }),
  async run({ path, content }, { workspace }) {
    const absolute = resolveInside(workspace, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
    return {
      outcome: "ok",
      text: `Wrote ${Buffer.byteLength(content)} bytes to ${display(workspace, absolute)}`,
    };
  },
};

export const editFile: Tool<{
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean | undefined;
}> = {
  name: "edit_file",
  description:
    "Replace an exact string in a file. old_string must match the file exactly, including whitespace, and occur once unless replace_all is true. Include enough surrounding lines to make it unique.",
  effect: "write",
  parameters: z.object({
    path: z.string().describe("Path relative to the workspace"),
    old_string: z.string().min(1).describe("Exact text to replace"),
    new_string: z.string().describe("Replacement text"),
    replace_all: z.boolean().optional().describe("Replace every occurrence"),
  }),
  async run({ path, old_string, new_string, replace_all = false }, { workspace }) {
    const absolute = resolveInside(workspace, path);
    const shown = display(workspace, absolute);
    const content = readText(absolute, shown);
    const count = content.split(old_string).length - 1;
    if (count === 0) throw new ToolError(`old_string was not found in ${shown}`);
    if (count > 1 && !replace_all) {
      throw new ToolError(
        `old_string occurs ${count} times in ${shown}; add surrounding lines to make it unique, or set replace_all`,
      );
    }
    writeFileSync(absolute, content.split(old_string).join(new_string));
    return {
      outcome: "ok",
      text: `Replaced ${count} occurrence${count > 1 ? "s" : ""} in ${shown}`,
    };
  },
};

const MAX_FILES = 500;
const SKIPPED_DIRS = /(^|\/)(\.git|node_modules)\//;

export const listFiles: Tool<{ path?: string | undefined; pattern?: string | undefined }> = {
  name: "list_files",
  description: `List files under a directory of the workspace, optionally filtered by a glob such as "**/*.ts". Skips .git and node_modules. Returns at most ${MAX_FILES} paths.`,
  effect: "read",
  parameters: z.object({
    path: z.string().optional().describe("Directory relative to the workspace; default ."),
    pattern: z.string().optional().describe('Glob pattern; default "**/*"'),
  }),
  async run({ path = ".", pattern = "**/*" }, { workspace }) {
    const dir = resolveInside(workspace, path);
    const files: string[] = [];
    for await (const file of new Bun.Glob(pattern).scan({ cwd: dir, onlyFiles: true, dot: true })) {
      if (SKIPPED_DIRS.test(`${file}`)) continue;
      files.push(file);
    }
    files.sort();
    const shown = files.slice(0, MAX_FILES);
    const more = files.length > MAX_FILES ? `\n[${files.length - MAX_FILES} more not shown]` : "";
    return {
      outcome: "ok",
      text: files.length === 0 ? "No files found" : shown.join("\n") + more,
    };
  },
};
