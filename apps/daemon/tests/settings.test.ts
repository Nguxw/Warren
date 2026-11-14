import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reply, ScriptedModel, toolCall } from "@warren/core/testing";
import { type Logger, type RunningDaemon, startDaemon, writeSecret } from "../src/index.ts";

const quiet: Logger = { info() {}, error() {} };
const KEY = "WARREN_TESTPROVIDER_API_KEY";

let root: string;
let home: string;
let daemon: RunningDaemon | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "warren-settings-"));
  home = join(root, "home");
  mkdirSync(home);
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  rmSync(root, { recursive: true, force: true });
});

async function start() {
  const model = new ScriptedModel([reply(toolCall("complete_task", { summary: "done" }))]);
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

describe("settings", () => {
  test("changes are saved, keep the rest of the file, and apply without a restart", async () => {
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ server: { port: 0 }, github: { repos: {} }, notifications: false }),
    );
    const call = await start();
    const before = (await call("GET", "/settings")).body.settings;
    expect(before.models.main.model).toBe("gpt-6.1-terra");
    expect(before.approvals).toEqual({ publish_branch: "auto", open_pull_request: "required" });

    const patched = await call("PATCH", "/settings", {
      models: {
        main: {
          provider: "openai-compatible",
          baseUrl: "http://localhost:11434/v1",
          model: "qwen3",
        },
      },
      tasks: { network: true },
      approvals: { publish_branch: "required" },
      concurrency: 5,
    });
    expect(patched.status).toBe(200);
    expect(patched.body.settings.models.main.model).toBe("qwen3");
    expect(patched.body.settings.models.hard.model).toBe("gpt-6.1-sol");
    expect(patched.body.settings.approvals.publish_branch).toBe("required");

    const file = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(file).toMatchObject({
      server: { port: 0 },
      github: { repos: {} },
      notifications: false,
      tasks: { network: true },
      concurrency: 5,
    });
    expect(Object.keys(file.models)).toEqual(["main"]);

    // The new default reaches the next task at once.
    const task = await call("POST", "/tasks", { instruction: "Look around" });
    expect(task.body.task.grant.network).toBe(true);
  });

  test("an invalid change is refused and nothing is written", async () => {
    const call = await start();
    const res = await call("PATCH", "/settings", {
      models: { main: { provider: "openai-compatible", model: "x" } },
    });
    expect(res.status).toBe(400);
    expect(() => readFileSync(join(home, "config.json"))).toThrow();
  });

  test("secrets are write-only and stored with mode 0600", async () => {
    writeFileSync(join(home, "credentials.env"), "# my keys\nWARREN_OTHER_TOKEN=keep-me\n");
    const call = await start();
    const value = "sk-test-0123456789abcdefWXYZ";
    const set = await call("PUT", `/secrets/${KEY}`, { value });
    expect(set.status).toBe(200);
    const info = set.body.settings.secrets.find((s: { name: string }) => s.name === KEY);
    expect(info).toMatchObject({ set: true, masked: "sk-test…WXYZ", fromEnv: false });
    expect(JSON.stringify(set.body)).not.toContain(value);

    const file = join(home, "credentials.env");
    expect(readFileSync(file, "utf8")).toBe(
      `# my keys\nWARREN_OTHER_TOKEN=keep-me\n${KEY}=${value}\n`,
    );
    expect(statSync(file).mode & 0o777).toBe(0o600);

    await call("DELETE", `/secrets/${KEY}`);
    expect(readFileSync(file, "utf8")).toBe("# my keys\nWARREN_OTHER_TOKEN=keep-me\n");
    expect((await call("PUT", "/secrets/OPENAI_API_KEY", { value })).status).toBe(400);
    expect((await call("PUT", `/secrets/${KEY}`, { value: "two words" })).status).toBe(400);
  });
});

describe("artifacts", () => {
  test("lists and reads what a task wrote, and nothing outside its workspace", async () => {
    const call = await start();
    const id: string = (await call("POST", "/tasks", { instruction: "Write a report" })).body.task
      .id;
    await daemon?.scheduler.idle();
    const workspace = join(home, "tasks", id, "workspace");
    mkdirSync(join(workspace, "data"));
    mkdirSync(join(workspace, ".git"));
    writeFileSync(join(workspace, "report.md"), "# Report\n");
    writeFileSync(join(workspace, "data", "raw.json"), "{}");
    writeFileSync(join(workspace, ".git", "HEAD"), "ref");
    writeFileSync(join(workspace, "chart.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(root, "secret.txt"), "do not show");
    symlinkSync(join(root, "secret.txt"), join(workspace, "link.txt"));

    const list = (await call("GET", `/tasks/${id}/files`)).body;
    expect(list.files.map((f: { path: string }) => f.path).sort()).toEqual([
      "chart.png",
      "data/raw.json",
      "report.md",
    ]);

    const read = (path: string) =>
      call("GET", `/tasks/${id}/files/content?path=${encodeURIComponent(path)}`);
    expect((await read("report.md")).body.file).toMatchObject({ kind: "text", text: "# Report\n" });
    expect((await read("chart.png")).body.file).toMatchObject({ kind: "image", mime: "image/png" });
    for (const path of ["link.txt", "../../../secret.txt", join(root, "secret.txt"), ""]) {
      const res = await read(path);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain("do not show");
    }
    expect((await call("POST", `/tasks/${id}/reveal`, { path: "link.txt" })).status).toBe(
      process.platform === "darwin" ? 404 : 501,
    );
  });
});

describe("writeSecret", () => {
  test("replaces an existing assignment in place of appending a second one", () => {
    const file = join(root, "credentials.env");
    writeFileSync(file, `export ${KEY}=old\n`);
    writeSecret(file, KEY, "new-value");
    expect(readFileSync(file, "utf8")).toBe(`${KEY}=new-value\n`);
  });
});
