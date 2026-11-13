import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { TaskState } from "@warren/core";
import { runProcess } from "@warren/tools";

/**
 * Each task owns `<tasks>/<id>/workspace`. For a repository it is a `git clone --local`, which is
 * self-contained (unlike a worktree, it does not write into the source repository's .git), so
 * the sandbox can later confine all writes to the task directory.
 */
export class Workspaces {
  constructor(private readonly tasksDir: string) {}

  dirOf(taskId: string): string {
    return join(this.tasksDir, taskId);
  }

  pathOf(taskId: string): string {
    return join(this.dirOf(taskId), "workspace");
  }

  /** Temp files and tool caches; writable in the sandbox, but not part of the work. */
  scratchOf(taskId: string): string {
    return join(this.dirOf(taskId), "scratch");
  }

  /** Creates the workspace once. Safe to call again: an existing workspace is kept. */
  async prepare(state: TaskState, signal: AbortSignal): Promise<void> {
    mkdirSync(join(this.scratchOf(state.id), "tmp"), { recursive: true });
    mkdirSync(join(this.scratchOf(state.id), "cache"), { recursive: true });
    const target = this.pathOf(state.id);
    if (existsSync(target)) return;

    const { workspace } = state.grant;
    if (workspace.kind === "none") {
      mkdirSync(target);
      return;
    }

    // Clone next to the target and rename, so a cut-off clone never looks finished.
    const partial = `${target}.partial`;
    rmSync(partial, { recursive: true, force: true });
    const git = (args: string[], cwd: string) =>
      runProcess(["git", ...args], { cwd, timeoutMs: 10 * 60_000, signal });

    const clone = await git(
      [
        "clone",
        "--local",
        "--quiet",
        ...(workspace.ref ? ["--branch", workspace.ref] : []),
        workspace.source,
        partial,
      ],
      this.dirOf(state.id),
    );
    if (clone.exitCode !== 0) throw new Error(`git clone failed: ${clone.stderr.trim()}`);

    const branch = await git(["checkout", "--quiet", "-b", branchName(state.id)], partial);
    if (branch.exitCode !== 0) throw new Error(`git checkout failed: ${branch.stderr.trim()}`);
    renameSync(partial, target);
  }
}

export function shortId(taskId: string): string {
  return taskId.replaceAll("-", "").slice(-8);
}

export function branchName(taskId: string): string {
  return `warren/${shortId(taskId)}`;
}
