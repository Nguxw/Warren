import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool, ToolOutput } from "@warren/core";
import type { ToolEffect } from "@warren/protocol";
import { z } from "zod";

/**
 * MCP (Model Context Protocol) servers as a source of tools.
 *
 * A server is a program the person chose to run: a local process speaking over stdio, or a
 * remote endpoint over streamable HTTP. It runs with the person's rights, outside the sandbox,
 * so its tools are treated like privileged ones:
 * - a tool the server marks read-only (`readOnlyHint`) has the effect `read`; any other is
 *   `external`, so recovery never runs it again after a crash;
 * - calls to tools that are not read-only need the person's approval unless the server is set
 *   to `auto`;
 * - a local server gets a minimal environment (PATH, HOME, …) plus only the variables its
 *   configuration names, with secrets referenced by name (`$WARREN_GITHUB_TOKEN`), never the
 *   daemon's whole environment.
 */

export const McpServerConfig = z
  .object({
    /** A local server: the program and its arguments. */
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    /** Extra environment variables; a value `$WARREN_…` is read from Warren's secrets. */
    env: z.record(z.string(), z.string()).optional(),
    /** A remote server: its streamable HTTP endpoint. */
    url: z.url().optional(),
    /** HTTP headers; a value may contain `$WARREN_…`, replaced by that secret. */
    headers: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().default(true),
    /** `required`: calls to tools that are not read-only wait for the person's approval. */
    approval: z.enum(["required", "auto"]).default("required"),
  })
  .refine((c) => Boolean(c.command) !== Boolean(c.url), {
    message: "give either a command (local server) or a url (remote server)",
  });
export type McpServerConfig = z.infer<typeof McpServerConfig>;

/** Server names become part of tool names: short and plain. */
export const MCP_SERVER_NAME = /^[a-z0-9][a-z0-9-]{0,23}$/;

export interface McpServerStatus {
  name: string;
  state: "idle" | "connected" | "error";
  tools?: number;
  error?: string;
}

export interface McpToolInfo {
  name: string;
  description: string;
  readOnly: boolean;
}

interface Connection {
  client: Client;
  /** The configuration it was opened with, to notice a change. */
  key: string;
  tools: Tool[];
  info: McpToolInfo[];
}

const OUTPUT_LIMIT = 50_000;
const CALL_TIMEOUT_MS = 10 * 60_000;
const CONNECT_TIMEOUT_MS = 30_000;

export class McpHub {
  private readonly connections = new Map<string, Connection>();
  private readonly connecting = new Map<string, Promise<Connection>>();
  private readonly errors = new Map<string, string>();

  constructor(
    private readonly options: {
      /** The servers as configured now; read on every use, so changes apply without a restart. */
      servers(): Record<string, McpServerConfig>;
      /** A secret's value by name, for `$WARREN_…` references. */
      secret(name: string): string | undefined;
      logger?: { error(message: string, fields?: Record<string, unknown>): void };
      /** For tests: replaces the transport a configuration opens. */
      transport?(config: McpServerConfig, name: string): Transport;
    },
  ) {}

  /**
   * The tools of the named servers, connecting to any not yet connected. A server that cannot
   * be reached is left out, and its error is kept for the settings page.
   */
  async tools(names: readonly string[]): Promise<Tool[]> {
    const servers = this.options.servers();
    const lists = await Promise.all(
      names
        .filter((name) => servers[name]?.enabled)
        .map(async (name) => {
          try {
            return (await this.connect(name)).tools;
          } catch {
            return [];
          }
        }),
    );
    return lists.flat();
  }

  /** Connects (again) and lists a server's tools, for "test connection" in the settings. */
  async test(name: string): Promise<McpToolInfo[]> {
    await this.disconnect(name);
    return (await this.connect(name)).info;
  }

  status(): McpServerStatus[] {
    return Object.keys(this.options.servers()).map((name) => {
      const connection = this.connections.get(name);
      const error = this.errors.get(name);
      if (connection) return { name, state: "connected", tools: connection.tools.length };
      return error ? { name, state: "error", error } : { name, state: "idle" };
    });
  }

  async disconnect(name: string): Promise<void> {
    const connection = this.connections.get(name);
    this.connections.delete(name);
    this.errors.delete(name);
    await connection?.client.close().catch(() => {});
  }

