import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { Tool } from "@warren/core";
import { McpHub, McpServerConfig, mcpToolName } from "../src/index.ts";

const fixture = join(import.meta.dir, "fixtures", "server.ts");
let hub: McpHub | undefined;

afterEach(async () => {
  await hub?.close();
  hub = undefined;
});

function start(config: Partial<McpServerConfig> = {}) {
  process.env.WARREN_SHOULD_NOT_LEAK = "secret";
  hub = new McpHub({
    servers: () => ({
      fixture: McpServerConfig.parse({
        command: process.execPath,
        args: [fixture],
        env: { FIXTURE_TOKEN: "$WARREN_FIXTURE_TOKEN" },
        ...config,
      }),
    }),
    secret: (name) => (name === "WARREN_FIXTURE_TOKEN" ? "tok-123" : undefined),
  });
  return hub;
}

const context = (signal = new AbortSignal()) =>
  ({ taskId: "t", workspace: "/w", scratch: "/s", grant: {}, signal }) as never;

function byName(tools: Tool[], name: string): Tool {
  const tool = tools.find((t) => t.name === mcpToolName("fixture", name));
  if (!tool) throw new Error(`no ${name}`);
  return tool;
}

test("a local server's tools: read-only ones read freely, the rest are external and approved", async () => {
  const tools = await start().tools(["fixture"]);
  expect(tools.map((t) => t.name).sort()).toEqual([
    "mcp__fixture__fail",
    "mcp__fixture__lookup",
    "mcp__fixture__send",
  ]);
  const lookup = byName(tools, "lookup");
  expect(lookup).toMatchObject({ effect: "read", approval: "auto" });
  expect(lookup.inputSchema).toMatchObject({
    type: "object",
    properties: { word: { type: "string" } },
  });
  expect(byName(tools, "send")).toMatchObject({ effect: "external", approval: "required" });

  expect(await lookup.run({ word: "warren" }, context(new AbortController().signal))).toEqual({
    outcome: "ok",
    text: "warren: a definition",
  });
  expect(await byName(tools, "fail").run({}, context(new AbortController().signal))).toEqual({
    outcome: "error",
    text: "it broke",
  });
});

test("the server sees its configured secret and nothing of the daemon's environment", async () => {
  const send = byName(await start().tools(["fixture"]), "send");
  const output = await send.run({ to: "ana" }, context(new AbortController().signal));
  expect(output.text).toBe("sent to ana with token tok-123; leaked nothing");
});

test("auto approval; an unreachable server contributes no tools and reports why", async () => {
  expect(byName(await start({ approval: "auto" }).tools(["fixture"]), "send").approval).toBe(
    "auto",
  );
  await hub?.close();

  const broken = start({ command: "/nonexistent/server", args: [] });
  expect(await broken.tools(["fixture"])).toEqual([]);
  expect(broken.status()[0]).toMatchObject({ name: "fixture", state: "error" });
  expect(await broken.tools(["other"])).toEqual([]);
});

test("a configuration needs exactly one of command and url", () => {
  expect(() => McpServerConfig.parse({})).toThrow();
  expect(() => McpServerConfig.parse({ command: "x", url: "https://example.com/mcp" })).toThrow();
  expect(McpServerConfig.parse({ url: "https://example.com/mcp" })).toMatchObject({
    enabled: true,
    approval: "required",
  });
});
