import type { Tool } from "@warren/core";
import { editFile, listFiles, readFile, writeFile } from "./files.ts";
import { search, shell } from "./process.ts";

export * from "./common.ts";
export * from "./files.ts";
export * from "./process.ts";

/** The tools every task gets. Privileged tools (push, pull requests) come with M3. */
export function builtinTools(): Tool[] {
  return [readFile, listFiles, search, editFile, writeFile, shell] as Tool[];
}
