import type { Tool } from "@warren/core";
import { editFile, listFiles, readFile, writeFile } from "./files.ts";
import { searchTool, shellTool } from "./process.ts";
import { noSandbox, type Sandbox } from "./sandbox.ts";

export * from "./common.ts";
export * from "./files.ts";
export * from "./privileged.ts";
export * from "./process.ts";
export * from "./sandbox.ts";
export * from "./skills.ts";

/** The tools every task gets. Processes they start run in `sandbox`. */
export function builtinTools(sandbox: Sandbox = noSandbox): Tool[] {
  return [
    readFile,
    listFiles,
    searchTool(sandbox),
    editFile,
    writeFile,
    shellTool(sandbox),
  ] as Tool[];
}
