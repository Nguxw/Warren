import { runProcess, type Sandbox } from "@warren/tools";

/**
 * What a task changed in its workspace, for review: everything since the commit it was cloned
 * from, committed or not, plus new untracked files.
 *
 * The workspace is model-writable, including its git config and hooks, so these git commands run
 * in the task's own sandbox (no network), with external diff drivers, textconv filters and
 * fsmonitor switched off. Reading a diff can never run the model's code with the daemon's rights.
 */

export interface FileChange {
  path: string;
  additions: number;
  deletions: number;
  status: "modified" | "untracked";
}

export interface WorkspaceDiff {
  base?: string;
  files: FileChange[];
  patch: string;
  truncated: boolean;
}

const MAX_PATCH = 400_000;
const MAX_UNTRACKED = 30;

export async function workspaceDiff(
  workspace: string,
  scratch: string,
  sandbox: Sandbox,
  signal: AbortSignal,
): Promise<WorkspaceDiff> {
  const git = async (args: string[], okCodes = [0]) => {
    const result = await runProcess(
      ["git", "-c", "core.fsmonitor=false", "-c", "core.quotepath=false", ...args],
      {
        cwd: workspace,
        timeoutMs: 30_000,
        signal,
        sandbox: { sandbox, policy: { workspace, scratch, network: false } },
      },
    );
    if (result.exitCode === null || !okCodes.includes(result.exitCode)) {
      throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
    }
    return result.stdout;
  };

  const upstream = (
    await git(["rev-parse", "--verify", "-q", "refs/remotes/origin/HEAD"], [0, 1])
  ).trim();
  const base = upstream ? (await git(["merge-base", "HEAD", upstream])).trim() : undefined;
  const target = base ?? "HEAD";
  const diffArgs = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", target];

  const files: FileChange[] = (await git([...diffArgs.slice(0, -1), "--numstat", target]))
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [added = "0", deleted = "0", ...path] = line.split("\t");
      return {
        path: path.join("\t"),
        additions: Number(added) || 0,
        deletions: Number(deleted) || 0,
        status: "modified" as const,
      };
    });
  let patch = await git(diffArgs);

  const untracked = (await git(["ls-files", "--others", "--exclude-standard"]))
    .split("\n")
    .filter(Boolean);
  for (const path of untracked.slice(0, MAX_UNTRACKED)) {
    // `--no-index` exits 1 when the files differ, which they always do here.
    const added = await git(
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--no-index",
        "--",
        "/dev/null",
        path,
      ],
      [0, 1],
    );
    const lines = added.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
    files.push({ path, additions: lines, deletions: 0, status: "untracked" });
    patch += added;
  }

  const truncated = patch.length > MAX_PATCH || untracked.length > MAX_UNTRACKED;
  return {
    ...(base && { base }),
    files,
    patch: patch.length > MAX_PATCH ? patch.slice(0, MAX_PATCH) : patch,
    truncated,
  };
}
