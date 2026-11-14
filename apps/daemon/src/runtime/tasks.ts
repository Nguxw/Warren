import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TaskState } from "@warren/core";
import type { CreateTaskRequest, EventOf, Grant, TriggerRef } from "@warren/protocol";
import type { Config } from "../config/config.ts";
import type { TaskStore } from "../store/task-store.ts";
import { type Baseline, exportArtifacts, listArtifacts } from "./artifacts.ts";
import { checkCopySize, checkFolder, exportFolder, type FolderRules } from "./folders.ts";

/**
 * Starting a task and saving its results, the same way whoever asks: a person through the API
 * or an automation on its schedule.
 */

const DEFAULT_MAX_MODEL_CALLS = 100;

/** A request that cannot be carried out as asked; the request was wrong, not the daemon. */
export class TaskRequestError extends Error {}

/** The `task.created` data for a request: its Grant, folders checked, defaults filled in. */
export function taskData(
  request: CreateTaskRequest,
  trigger: TriggerRef,
  deps: { config: Config; folders: FolderRules; skillNames?: () => readonly string[] },
): EventOf<"task.created">["data"] {
  const { config } = deps;
  const modelRole = request.modelRole ?? "main";
  if (!config.models[modelRole]) {
    throw new TaskRequestError(
      `unknown model role "${modelRole}"; configured: ${Object.keys(config.models).join(", ")}`,
    );
  }
  let workspace: Grant["workspace"] = { kind: "none" };
  if (request.repo) {
    const source = checkFolder(resolve(request.repo), deps.folders);
    // A repository is cloned, so its result comes back as a branch; any other folder is
    // copied, and its result is saved where the person chooses.
    if (existsSync(join(source, ".git"))) workspace = { kind: "clone", source };
    else {
      checkCopySize(source);
      workspace = { kind: "copy", source };
    }
  }
  const outputDir = request.outputDir ? checkFolder(request.outputDir, deps.folders) : undefined;
  const enabledServers = Object.entries(config.mcp.servers)
    .filter(([, server]) => server.enabled)
    .map(([name]) => name);
  // A choice narrows the servers that are on; it cannot name one that is off.
  for (const name of request.mcpServers ?? []) {
    if (!enabledServers.includes(name)) {
      throw new TaskRequestError(`MCP server "${name}" is not configured and turned on`);
    }
  }
  const mcpServers = request.mcpServers ?? enabledServers;
  const available = deps.skillNames?.() ?? [];
  for (const name of request.skills ?? []) {
    if (!available.includes(name)) throw new TaskRequestError(`no skill "${name}" is turned on`);
  }
  const skills = [...new Set(request.skills ?? [])];
  return {
    title: request.title ?? titleOf(request.instruction),
    instruction: request.instruction,
    grant: {
      workspace,
      network: request.network ?? config.tasks.network,
      // With a repository, a task may hand its result back to it and propose it on GitHub.
      privilegedTools: workspace.kind === "clone" ? ["publish_branch", "open_pull_request"] : [],
      // The MCP servers on when the task starts; a server added later does not widen it.
      ...(mcpServers.length > 0 && { mcpServers }),
      budget: { maxModelCalls: DEFAULT_MAX_MODEL_CALLS, ...request.budget },
    },
    trigger,
    modelRole,
    ...(outputDir && { outputDir }),
    ...(skills.length > 0 && { skills }),
  };
}

/** The instruction's first line; the repository is shown on its own, not in the title. */
export function titleOf(instruction: string): string {
  const line = instruction.split("\n")[0]?.trim() ?? "";
  return line.length > 72 ? `${line.slice(0, 71)}…` : line;
}

/**
 * Saves a task's files to a folder of the person's: into a new subfolder named after the task,
 * never over existing files; from a copied folder only what the task added or changed. Records
 * the save in the task's log.
 */
export function saveResults(
  state: TaskState,
  dir: string,
  deps: {
    store: TaskStore;
    folders: FolderRules;
    workspaceOf(id: string): string;
    baselineOf(id: string): Baseline | undefined;
  },
): { destination: string; files: number; state: TaskState } {
  if (state.grant.workspace.kind === "clone") {
    throw new TaskRequestError("a repository task's result is its branch");
  }
  const target = checkFolder(dir, deps.folders);
  const root = deps.workspaceOf(state.id);
  if (!existsSync(root)) throw new TaskRequestError("the task has no workspace yet");
  const { files } = listArtifacts(root, deps.baselineOf(state.id));
  if (files.length === 0) throw new TaskRequestError("nothing to save");
  const destination = exportFolder(target, state.title, `warren-${state.id.slice(-8)}`);
  const copied = exportArtifacts(
    root,
    files.map((f) => f.path),
    destination,
  );
  const next = deps.store.append(state.id, [
    { type: "artifacts.exported", data: { destination, files: copied } },
  ]);
  return { destination, files: copied, state: next };
}
