import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@warren/core";
import { defaultHiddenPaths, SeatbeltSandbox, seatbeltAvailable, shellTool } from "../src/index.ts";

/**
 * Red-team tests for the Seatbelt sandbox: what a task's shell commands can and cannot do.
 * Each "cannot" case is an attack a prompt-injected model might try. macOS only.
 */

const run = seatbeltAvailable() ? describe : describe.skip;

let root: string;
let warrenHome: string;
let workspace: string;
let scratch: string;
let secrets: string;
let source: string;

function context(network = false): ToolContext {
  return {
    taskId: "t1",
    workspace,
    scratch,
    grant: { workspace: { kind: "clone", source }, network, privilegedTools: [], budget: {} },
    signal: new AbortController().signal,
  };
}

async function sh(command: string, network = false) {
  const sandbox = new SeatbeltSandbox({ warrenHome, hiddenPaths: [secrets] });
  return shellTool(sandbox).run({ command }, context(network));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "warren-sbx-"));
  warrenHome = join(root, "warren");
  workspace = join(warrenHome, "tasks", "t1", "workspace");
  scratch = join(warrenHome, "tasks", "t1", "scratch");
  secrets = join(root, "fake-ssh");
  source = join(root, "source-repo");
  for (const dir of [
    workspace,
    join(scratch, "tmp"),
    secrets,
    source,
    join(warrenHome, "tasks", "t2"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(secrets, "id_ed25519"), "PRIVATE KEY");
  writeFileSync(join(warrenHome, "credentials.env"), "WARREN_OPENAI_API_KEY=sk-test");
  writeFileSync(join(warrenHome, "tasks", "t2", "other.txt"), "another task");
  writeFileSync(join(source, "main.ts"), "original");
  expect(Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: workspace }).exitCode).toBe(0);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

run("sandbox: what a task can do", () => {
  test("work in its workspace with git and bun", async () => {
    const result = await sh(
      [
        'echo \'import {test,expect} from "bun:test"; test("t", () => expect(1).toBe(1));\' > a.test.ts',
        "bun test 2>&1 | grep -q '1 pass'",
        "git add . && git -c user.name=w -c user.email=w@example.com commit -qm one",
        "git log --oneline | wc -l | tr -d ' '",
      ].join(" && "),
    );
    expect(result).toEqual({ outcome: "ok", text: "exit code 0\n1" });
  });

  test("use temp files, including with plain mktemp", async () => {
    const result = await sh(
      'f=$(mktemp) && d=$(mktemp -d -t build) && echo hi > "$f" && touch "$d/x" && echo x > "$TMPDIR/y" && echo "$f"',
    );
    expect(result.outcome).toBe("ok");
    expect(result.text).toContain(join("scratch", "tmp"));
  });

  test("reach the network only when granted", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("pong") });
    try {
      const url = `http://127.0.0.1:${server.port}/`;
      expect((await sh(`curl -s -m 3 ${url}`, true)).text).toContain("pong");
      expect((await sh(`curl -s -m 3 ${url}`, false)).outcome).toBe("error");
    } finally {
      server.stop(true);
    }
  });
});

run("sandbox: what a task cannot do", () => {
  const denied = /Operation not permitted|Permission denied/;

  test("write outside its workspace, including the source repository", async () => {
    const userTemp = Bun.spawnSync(["getconf", "DARWIN_USER_TEMP_DIR"]).stdout.toString().trim();
    for (const target of [
      join(source, "main.ts"),
      join(root, "escape.txt"),
      "/tmp/warren-escape.txt",
      join(userTemp, `warren-escape-${process.pid}.txt`),
    ]) {
      const result = await sh(`echo pwned > '${target}'`);
      expect({ target, outcome: result.outcome }).toEqual({ target, outcome: "error" });
      expect(result.text).toMatch(denied);
    }
    expect(Bun.file(join(source, "main.ts")).text()).resolves.toBe("original");
    expect(existsSync(join(root, "escape.txt"))).toBe(false);
  });

  test("write into the home directory", async () => {
    const probe = join(homedir(), `.warren-sandbox-probe-${process.pid}`);
    try {
      const result = await sh(`echo pwned > '${probe}'`);
      expect(result.outcome).toBe("error");
      expect(existsSync(probe)).toBe(false);
    } finally {
      rmSync(probe, { force: true });
    }
  });

  test("read credentials, Warren's secrets or another task's files", async () => {
    for (const target of [
      join(secrets, "id_ed25519"),
      join(warrenHome, "credentials.env"),
      join(warrenHome, "tasks", "t2", "other.txt"),
    ]) {
      const result = await sh(`cat '${target}'`);
      expect({ target, outcome: result.outcome }).toEqual({ target, outcome: "error" });
      expect(result.text).not.toMatch(/PRIVATE KEY|sk-test|another task/);
    }
  });

  test("reach hidden files through a symlink in the workspace", async () => {
    const result = await sh(`ln -s '${secrets}' keys && cat keys/id_ed25519`);
    expect(result.outcome).toBe("error");
    expect(result.text).not.toContain("PRIVATE KEY");
  });

  test("signal processes outside the sandbox", async () => {
    const victim = Bun.spawn(["sleep", "30"]);
    try {
      const result = await sh(`kill -9 ${victim.pid}`);
      expect(result.outcome).toBe("error");
      expect(victim.killed || victim.exitCode !== null).toBe(false);
    } finally {
      victim.kill();
    }
  });

  test("launch applications or talk to other apps", async () => {
    // `open` goes through LaunchServices; denied, it fails without starting anything.
    const result = await sh("open -g -a TextEdit");
    expect(result.outcome).toBe("error");
  });

  test("see Warren's secrets in its environment", async () => {
    process.env.WARREN_OPENAI_API_KEY = "sk-should-not-leak";
    try {
      expect((await sh("env")).text).not.toContain("sk-should-not-leak");
    } finally {
      delete process.env.WARREN_OPENAI_API_KEY;
    }
  });
});

describe("hidden paths", () => {
  test("cover keys, cloud credentials and other agents' logins", () => {
    const hidden = defaultHiddenPaths("/Users/u");
    for (const path of [".ssh", ".aws", ".config/gh", ".codex", ".claude", "Library/Keychains"]) {
      expect(hidden).toContain(`/Users/u/${path}`);
    }
  });
});

// Keep unused-hook lint quiet when the suite is skipped on other platforms.
beforeAll(() => {});
afterAll(() => {});
