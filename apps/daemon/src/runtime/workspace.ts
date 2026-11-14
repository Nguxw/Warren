import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskState } from "@warren/core";
import { runProcess } from "@warren/tools";
import { type Baseline, snapshot } from "./artifacts.ts";

/**
 * Each task owns `<tasks>/<id>/workspace`. For a repository it is a `git clone --local`, which is
 * self-contained (unlike a worktree, it does not write into the source repository's .git), so
 * the sandbox can later confine all writes to the task directory. Any other folder is copied
 * (APFS clones, so no space is used until a file changes), and a snapshot of the copy, kept
 * outside the workspace where the model cannot rewrite it, tells the task's changes apart.
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

  /** The copied folder's files as they were before the task ran; only for copied folders. */
  baselineOf(taskId: string): Baseline | undefined {
    const file = join(this.dirOf(taskId), "baseline.json");
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Baseline) : undefined;
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

    // Build next to the target and rename, so a cut-off copy never looks finished.
    const partial = `${target}.partial`;
    rmSync(partial, { recursive: true, force: true });

    if (workspace.kind === "copy") {
      mkdirSync(partial);
      const cp = (flags: string) =>
        runProcess(["cp", flags, `${workspace.source}/.`, partial], {
          cwd: this.dirOf(state.id),
          timeoutMs: 10 * 60_000,
          signal,
        });
      // `-c` clones on APFS; across volumes it fails, and a plain copy follows.
      let copy = process.platform === "darwin" ? await cp("-cpR") : { exitCode: 1, stderr: "" };
      if (copy.exitCode !== 0) copy = await cp("-pR");
      if (copy.exitCode !== 0) throw new Error(`copying the folder failed: ${copy.stderr.trim()}`);
      writeFileSync(join(this.dirOf(state.id), "baseline.json"), JSON.stringify(snapshot(partial)));
      renameSync(partial, target);
      return;
    }

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