  async close(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((name) => this.disconnect(name)));
  }

  private connect(name: string): Promise<Connection> {
    const config = this.options.servers()[name];
    if (!config) return Promise.reject(new Error(`no MCP server "${name}"`));
    const key = JSON.stringify(config);
    const existing = this.connections.get(name);
    if (existing?.key === key) return Promise.resolve(existing);
    const pending = this.connecting.get(name);
    if (pending) return pending;

    const attempt = (async () => {
      // A changed configuration replaces the old connection.
      if (existing) await this.disconnect(name);
      const client = new Client({ name: "warren", version: "1.0.0" });
      try {
        await client.connect(this.transportOf(config, name), { timeout: CONNECT_TIMEOUT_MS });
        const { tools } = await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS });
        const connection: Connection = {
          client,
          key,
          tools: tools.map((tool) => this.toolOf(name, config, client, tool)),
          info: tools.map((tool) => ({
            name: tool.name,
            description: tool.description ?? "",
            readOnly: tool.annotations?.readOnlyHint === true,
          })),
        };
        this.connections.set(name, connection);
        this.errors.delete(name);
        return connection;
      } catch (error) {
        await client.close().catch(() => {});
        const message = error instanceof Error ? error.message : String(error);
        this.errors.set(name, message);
        this.options.logger?.error("MCP server unavailable", { server: name, error: message });
        throw error;
      } finally {
        this.connecting.delete(name);
      }
    })();
    this.connecting.set(name, attempt);
    return attempt;
  }

  private transportOf(config: McpServerConfig, name: string): Transport {
    if (this.options.transport) return this.options.transport(config, name);
    if (config.url) {
      return new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers: this.resolve(config.headers ?? {}) },
      });
    }
    return new StdioClientTransport({
      command: config.command ?? "",
      args: config.args ?? [],
      env: { ...getDefaultEnvironment(), ...this.resolve(config.env ?? {}) },
      stderr: "ignore",
    });
  }

  /** Replaces `$WARREN_…` references with the secrets' values; a missing secret is an error. */
  private resolve(values: Record<string, string>): Record<string, string> {
    return Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        value.replace(/\$(WARREN_[A-Z0-9_]+)/g, (_, secret: string) => {
          const resolved = this.options.secret(secret);
          if (resolved === undefined) throw new Error(`${secret} is not set`);
          return resolved;
        }),
      ]),
    );
  }

  private toolOf(
    server: string,
    config: McpServerConfig,
    client: Client,
    tool: Awaited<ReturnType<Client["listTools"]>>["tools"][number],
  ): Tool {
    const readOnly = tool.annotations?.readOnlyHint === true;
    const effect: ToolEffect = readOnly ? "read" : "external";
    return {
      name: mcpToolName(server, tool.name),
      description: `[${server}] ${tool.description ?? tool.name}`,
      parameters: z.record(z.string(), z.unknown()),
      inputSchema: tool.inputSchema as Record<string, unknown>,
      effect,
      approval: !readOnly && config.approval === "required" ? "required" : "auto",
      describe: (args) => `${server} · ${tool.name} ${preview(args)}`,
      run: async (args, context): Promise<ToolOutput> => {
        try {
          const result = await client.callTool(
            { name: tool.name, arguments: args as Record<string, unknown> },
            undefined,
            { signal: context.signal, timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true },
          );
          return {
            outcome: result.isError ? "error" : "ok",
            text: textOf(result),
          };
        } catch (error) {
          return { outcome: "error", text: error instanceof Error ? error.message : String(error) };
        }
      },
    };
  }
}

/** `mcp__<server>__<tool>`, within the 64 characters model APIs allow for a tool name. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool.replace(/[^a-zA-Z0-9_-]/g, "_")}`.slice(0, 64);
}

/** A tool result as text: text parts as they are, structured content as JSON, others named. */
function textOf(result: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const part of (result.content as { type: string; text?: string }[] | undefined) ?? []) {
    if (part.type === "text" && part.text !== undefined) parts.push(part.text);
    else parts.push(`[${part.type} content]`);
  }
  if (parts.length === 0 && result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  }
  const text = parts.join("\n") || "(no output)";
  return text.length > OUTPUT_LIMIT
    ? `${text.slice(0, OUTPUT_LIMIT)}\n… (${text.length - OUTPUT_LIMIT} more characters)`
    : text;
}

function preview(args: unknown): string {
  const text = JSON.stringify(args);
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}
