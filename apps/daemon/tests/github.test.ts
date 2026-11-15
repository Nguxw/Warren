import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reply, ScriptedModel, toolCall } from "@warren/core/testing";
import { textOf } from "@warren/protocol";
import { type RunningDaemon, startDaemon } from "../src/index.ts";

let root: string;
let home: string;
let daemon: RunningDaemon | undefined;
let api: ReturnType<typeof Bun.serve>;
let posted: { path: string; body: string }[];
let polledComments: unknown[];
let polledRuns: unknown[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "warren-gh-"));
  home = join(root, "home");
  const repo = join(root, "app");
  mkdirSync(home);
  mkdirSync(repo);
  writeFileSync(join(repo, "README.md"), "# app\n");
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["add", "."],
    ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qm", "init"],
  ]) {
    Bun.spawnSync(["git", ...args], { cwd: repo });
  }
  posted = [];
  polledComments = [];
  polledRuns = [];
  api = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method === "POST") {
        posted.push({ path, body: ((await req.json()) as { body: string }).body });
        return Response.json({ id: 1 });
      }
      if (path === "/user") return Response.json({ login: "warren-bot" });
      if (path.endsWith("/issues/comments")) return Response.json(polledComments);
      if (path.endsWith("/actions/runs")) return Response.json({ workflow_runs: polledRuns });
      return Response.json([]);
    },
  });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      notifications: false,
      github: {
        allowedActors: ["alice"],
        webhookPort: 0,
        apiBase: api.url.origin,
        repos: { "acme/app": { path: repo } },
      },
    }),
  );
  writeFileSync(
    join(home, "credentials.env"),
    "WARREN_GITHUB_TOKEN=ghp_test\nWARREN_GITHUB_WEBHOOK_SECRET=hooksecret\n",
  );
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  api.stop(true);
  rmSync(root, { recursive: true, force: true });
});

async function start(model: ScriptedModel) {
  daemon = await startDaemon({
    home,
    port: 0,
    models: { resolve: () => ({ client: model, model: "scripted" }) },
    logger: { info() {}, error() {} },
    sleep: async () => {},
  });
  return daemon;
}

function deliver(d: RunningDaemon, name: string, payload: unknown, secret = "hooksecret") {
  const body = JSON.stringify(payload);
  return fetch(`http://127.0.0.1:${d.github?.webhookPort}/github`, {
    method: "POST",
    headers: {
      "x-github-event": name,
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    },
    body,
  });
}

const comment = (id: number, login: string, body: string, at = new Date().toISOString()) => ({
  action: "created",
  repository: { full_name: "acme/app" },
  issue: { number: 12, title: "Add notes" },
  comment: {
    id,
    body,
    user: { login },
    html_url: `https://github.com/acme/app/issues/12#c${id}`,
    created_at: at,
  },
});

async function until(check: () => boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(20);
  }
}

test("a mention on an issue becomes a task that asks and reports in the same conversation", async () => {
  const model = new ScriptedModel([
    reply(toolCall("ask_user", { question: "Which file should hold the notes?" })),
    reply(toolCall("complete_task", { summary: "Added NOTES.md" })),
  ]);
  const d = await start(model);

  expect(
    (await deliver(d, "issue_comment", comment(1, "alice", "@warren please add notes"))).status,
  ).toBe(202);
  await d.scheduler.idle();
  const [task] = d.store.list();
  expect(task).toMatchObject({ status: "waiting", title: "Add notes" });
  expect(d.store.get(task?.id ?? "")?.follows).toEqual(["github:acme/app#12"]);

  await until(() => posted.length === 1);
  expect(posted[0]?.path).toBe("/repos/acme/app/issues/12/comments");
  expect(posted[0]?.body).toContain("<!-- warren -->");
  expect(posted[0]?.body).toContain("Which file should hold the notes?");

  // Alice answers in the issue; the reply resolves the question and the task finishes.
  await deliver(d, "issue_comment", comment(2, "alice", "Use NOTES.md"));
  await d.scheduler.idle();
  expect(d.store.get(task?.id ?? "")?.ended?.outcome).toBe("completed");
  const answer = d.store
    .get(task?.id ?? "")
    ?.history.find(
      (item) => item.type === "tool_result" && textOf(item.content) === "Use NOTES.md",
    );
  expect(answer).toBeDefined();
  await until(() => posted.length === 2);
  expect(posted[1]?.body).toContain("finished this task");

  const decisions =
    d.intake &&
    ((await (
      await fetch(`${d.url}/triggers`, { headers: { Authorization: `Bearer ${d.info.token}` } })
    ).json()) as { triggers: { decision: { action: string } }[] });
  expect(decisions.triggers.map((t) => t.decision.action)).toEqual(["answer", "create"]);
});

test("webhook and poll deduplicate; own comments, strangers and bad signatures are refused; CI is only observed", async () => {
  const d = await start(new ScriptedModel());
  expect((await deliver(d, "issue_comment", comment(7, "alice", "hi"), "wrong")).status).toBe(401);

  const future = new Date(Date.now() + 60_000).toISOString();
  await deliver(d, "issue_comment", comment(8, "mallory", "@warren rm -rf", future));
  polledComments = [
    {
      ...comment(8, "mallory", "@warren rm -rf", future).comment,
      issue_url: "https://api.github.com/repos/acme/app/issues/12",
    },
    {
      ...comment(9, "warren-bot", "@warren loop?", future).comment,
      issue_url: "https://api.github.com/repos/acme/app/issues/12",
    },
  ];
  polledRuns = [
    {
      id: 77,
      conclusion: "failure",
      name: "test",
      head_branch: "main",
      html_url: "https://ci",
      updated_at: future,
    },
  ];
  await d.github?.reconcile();

  const records =
    d.intake &&
    ((await (
      await fetch(`${d.url}/triggers`, { headers: { Authorization: `Bearer ${d.info.token}` } })
    ).json()) as {
      triggers: { event: { externalId: string }; decision: { action: string; reason?: string } }[];
    });
  const byId = Object.fromEntries(records.triggers.map((t) => [t.event.externalId, t.decision]));
  expect(Object.keys(byId).sort()).toEqual(["comment:8", "comment:9", "run:77"]);
  expect(byId["comment:8"]).toEqual({
    action: "ignore",
    reason: "@mallory is not on the allowed list",
  });
  expect(byId["comment:9"]).toEqual({ action: "ignore", reason: "own message" });
  expect(byId["run:77"]).toMatchObject({ action: "observe", rule: "ciFailure" });
  expect(d.store.list()).toHaveLength(0);
});
