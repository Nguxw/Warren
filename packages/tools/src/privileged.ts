import type { Tool, ToolContext } from "@warren/core";
import { z } from "zod";
import { ToolError } from "./common.ts";
import { runProcess } from "./process.ts";

/**
 * Privileged tools: they run in the trusted daemon, outside the sandbox, with Warren's own
 * credentials. A task can call them only when its Grant lists them, and each call can require a
 * person's approval.
 *
 * Two rules keep the sandbox from being bypassed through them:
 * - Never run git inside the workspace. Its hooks and config were writable by the sandboxed
 *   model, and git would execute them here with full rights. Instead the source repository
 *   fetches from the workspace: reading an untrusted repository runs none of its hooks or config.
 * - Never run hooks or credential helpers of the source repository either: a pre-push hook would
 *   run the model's code unsandboxed, and a credential helper would lend the user's own login.
 *
 * Both tools check before they act, so calling them again after an interrupted call is safe.
 */

/** Git with hooks, fsmonitor and credential helpers switched off. */
async function trustedGit(
  args: string[],
  cwd: string,
  signal: AbortSignal,
  env?: Record<string, string>,
): Promise<string> {
  const result = await runProcess(
    [
      "git",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "credential.helper=",
      ...args,
    ],
    { cwd, timeoutMs: 5 * 60_000, signal, ...(env && { env }) },
  );
  if (result.exitCode !== 0) {
    throw new ToolError(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

function sourceOf(context: Pick<ToolContext, "grant">): string {
  const { workspace } = context.grant;
  if (workspace.kind !== "clone") throw new ToolError("this task has no repository");
  return workspace.source;
}

/** Copies the workspace's HEAD into the source repository as `branch`; fast-forward only. */
async function publish(context: ToolContext, branch: string): Promise<string> {
  const source = sourceOf(context);
  try {
    await trustedGit(
      [
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        context.workspace,
        `HEAD:refs/heads/${branch}`,
      ],
      source,
      context.signal,
    );
  } catch (error) {
    if (error instanceof ToolError && /non-fast-forward|rejected/.test(error.message)) {
      throw new ToolError(
        `${branch} in ${source} has commits the workspace does not; it was published before and the history has since been rewritten. Add new commits instead of rewriting.`,
      );
    }
    throw error;
  }
  return trustedGit(["rev-parse", `refs/heads/${branch}`], source, context.signal);
}

export interface PublishOptions {
  /** The branch a task publishes to. Fixed per task, so a model cannot overwrite other branches. */
  branchOf(taskId: string): string;
}

export function publishBranchTool(options: PublishOptions): Tool<Record<string, never>> {
  return {
    name: "publish_branch",
    description:
      "Publish the workspace's current commit to the user's repository as this task's branch, so they can review it there. Commit first. Publishing again after new commits updates the branch.",
    parameters: z.object({}).strict() as z.ZodType<Record<string, never>>,
    effect: "external",
    privileged: true,
    approval: "auto",
    describe: (_args, context) =>
      `Publish the task's commits to ${sourceOf(context)} as branch ${options.branchOf(context.taskId)}`,
    async run(_args, context) {
      const branch = options.branchOf(context.taskId);
      const sha = await publish(context, branch);
      return {
        outcome: "ok",
        text: `Published ${sha.slice(0, 10)} to ${sourceOf(context)} as branch ${branch}.`,
      };
    },
  };
}

export interface GitHubOptions extends PublishOptions {
  token(): string | undefined;
  /** For tests: the GitHub API and the URL to push to. */
  apiBase?: string;
  pushUrl?(owner: string, repo: string): string;
}

type PullRequestArgs = { title: string; body?: string | undefined; base?: string | undefined };

export function openPullRequestTool(options: GitHubOptions): Tool<PullRequestArgs> {
  const api = options.apiBase ?? "https://api.github.com";

  function slugOf(context: Pick<ToolContext, "grant">): { owner: string; repo: string } {
    const result = Bun.spawnSync(
      ["git", "-c", "core.fsmonitor=false", "remote", "get-url", "origin"],
      { cwd: sourceOf(context), env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } },
    );
    const url = result.stdout.toString().trim();
    const match = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url);
    if (!match?.[1] || !match[2]) {
      throw new ToolError(`the repository's origin is not on GitHub: ${url || "(no origin)"}`);
    }
    return { owner: match[1], repo: match[2] };
  }

  async function github<T>(
    token: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${api}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "warren-agent",
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const json = (await res.json().catch(() => ({}))) as T & { message?: string };
    if (!res.ok)
      throw new ToolError(`GitHub ${method} ${path}: ${res.status} ${json.message ?? ""}`);
    return json;
  }

  return {
    name: "open_pull_request",
    description:
      "Push this task's branch to the repository's GitHub origin and open a draft pull request. If one is already open for the branch, returns it. Commit first. Needs the user's approval.",
    parameters: z.object({
      title: z.string().min(1).describe("Pull request title"),
      body: z.string().optional().describe("Pull request description in Markdown"),
      base: z
        .string()
        .optional()
        .describe("Target branch; default: the repository's default branch"),
    }),
    effect: "external",
    privileged: true,
    approval: "required",
    describe: ({ title }, context) => {
      const { owner, repo } = slugOf(context);
      return `Push ${options.branchOf(context.taskId)} to github.com/${owner}/${repo} and open a draft pull request "${title}"`;
    },
    async run({ title, body, base }, context) {
      const token = options.token();
      if (!token) throw new ToolError("WARREN_GITHUB_TOKEN is not set");
      const { owner, repo } = slugOf(context);
      const branch = options.branchOf(context.taskId);
      const source = sourceOf(context);

      await publish(context, branch);
      const pushUrl = options.pushUrl?.(owner, repo) ?? `https://github.com/${owner}/${repo}.git`;
      const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
      await trustedGit(
        ["push", "--no-verify", pushUrl, `refs/heads/${branch}:refs/heads/${branch}`],
        source,
        context.signal,
        {
          // Passed in the environment, not the command line, so other processes cannot read it.
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
          GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
        },
      );

      const open = await github<{ html_url: string }[]>(
        token,
        "GET",
        `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
      );
      if (open[0]) {
        return {
          outcome: "ok",
          text: `Pushed ${branch}. A pull request is already open: ${open[0].html_url}`,
        };
      }
      const target =
        base ??
        (await github<{ default_branch: string }>(token, "GET", `/repos/${owner}/${repo}`))
          .default_branch;
      const created = await github<{ html_url: string; number: number }>(
        token,
        "POST",
        `/repos/${owner}/${repo}/pulls`,
        {
          title,
          head: branch,
          base: target,
          draft: true,
          body: `${body ?? ""}\n\n---\nOpened by Warren, an automated agent, for task ${context.taskId}.`.trimStart(),
        },
      );
      return {
        outcome: "ok",
        text: `Opened draft pull request #${created.number}: ${created.html_url}`,
      };
    },
  };
}
