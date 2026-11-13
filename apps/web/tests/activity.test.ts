import { describe, expect, test } from "bun:test";
import {
  activity,
  currentStep,
  deliverables,
  durationParts,
  type KeyedEntry,
  parseDiff,
} from "../src/model.ts";

let n = 0;
const tool = (name: string, status: string, output?: string): KeyedEntry =>
  ({
    kind: "tool",
    key: `k${++n}`,
    seq: n,
    at: n,
    callId: `c${n}`,
    name,
    args: "{}",
    status,
    ...(output !== undefined && { output }),
  }) as KeyedEntry;
const say = (text: string): KeyedEntry =>
  ({ kind: "assistant", key: `k${++n}`, seq: n, at: n, text }) as KeyedEntry;

describe("activity", () => {
  test("groups consecutive tool calls and counts them by kind of work", () => {
    const blocks = activity([
      say("Looking"),
      tool("read_file", "ok"),
      tool("search", "ok"),
      tool("edit_file", "ok"),
      tool("shell", "error"),
      say("Tests fail, fixing"),
      tool("shell", "running"),
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(["entry", "steps", "entry", "steps"]);
    expect(blocks[1]).toMatchObject({
      counts: { inspect: 2, edit: 1, run: 1 },
      failed: 1,
      active: false,
    });
    expect(blocks[3]).toMatchObject({ counts: { run: 1 }, active: true });
  });

  test("currentStep is the latest call still running", () => {
    const running = tool("shell", "running");
    expect(currentStep([tool("read_file", "ok"), running])).toBe(running as never);
    expect(currentStep([tool("read_file", "ok")])).toBeUndefined();
  });

  test("deliverables reads the published branch and the pull request", () => {
    expect(
      deliverables([
        tool("publish_branch", "ok", "Published ace36f34d2 to /src/toy as branch warren/24113675."),
        tool(
          "open_pull_request",
          "ok",
          "Opened draft pull request #7: https://github.com/a/b/pull/7",
        ),
      ]),
    ).toEqual({
      branch: "warren/24113675",
      pullRequest: { number: 7, url: "https://github.com/a/b/pull/7" },
    });
    expect(deliverables([tool("publish_branch", "error", "failed")])).toEqual({});
  });
});

test("parseDiff numbers lines and recognises new files", () => {
  const files = parseDiff(
    [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1..2 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -3,3 +3,3 @@ export",
      " keep",
      "-old",
      "+new",
      "diff --git a/notes.md b/notes.md",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/notes.md",
      "@@ -0,0 +1 @@",
      "+# Notes",
      "",
    ].join("\n"),
  );
  expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
    ["src/a.ts", "modified", 1, 1],
    ["notes.md", "added", 1, 0],
  ]);
  expect(files[0]?.lines).toEqual([
    { kind: "hunk", text: "@@ -3,3 +3,3 @@ export" },
    { kind: "context", text: "keep", oldLine: 3, newLine: 3 },
    { kind: "del", text: "old", oldLine: 4 },
    { kind: "add", text: "new", newLine: 4 },
  ]);
});

test("durationParts splits elapsed time", () => {
  expect(durationParts(3_725_000)).toEqual({ h: 1, m: 2, s: 5 });
  expect(durationParts(-5)).toEqual({ h: 0, m: 0, s: 0 });
});
