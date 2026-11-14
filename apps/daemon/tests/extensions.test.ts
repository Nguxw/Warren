import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reply, ScriptedModel, toolCall } from "@warren/core/testing";
import type { TaskEvent } from "@warren/protocol";
import { type Logger, type RunningDaemon, startDaemon } from "../src/index.ts";

const quiet: Logger = { info() {}, error() {} };
const repo = join(import.meta.dir, "..", "..", "..");
const fixture = join(repo, "packages", "mcp", "tests", "fixtures", "server.ts");

let root: string;
let home: string;
let daemon: RunningDaemon | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "warren-extensions-")));
  home = join(root, "warren");
  mkdirSync(home);
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  rmSync(root, { recursive: true, force: true });
});

async function start(model: ScriptedModel, config: Record<string, unknown> = {}) {
  writeFileSync(join(home, "config.json"), JSON.stringify(config));
  writeFileSync(join(home, "credentials.env"), "WARREN_FIXTURE_TOKEN=tok-9\n");
  daemon = await startDaemon({
    home,
    port: 0,
    models: { resolve: () => ({ client: model, model: "scripted-1" }) },
    logger: quiet,
    sleep: async () => {},
    notify: () => {},
  });
  const d = daemon;
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

const fixtureServer = {
  command: process.execPath,
  args: [fixture],
  env: { FIXTURE_TOKEN: "$WARREN_FIXTURE_TOKEN" },
};

describe("MCP servers", () => {
  test("a task uses its granted servers' tools; calls with effects wait for approval", async () => {
    const model = new ScriptedModel([
      reply(toolCall("mcp__fixture__lookup", { word: "warren" })),
      reply(toolCall("mcp__fixture__send", { to: "ana" })),
      reply(toolCall("complete_task", { summary: "Looked up and sent" })),
    ]);
    const call = await start(model, { mcp: { servers: { fixture: fixtureServer } } });
    const created = (await call("POST", "/tasks", { instruction: "Use the fixture" })).body.task;
    expect(created.grant.mcpServers).toEqual(["fixture"]);

    // The read-only call ran; the other waits for a person.
    let task = created;
    for (let i = 0; i < 200 && task.status !== "waiting"; i += 1) {
      await Bun.sleep(20);
      task = (await call("GET", `/tasks/${created.id}`)).body.task;
    }
    expect(task.status).toBe("waiting");
    expect(task.attention[0]).toMatchObject({ kind: "approval" });
    expect(task.attention[0].prompt).toContain("fixture · send");
    expect(model.requests[0]?.tools.map((t) => t.name)).toContain("mcp__fixture__lookup");

    await call("POST", `/tasks/${created.id}/attention/${task.attention[0].attentionId}`, {
      response: "",
      approved: true,
    });
    await daemon?.scheduler.idle();
    const events = (await call("GET", `/tasks/${created.id}/events`)).body.events as TaskEvent[];
    const started = events.filter((e) => e.type === "tool.started");
    expect(started.map((e) => (e.type === "tool.started" ? e.data.effect : ""))).toEqual([
      "read",
      "external",
    ]);
    const results = events.flatMap((e) =>
      e.type === "tool.finished"
        ? [e.data.content.map((p) => ("text" in p ? p.text : "")).join("")]
        : [],
    );
    expect(results).toEqual([
      "warren: a definition",
      "sent to ana with token tok-9; leaked nothing",
      "Task completed.",
    ]);
    expect((await call("GET", "/mcp")).body.servers[0]).toMatchObject({
      name: "fixture",
      state: "connected",
      tools: 3,
    });
  });

  test("servers are managed in the settings; a task keeps the servers it started with", async () => {
    const call = await start(new ScriptedModel([]));
    const before = (await call("POST", "/tasks", { instruction: "x" })).body.task;
    expect(before.grant.mcpServers).toBeUndefined();

    const saved = await call("PATCH", "/settings", { mcpServers: { fixture: fixtureServer } });
    expect(saved.body.settings.mcpServers.fixture).toMatchObject({
      approval: "required",
      enabled: true,
    });
    const tested = await call("POST", "/mcp/fixture/test");
    expect(tested.body.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      "fail",
      "lookup",
      "send",
    ]);
    expect((await call("POST", "/tasks", { instruction: "y" })).body.task.grant.mcpServers).toEqual(
      ["fixture"],
    );

    // A task may narrow the servers to none, but not name one that is not on.
    expect(
      (await call("POST", "/tasks", { instruction: "z", mcpServers: [] })).body.task.grant
        .mcpServers,
    ).toBeUndefined();
    expect((await call("POST", "/tasks", { instruction: "z", mcpServers: ["nope"] })).status).toBe(
      400,
    );

    await call("PATCH", "/settings", { mcpServers: { fixture: null } });
    expect((await call("GET", "/settings")).body.settings.mcpServers).toEqual({});
    expect(
      (await call("PATCH", "/settings", { mcpServers: { "Bad Name": fixtureServer } })).status,
    ).toBe(400);
  });
});

describe("skills", () => {
  test("installed skills are listed to the model and loaded into the task's scratch", async () => {
    const model = new ScriptedModel([
      reply(toolCall("load_skill", { name: "research-report" })),
      reply(toolCall("complete_task", { summary: "done" })),
    ]);
    const call = await start(model);
    const installed = await call("POST", "/skills", {
      path: join(repo, "examples", "skills", "research-report"),
    });
    expect(installed.status).toBe(201);
    expect((await call("GET", "/skills")).body.skills[0]).toMatchObject({
      name: "research-report",
      enabled: true,
    });

    const id = (await call("POST", "/tasks", { instruction: "Research something" })).body.task.id;
    await daemon?.scheduler.idle();
    expect(model.requests[0]?.instructions).toContain(
      "- research-report: Write a sourced research report",
    );
    const events = (await call("GET", `/tasks/${id}/events`)).body.events as TaskEvent[];
    const loaded = events.find((e) => e.type === "tool.finished");
    expect(JSON.stringify(loaded)).toContain("# Skill: research-report");
    expect(
      existsSync(join(home, "tasks", id, "scratch", "skills", "research-report", "template.md")),
    ).toBe(true);

    // Chosen for a task, the model is told to load it first; an unknown skill is refused.
    const chosen = new ScriptedModel([reply(toolCall("complete_task", { summary: "ok" }))]);
    await daemon?.stop();
    const withChoice = await start(chosen);
    const task = (
      await withChoice("POST", "/tasks", { instruction: "Report", skills: ["research-report"] })
    ).body.task;
    expect(task.skills).toEqual(["research-report"]);
    await daemon?.scheduler.idle();
    expect(chosen.requests[0]?.instructions).toContain(
      "The user chose research-report for this task: load it with load_skill",
    );
    expect(
      (await withChoice("POST", "/tasks", { instruction: "x", skills: ["nope"] })).status,
    ).toBe(400);

    // Turned off, it is no longer offered.
    await withChoice("PATCH", "/settings", { disabledSkills: ["research-report"] });
    const next = new ScriptedModel([reply(toolCall("complete_task", { summary: "ok" }))]);
    await daemon?.stop();
    const again = await start(next, { skills: { disabled: ["research-report"] } });
    await again("POST", "/tasks", { instruction: "Another" });
    await daemon?.scheduler.idle();
    expect(next.requests[0]?.instructions).not.toContain("research-report");
    expect((await again("DELETE", "/skills/research-report")).status).toBe(200);
    expect((await again("POST", "/skills", { path: root })).status).toBe(400);
  });
});
