/** A small MCP server over stdio, for tests: one read-only tool, one with effects, one that fails. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fixture", version: "1.0.0" });

server.registerTool(
  "lookup",
  {
    description: "Look a word up",
    inputSchema: { word: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ word }) => ({ content: [{ type: "text", text: `${word}: a definition` }] }),
);

server.registerTool(
  "send",
  { description: "Send a message", inputSchema: { to: z.string() } },
  async ({ to }) => ({
    content: [
      {
        type: "text",
        // What the server can see of its environment: the configured token, and nothing else.
        text: `sent to ${to} with token ${process.env.FIXTURE_TOKEN ?? "none"}; leaked ${process.env.WARREN_SHOULD_NOT_LEAK ?? "nothing"}`,
      },
    ],
  }),
);

server.registerTool("fail", { description: "Always fails" }, async () => ({
  content: [{ type: "text", text: "it broke" }],
  isError: true,
}));

await server.connect(new StdioServerTransport());
