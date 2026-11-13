import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@warren/core";
import { openPullRequestTool, publishBranchTool } from "../src/index.ts";

let root: string;
let source: string;
let workspace: string;
let marker: string;

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(
    ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { cwd },
  );
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.toString().trim();
}

function context(): ToolContext {
  return {
    taskId: "task-1",
    workspace,
    scratch: join(root, "scratch"),
    grant: {
      workspace: { kind: "clone", source },
      network: false,
      privilegedTools: ["publish_branch", "open_pull_request"],
      budget: {},
    },
    signal: new AbortController().signal,
  };
}

const branchOf = () => "warren/task1";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "warren-priv-"));
  source = join(root, "source");
  workspace = join(root, "workspace");
  marker = join(root, "pwned");
  mkdirSync(source);
  writeFileSync(join(source, "a.txt"), "one\n");
  git(source, "init", "-q", "-b", "main");
  git(source, "add", ".");
  git(source, "commit", "-qm", "init");
  git(root, "clone", "-q", "--local", source, workspace);
  writeFileSync(join(workspace, "a.txt"), "two\n");
  git(workspace, "commit", "-qam", "change");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Plants everything a sandboxed model could write to make trusted git run its code. */
function plantTraps(repo: string) {
  const script = join(root, "evil.sh");
  writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n`);
  chmodSync(script, 0o755);
  for (const hook of ["pre-push", "post-checkout", "reference-transaction", "pre-commit"]) {
    const file = join(repo, ".git", "hooks", hook);
    writeFileSync(file, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(file, 0o755);
  }
  git(repo, "config", "core.fsmonitor", script);
  git(repo, "config", "core.hooksPath", join(repo, ".git", "hooks"));
}

describe("publish_branch", () => {
  const tool = publishBranchTool({ branchOf });

  test("publishes the workspace's commit to the source as the task's branch, repeatably", async () => {
    const head = git(workspace, "rev-parse", "HEAD");
    const first = await tool.run({}, context());
    expect(first.text).toBe(`Published ${head.slice(0, 10)} to ${source} as branch warren/task1.`);
    expect(git(source, "rev-parse", "refs/heads/warren/task1")).toBe(head);
    expect(git(source, "rev-parse", "main")).not.toBe(head);

    // Publishing again, as after an interrupted call, changes nothing and succeeds.
    expect((await tool.run({}, context())).outcome).toBe("ok");
  });

  test("refuses to overwrite a branch whose history was rewritten", async () => {
    await tool.run({}, context());
    git(workspace, "commit", "-q", "--amend", "-m", "rewritten");
    await expect(tool.run({}, context())).rejects.toThrow(/history has since been rewritten/);
  });

  test("never runs hooks or config planted in the workspace", async () => {
    plantTraps(workspace);
    await tool.run({}, context());
    expect(existsSync(marker)).toBe(false);
  });
});

describe("open_pull_request", () => {
  let api: ReturnType<typeof Bun.serve>;
  let requests: { method: string; path: string; auth: string | null; body: unknown }[];
  let existing: { html_url: string }[];
  let remote: string;

  beforeEach(() => {
    requests = [];
    existing = [];
    remote = join(root, "github-remote.git");
    git(root, "init", "-q", "--bare", remote);
    git(source, "remote", "add", "origin", "git@github.com:acme/widgets.git");
    api = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const body = req.method === "POST" ? await req.json() : undefined;
        requests.push({
          method: req.method,
          path: url.pathname + url.search,
          auth: req.headers.get("authorization"),
          body,
        });
        if (req.method === "GET" && url.pathname.endsWith("/pulls")) return Response.json(existing);
        if (req.method === "GET") return Response.json({ default_branch: "main" });
        return Response.json({ number: 7, html_url: "https://github.com/acme/widgets/pull/7" });
      },
    });
  });
  afterEach(() => {
    api.stop(true);
  });

  // `null` stands for "no token": `undefined` would pick up the default.
  const tool = (token: string | null = "ghp_test") =>
    openPullRequestTool({
      branchOf,
      token: () => token ?? undefined,
      apiBase: api.url.origin,
      pushUrl: () => remote,
    });

  test("pushes the branch and opens a draft pull request against the default branch", async () => {
    const result = await tool().run({ title: "Fix a.txt", body: "Details" }, context());
    expect(result.text).toBe(
      "Opened draft pull request #7: https://github.com/acme/widgets/pull/7",
    );
    expect(git(remote, "rev-parse", "refs/heads/warren/task1")).toBe(
      git(workspace, "rev-parse", "HEAD"),
    );
    const post = requests.find((r) => r.method === "POST");
    expect(post?.path).toBe("/repos/acme/widgets/pulls");
    expect(post?.auth).toBe("Bearer ghp_test");
    expect(post?.body).toMatchObject({
      title: "Fix a.txt",
      head: "warren/task1",
      base: "main",
      draft: true,
    });
    expect((post?.body as { body?: string } | undefined)?.body).toContain(
      "Opened by Warren, an automated agent",
    );
  });

  test("returns the open pull request instead of opening a second one", async () => {
    existing = [{ html_url: "https://github.com/acme/widgets/pull/3" }];
    const result = await tool().run({ title: "Again" }, context());
    expect(result.text).toContain("already open: https://github.com/acme/widgets/pull/3");
    expect(requests.some((r) => r.method === "POST")).toBe(false);
  });

  test("describes itself for the approval prompt", () => {
    const tool_ = tool();
    expect(tool_.describe?.({ title: "Fix a.txt" }, context())).toBe(
      'Push warren/task1 to github.com/acme/widgets and open a draft pull request "Fix a.txt"',
    );
    expect(tool_.approval).toBe("required");
  });

  test("needs Warren's own token and a GitHub origin", async () => {
    await expect(tool(null).run({ title: "x" }, context())).rejects.toThrow(
      "WARREN_GITHUB_TOKEN is not set",
    );
    git(source, "remote", "set-url", "origin", "https://gitlab.com/acme/widgets.git");
    await expect(tool().run({ title: "x" }, context())).rejects.toThrow(/not on GitHub/);
  });

  test("runs neither the workspace's traps nor the source repository's hooks", async () => {
    plantTraps(workspace);
    plantTraps(source);
    await tool().run({ title: "Fix" }, context());
    expect(existsSync(marker)).toBe(false);
  });
});
