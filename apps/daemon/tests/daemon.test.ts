import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelClient, Tool } from "@warren/core";
import { fakeTool, reply, ScriptedModel, say, toolCall } from "@warren/core/testing";
import type { TaskEvent } from "@warren/protocol";
import { builtinTools } from "@warren/tools";
import { z } from "zod";
import { branchName, type Logger, type RunningDaemon, startDaemon } from "../src/index.ts";

const quiet: Logger = { info() {}, error() {} };

let root: string;
let home: string;
let repo: string;
let daemon: RunningDaemon | undefined;
let notifications: { title: string; body: string }[] = [];

beforeEach(async () => {
  notifications = [];
  root = mkdtempSync(join(tmpdir(), "warren-daemon-"));
  home = join(root, "home");
  repo = join(root, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "greet.ts"), 'export const greet = () => "hello";\n');
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["add", "."],
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init"],
  ]) {
    expect(Bun.spawnSync(["git", ...args], { cwd: repo }).exitCode).toBe(0);
  }
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  rmSync(root, { recursive: true, force: true });
});

async function start(model: ModelClient, tools?: Tool[]) {
  daemon = await startDaemon({
    home,
    port: 0,
    models: { resolve: () => ({ client: model, model: "scripted-1" }) },
    logger: quiet,
    sleep: async () => {},
    heartbeatMs: 200,
    notify: (title, body) => notifications.push({ title, body }),
    ...(tools && { tools }),
  });
  return daemon;
}

