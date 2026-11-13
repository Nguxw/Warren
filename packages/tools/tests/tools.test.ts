import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@warren/core";
import {
  editFile,
  listFiles,
  readFile,
  resolveInside,
  search,
  shell,
  toolEnv,
  truncateMiddle,
  writeFile,
} from "../src/index.ts";

let root: string;
let workspace: string;
let ctx: ToolContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "warren-tools-"));
  workspace = join(root, "ws");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src/a.ts"), "const a = 1;\nconst b = 2;\nconst a2 = 1;\n");
  writeFileSync(join(root, "secret.txt"), "top secret");
  ctx = { taskId: "t1", workspace, signal: new AbortController().signal };
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("workspace confinement", () => {
  test("paths outside the workspace are refused, including through symlinks", () => {
    expect(() => resolveInside(workspace, "../secret.txt")).toThrow(/outside the workspace/);
    expect(() => resolveInside(workspace, "/etc/passwd")).toThrow(/outside the workspace/);
    symlinkSync(root, join(workspace, "escape"));
    expect(() => resolveInside(workspace, "escape/secret.txt")).toThrow(/outside the workspace/);
    expect(resolveInside(workspace, "src/new/file.ts")).toEndWith("/ws/src/new/file.ts");
  });

  test("tools reject escapes", async () => {
    await expect(readFile.run({ path: "../secret.txt" }, ctx)).rejects.toThrow(/outside/);
    await expect(writeFile.run({ path: "../x", content: "" }, ctx)).rejects.toThrow(/outside/);
  });
});

describe("file tools", () => {
  test("read_file numbers lines and pages long files", async () => {
    const full = await readFile.run({ path: "src/a.ts" }, ctx);
    expect(full.text).toBe("     1\tconst a = 1;\n     2\tconst b = 2;\n     3\tconst a2 = 1;");
    const page = await readFile.run({ path: "src/a.ts", offset: 2, limit: 1 }, ctx);
    expect(page.text).toBe("     2\tconst b = 2;\n[lines 2-2 of 3; read on with offset 3]");
    await expect(readFile.run({ path: "nope.ts" }, ctx)).rejects.toThrow(/does not exist/);
  });

  test("edit_file needs a unique match unless replace_all is set", async () => {
    await expect(
      editFile.run({ path: "src/a.ts", old_string: "= 1;", new_string: "= 9;" }, ctx),
    ).rejects.toThrow(/occurs 2 times/);
    await expect(
      editFile.run({ path: "src/a.ts", old_string: "missing", new_string: "" }, ctx),
    ).rejects.toThrow(/not found/);

    const one = await editFile.run(
      { path: "src/a.ts", old_string: "const b = 2;", new_string: "const b = 3;" },
      ctx,
    );
    expect(one.text).toBe("Replaced 1 occurrence in src/a.ts");
    await editFile.run(
      { path: "src/a.ts", old_string: "= 1;", new_string: "= 9;", replace_all: true },
      ctx,
    );
    expect(readFileSync(join(workspace, "src/a.ts"), "utf8")).toBe(
      "const a = 9;\nconst b = 3;\nconst a2 = 9;\n",
    );
  });

  test("write_file creates parent directories; list_files skips .git", async () => {
    await writeFile.run({ path: "docs/new/readme.md", content: "# hi" }, ctx);
    mkdirSync(join(workspace, ".git"));
    writeFileSync(join(workspace, ".git/HEAD"), "ref");
    const listed = await listFiles.run({}, ctx);
    expect(listed.text.split("\n")).toEqual(["docs/new/readme.md", "src/a.ts"]);
    expect((await listFiles.run({ pattern: "**/*.md" }, ctx)).text).toBe("docs/new/readme.md");
  });
});

describe("process tools", () => {
  test("search finds matches and reports none", async () => {
    const found = await search.run({ pattern: "const a" }, ctx);
    expect(found.text).toContain("src/a.ts:1:const a = 1;");
    expect((await search.run({ pattern: "zzz" }, ctx)).text).toBe("No matches");
  });

  test("shell reports exit codes and runs in the workspace", async () => {
    const ok = await shell.run({ command: "pwd && echo hi" }, ctx);
    expect(ok.outcome).toBe("ok");
    expect(ok.text).toMatch(/^exit code 0\n.*\/ws\nhi$/);
    const failed = await shell.run({ command: "echo oops >&2; exit 3" }, ctx);
    expect(failed).toEqual({ outcome: "error", text: "exit code 3\n[stderr]\noops" });
  });

  test("shell never sees Warren's secrets", async () => {
    process.env.WARREN_OPENAI_API_KEY = "sk-should-not-leak";
    try {
      const result = await shell.run({ command: "env" }, ctx);
      expect(result.text).not.toContain("sk-should-not-leak");
      expect(result.text).toContain("GIT_TERMINAL_PROMPT=0");
    } finally {
      delete process.env.WARREN_OPENAI_API_KEY;
    }
    expect(Object.keys(toolEnv({ OPENAI_API_KEY: "x", PATH: "/bin" }))).not.toContain(
      "OPENAI_API_KEY",
    );
  });

  test("shell times out and can be cancelled", async () => {
    const slow = await shell.run({ command: "sleep 5", timeout_seconds: 1 }, ctx);
    expect(slow).toMatchObject({ outcome: "error", text: "timed out after 1s" });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    await shell.run({ command: "sleep 5" }, { ...ctx, signal: controller.signal });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

test("truncateMiddle keeps both ends", () => {
  const text = `${"a".repeat(50)}${"b".repeat(50)}`;
  const cut = truncateMiddle(text, 20);
  expect(cut.startsWith("a".repeat(10))).toBe(true);
  expect(cut.endsWith("b".repeat(10))).toBe(true);
  expect(cut).toContain("80 characters omitted");
});
