import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelClient } from "@warren/core";
import { reply, ScriptedModel, toolCall } from "@warren/core/testing";
import {
  checkFolder,
  exportFolder,
  FolderError,
  type Logger,
  type RunningDaemon,
  startDaemon,
} from "../src/index.ts";

const quiet: Logger = { info() {}, error() {} };

let root: string;
let home: string;
let daemon: RunningDaemon | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "warren-folders-")));
  home = join(root, "warren");
  mkdirSync(home);
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  rmSync(root, { recursive: true, force: true });
});

async function start(
  model: ModelClient = new ScriptedModel([reply(toolCall("complete_task", { summary: "done" }))]),
) {
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

describe("a folder that is not a repository", () => {
  test("is copied; the task's changes are told apart and saved without touching the original", async () => {
    const notes = join(root, "notes");
    mkdirSync(join(notes, "2026"), { recursive: true });
    writeFileSync(join(notes, "todo.md"), "- a\n");
    writeFileSync(join(notes, "2026", "jan.md"), "jan\n");
    writeFileSync(join(notes, "old.txt"), "old\n");
    const out = join(root, "out");
    mkdirSync(out);

    const call = await start();
    const created = await call("POST", "/tasks", {
      instruction: "Tidy my notes",
      repo: notes,
      outputDir: out,
    });
    expect(created.status).toBe(201);
    const task = created.body.task;
    expect(task.grant).toMatchObject({ workspace: { kind: "copy", source: notes } });
    expect(task.grant.privilegedTools).toEqual([]);
    expect(task.outputDir).toBe(out);
    await daemon?.scheduler.idle();

    // What the model would do in its copy.
    const workspace = join(home, "tasks", task.id, "workspace");
    expect(readFileSync(join(workspace, "2026", "jan.md"), "utf8")).toBe("jan\n");
    writeFileSync(join(workspace, "todo.md"), "- a\n- b\n");
    writeFileSync(join(workspace, "summary.md"), "# Summary\n");
    rmSync(join(workspace, "old.txt"));

    const files = (await call("GET", `/tasks/${task.id}/files`)).body;
    expect(
      files.files.map((f: { path: string; status: string }) => [f.path, f.status]).sort(),
    ).toEqual([
      ["summary.md", "added"],
      ["todo.md", "modified"],
    ]);
    expect(files.unchanged).toBe(1);
    expect(files.deleted).toEqual(["old.txt"]);

    const saved = await call("POST", `/tasks/${task.id}/export`, {});
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ destination: join(out, "Tidy my notes"), files: 2 });
    expect(readFileSync(join(out, "Tidy my notes", "todo.md"), "utf8")).toBe("- a\n- b\n");
    expect(existsSync(join(out, "Tidy my notes", "2026"))).toBe(false);
    expect(saved.body.task.exports).toHaveLength(1);
    // A second save goes next to the first, never over it.
    const again = await call("POST", `/tasks/${task.id}/export`, { dir: out });
    expect(again.body.destination).toBe(join(out, "Tidy my notes 2"));

    // The original folder is as it was.
    expect(readFileSync(join(notes, "todo.md"), "utf8")).toBe("- a\n");
    expect(existsSync(join(notes, "old.txt"))).toBe(true);
    expect(existsSync(join(notes, "summary.md"))).toBe(false);
  });

  test("a task without a folder saves everything it wrote; nothing to save is refused", async () => {
    const call = await start();
    const id: string = (await call("POST", "/tasks", { instruction: "Research" })).body.task.id;
    await daemon?.scheduler.idle();
    const out = join(root, "out");
    mkdirSync(out);
    expect((await call("POST", `/tasks/${id}/export`, { dir: out })).status).toBe(400);
    writeFileSync(join(home, "tasks", id, "workspace", "report.md"), "# R\n");
    const saved = await call("POST", `/tasks/${id}/export`, { dir: out });
    expect(saved.body.files).toBe(1);
    expect(readFileSync(join(out, "Research", "report.md"), "utf8")).toBe("# R\n");
    // Saving into Warren's own home is refused.
    expect((await call("POST", `/tasks/${id}/export`, { dir: home })).status).toBe(400);
  });
});

describe("checkFolder", () => {
  test("refuses the home folder, what holds it, credentials and Warren's home", () => {
    const user = join(root, "user");
    for (const dir of ["Documents/notes", ".ssh", "Library/Keychains"]) {
      mkdirSync(join(user, dir), { recursive: true });
    }
    const rules = { warrenHome: home, home: user };
    expect(checkFolder(join(user, "Documents", "notes"), rules)).toBe(
      join(user, "Documents", "notes"),
    );
    for (const bad of [user, root, join(user, ".ssh"), join(user, "Library"), home, "relative"]) {
      expect(() => checkFolder(bad, rules)).toThrow(FolderError);
    }
  });

  test("names a save after the task, safely and without reusing a folder", () => {
    const out = join(root, "out");
    mkdirSync(join(out, "a b"), { recursive: true });
    expect(exportFolder(out, "a/b", "x")).toBe(join(out, "a b 2"));
    expect(exportFolder(out, "..", "warren-1")).toBe(join(out, "warren-1"));
  });
});

describe("deleting a task", () => {
  test("removes its log and files; what it saved elsewhere stays", async () => {
    const call = await start();
    const id: string = (await call("POST", "/tasks", { instruction: "Research" })).body.task.id;
    await daemon?.scheduler.idle();
    writeFileSync(join(home, "tasks", id, "workspace", "report.md"), "# R\n");
    const out = join(root, "out");
    mkdirSync(out);
    const saved = (await call("POST", `/tasks/${id}/export`, { dir: out })).body.destination;

    expect((await call("DELETE", `/tasks/${id}`)).body).toEqual({ deleted: id });
    expect((await call("GET", `/tasks/${id}`)).status).toBe(404);
    expect((await call("GET", "/tasks")).body.tasks).toEqual([]);
    expect(daemon?.store.events(id)).toEqual([]);
    expect(existsSync(join(home, "tasks", id))).toBe(false);
    expect(readFileSync(join(saved, "report.md"), "utf8")).toBe("# R\n");
    expect((await call("DELETE", `/tasks/${id}`)).status).toBe(404);
  });

  test("a running task is stopped first and never written to again", async () => {
    let calls = 0;
    // A model that thinks until it is interrupted.
    const model: ModelClient = {
      provider: "slow",
      complete: (request) => {
        calls += 1;
        return new Promise((_, reject) => {
          request.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
    };
    const call = await start(model);
    const id: string = (await call("POST", "/tasks", { instruction: "Think" })).body.task.id;
    while (calls === 0) await Bun.sleep(5);
    expect(daemon?.scheduler.isRunning(id)).toBe(true);

    expect((await call("DELETE", `/tasks/${id}`)).status).toBe(200);
    expect(daemon?.scheduler.isRunning(id)).toBe(false);
    expect(daemon?.store.get(id)).toBeUndefined();
    await daemon?.scheduler.idle();
    expect(daemon?.store.events(id)).toEqual([]);
    expect(calls).toBe(1);
  });
});