function api(d: RunningDaemon) {
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${d.url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${d.info.token}`, "Content-Type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    // biome-ignore lint/suspicious/noExplicitAny: tests inspect JSON responses loosely
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
}

describe("daemon", () => {
  test("runs a task end to end in a clone of the repository", async () => {
    const model = new ScriptedModel([
      reply(
        say("Updating greeting"),
        toolCall("edit_file", {
          path: "greet.ts",
          old_string: '"hello"',
          new_string: '"hello, warren"',
        }),
      ),
      reply(
        toolCall("shell", {
          command:
            "git -c user.name=w -c user.email=w@example.com commit -qam 'Update greeting' && git log --oneline | head -1",
        }),
      ),
      reply(toolCall("complete_task", { summary: "Updated the greeting and committed it" })),
    ]);
    const d = await start(model);
    const call = api(d);

    const created = await call("POST", "/tasks", { instruction: "Change the greeting", repo });
    expect(created.status).toBe(201);
    const id: string = created.body.task.id;
    expect(created.body.task.title).toBe("Change the greeting");
    expect((await call("GET", "/tasks")).body.tasks[0].repo).toBe("repo");
    await d.scheduler.idle();

    const task = (await call("GET", `/tasks/${id}`)).body.task;
    expect(task.status).toBe("ended");
    expect(task.ended).toMatchObject({ outcome: "completed" });

    // The work happened in the task's own clone, on its own branch; the source is untouched.
    const workspace = join(home, "tasks", id, "workspace");
    expect(readFileSync(join(workspace, "greet.ts"), "utf8")).toContain("hello, warren");
    expect(readFileSync(join(repo, "greet.ts"), "utf8")).not.toContain("warren");
    const branch = Bun.spawnSync(["git", "branch", "--show-current"], { cwd: workspace });
    expect(branch.stdout.toString().trim()).toBe(branchName(id));

    const events = (await call("GET", `/tasks/${id}/events`)).body.events as TaskEvent[];
    expect(events.filter((e) => e.type === "tool.finished").map((e) => e.data.outcome)).toEqual([
      "ok",
      "ok",
      "ok",
    ]);
    // A short suffix works wherever an id does.
    expect((await call("GET", `/tasks/${id.replaceAll("-", "").slice(-8)}`)).status).toBe(200);
  });

  test("a repository task works sandboxed and publishes its branch back to the source", async () => {
    const model = new ScriptedModel([
      reply(
        toolCall("write_file", { path: "notes.md", content: "# Notes\n" }),
        toolCall("shell", {
          command: "git add . && git -c user.name=w -c user.email=w@example.com commit -qm notes",
        }),
      ),
      reply(toolCall("publish_branch", {})),
      reply(toolCall("complete_task", { summary: "Added notes and published the branch" })),
    ]);
    const d = await start(model);
    const call = api(d);
    const id: string = (await call("POST", "/tasks", { instruction: "Add notes", repo })).body.task
      .id;
    await d.scheduler.idle();

    const task = (await call("GET", `/tasks/${id}`)).body.task;
    expect(task.ended).toMatchObject({ outcome: "completed" });
    expect(task.grant).toMatchObject({
      network: false,
      privilegedTools: ["publish_branch", "open_pull_request"],
    });
    const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      cwd: join(home, "tasks", id, "workspace"),
    }).stdout.toString();
    const published = Bun.spawnSync(["git", "rev-parse", `refs/heads/${branchName(id)}`], {
      cwd: repo,
    }).stdout.toString();
    expect(published).toBe(head);
    // The source's own branch is untouched.
    expect(readFileSync(join(repo, "greet.ts"), "utf8")).not.toContain("notes");
    expect(model.requests[0]?.tools.map((t) => t.name)).toContain("publish_branch");

    // The review diff shows committed and untracked changes, and runs nothing the model planted.
    const workspace = join(home, "tasks", id, "workspace");
    const marker = join(root, "pwned");
    const evil = join(root, "evil.sh");
    writeFileSync(evil, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(evil, 0o755);
    for (const key of ["diff.external", "core.fsmonitor", "diff.evil.textconv"]) {
      Bun.spawnSync(["git", "config", key, evil], { cwd: workspace });
    }
    writeFileSync(join(workspace, ".gitattributes"), "* diff=evil\n");
    writeFileSync(join(workspace, "draft.txt"), "not committed\n");

    const diff = (await call("GET", `/tasks/${id}/diff`)).body.diff;
    expect(diff.files).toEqual(
      expect.arrayContaining([
        { path: "notes.md", additions: 1, deletions: 0, status: "modified" },
        { path: "draft.txt", additions: 1, deletions: 0, status: "untracked" },
      ]),
    );
    expect(diff.patch).toContain("+# Notes");
    expect(existsSync(marker)).toBe(false);
  });

  test("a task without a repository gets no privileged tools; network can be requested", async () => {
    const model = new ScriptedModel([reply(toolCall("complete_task", { summary: "ok" }))]);
    const d = await start(model);
    const created = await api(d)("POST", "/tasks", { instruction: "Think", network: true });
    expect(created.body.task.grant).toMatchObject({ network: true, privilegedTools: [] });
    await d.scheduler.idle();
    expect(model.requests[0]?.tools.map((t) => t.name)).not.toContain("publish_branch");
  });

  test("rejects bad requests clearly", async () => {
    const d = await start(new ScriptedModel());
    const call = api(d);
    expect((await fetch(`${d.url}/tasks`)).status).toBe(401);
    expect((await call("GET", "/tasks/nope")).status).toBe(404);
    expect((await call("POST", "/tasks", { instruction: "" })).status).toBe(400);
    expect(
      (await call("POST", "/tasks", { instruction: "x", repo: join(root, "nope") })).body.error,
    ).toContain("is not a folder");
    // The folder holds Warren's home: copying it would show the model Warren's own data.
    expect((await call("POST", "/tasks", { instruction: "x", repo: root })).body.error).toContain(
      "Warren's own data",
    );
    expect(
      (await call("POST", "/tasks", { instruction: "x", modelRole: "turbo" })).body.error,
    ).toContain('unknown model role "turbo"');
  });

  test("an idle task wakes on input, and a question waits for an answer", async () => {
    const model = new ScriptedModel([
      reply(say("Which greeting?")),
      reply(toolCall("ask_user", { question: "Formal or casual?" })),
      reply(toolCall("complete_task", { summary: "Used casual" })),
    ]);
    const d = await start(model);
    const call = api(d);
    const id = (await call("POST", "/tasks", { instruction: "Change the greeting" })).body.task.id;
    await d.scheduler.idle();
    expect((await call("GET", `/tasks/${id}`)).body.task.status).toBe("idle");

    await call("POST", `/tasks/${id}/input`, { text: "Pick one" });
    await d.scheduler.idle();
    const waiting = (await call("GET", `/tasks/${id}`)).body.task;
    expect(waiting.status).toBe("waiting");

    const attentionId = waiting.attention[0].attentionId;
    await call("POST", `/tasks/${id}/attention/${attentionId}`, { response: "casual" });
    await d.scheduler.idle();
    expect((await call("GET", `/tasks/${id}`)).body.task.status).toBe("ended");
    expect(model.requests[2]?.items.at(-1)).toMatchObject({ type: "tool_result" });
  });

  test("streams a task's events as they happen", async () => {
    const model = new ScriptedModel([reply(toolCall("complete_task", { summary: "done" }))]);
    const d = await start(model);
    const id = (await api(d)("POST", "/tasks", { instruction: "x" })).body.task.id;

    const res = await fetch(`${d.url}/tasks/${id}/stream?after=-1&token=${d.info.token}`);
    if (!res.body) throw new Error("stream has no body");
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let received = "";
    while (!received.includes('"type":"task.ended"')) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value;
    }
    await reader.cancel();
    const types = received
      .split("\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) => (JSON.parse(line.slice(6)) as TaskEvent).type);
    expect(types).toEqual(["task.created", "model.responded", "tool.finished", "task.ended"]);
    expect(received).toContain("id: 0\n");
  });

  test("a restart continues the task, running an interrupted write tool once more", async () => {
    let runs = 0;
    const blocking = fakeTool("build", z.object({}), "write");
    blocking.run = (_args, { signal }) => {
      runs += 1;
      // The first run hangs until the daemon shuts down; the rerun succeeds.
      if (runs === 1)
        return new Promise((resolve) =>
          signal.addEventListener("abort", () => resolve({ outcome: "ok", text: "cut off" })),
        );
      return Promise.resolve({ outcome: "ok", text: "built" });
    };
    const tools = [...builtinTools(), blocking as Tool];

    const first = await start(new ScriptedModel([reply(toolCall("build", {}, "c1"))]), tools);
    const id = (await api(first)("POST", "/tasks", { instruction: "build it" })).body.task.id;
    while (first.store.get(id)?.running.length !== 1) await Bun.sleep(5);
    await first.stop();
    daemon = undefined;

    const second = await start(
      new ScriptedModel([reply(toolCall("complete_task", { summary: "built" }))]),
      tools,
    );
    await second.scheduler.idle();
    const state = second.store.get(id);
    expect(state?.ended?.outcome).toBe("completed");
    expect(runs).toBe(2);
    expect(second.store.events(id).filter((e) => e.type === "tool.started")).toHaveLength(1);
    expect(state?.history.find((i) => i.type === "tool_result")).toMatchObject({
      content: [{ type: "text", text: "built" }],
    });
  });

  test("notifies only when a task needs a person or finishes", async () => {
    const model = new ScriptedModel([
      reply(say("thinking"), toolCall("ask_user", { question: "Which port?" })),
      reply(toolCall("complete_task", { summary: "Used 8080" })),
    ]);
    const d = await start(model);
    const call = api(d);
    const id = (await call("POST", "/tasks", { instruction: "Pick a port", title: "Port" })).body
      .task.id;
    await d.scheduler.idle();
    expect(notifications).toEqual([{ title: "Has a question: Port", body: "Which port?" }]);

    const listed = (await call("GET", "/tasks")).body.tasks[0];
    expect(listed.attention).toEqual([
      { attentionId: expect.any(String), kind: "question", prompt: "Which port?" },
    ]);

    await call("POST", `/tasks/${id}/attention/${listed.attention[0].attentionId}`, {
      response: "8080",
    });
    await d.scheduler.idle();
    expect(notifications.at(-1)).toEqual({ title: "Done: Port", body: "Used 8080" });
    expect(notifications).toHaveLength(2);
  });

  test("answers only local host names, keeps its token, and reports the event cursor", async () => {
    const first = await start(new ScriptedModel());
    const evil = await fetch(`${first.url}/health`, {
      headers: { Host: "attacker.example:7349", Authorization: `Bearer ${first.info.token}` },
    });
    expect(evil.status).toBe(403);
    expect((await api(first)("GET", "/events/cursor")).body).toEqual({ id: 0 });
    const token = first.info.token;
    await first.stop();
    daemon = undefined;

    const second = await start(new ScriptedModel());
    expect(second.info.token).toBe(token);
    expect(token.length).toBeGreaterThanOrEqual(32);
  });

  test("refuses to start twice on the same home", async () => {
    await start(new ScriptedModel());
    await expect(startDaemon({ home, port: 0, logger: quiet })).rejects.toThrow(/already running/);
  });
});
