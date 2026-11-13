import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ModelClient, ModelError, type ModelRequest } from "@warren/core";
import { ChatCompletionsClient, OpenAIResponsesClient } from "../src/index.ts";

/**
 * The contract every model adapter keeps, run against a local fake of each provider's HTTP API.
 * The loop relies on these behaviours being identical whichever adapter is configured.
 */

interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

let next: Reply = { status: 200, body: {} };
let lastRequest: { path: string; body: Record<string, unknown> } | undefined;
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      lastRequest = {
        path: new URL(req.url).pathname,
        body: (await req.json()) as Record<string, unknown>,
      };
      return Response.json(next.body, { status: next.status, headers: next.headers ?? {} });
    },
  });
});
afterAll(() => {
  server.stop(true);
});

interface Fixture {
  name: string;
  client(baseURL: string): ModelClient;
  path: string;
  toolCall(id: string, name: string, args: string): unknown;
  text(text: string): unknown;
  /** The text of the tool result the adapter sent last, read from its own wire format. */
  sentToolResult(body: Record<string, unknown>): string | undefined;
  sentInstructions(body: Record<string, unknown>): string | undefined;
}

const usage = { input: 1200, cached: 1000, output: 80 };

const fixtures: Fixture[] = [
  {
    name: "openai-responses",
    client: (baseURL) => new OpenAIResponsesClient({ apiKey: "k", baseURL }),
    path: "/v1/responses",
    toolCall: (id, name, args) => ({
      id: "resp",
      status: "completed",
      output: [{ type: "function_call", id: "fc", call_id: id, name, arguments: args }],
      usage: {
        input_tokens: usage.input,
        input_tokens_details: { cached_tokens: usage.cached },
        output_tokens: usage.output,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: usage.input + usage.output,
      },
    }),
    text: (text) => ({
      id: "resp",
      status: "completed",
      output: [
        {
          type: "message",
          id: "m",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ],
    }),
    sentToolResult: (body) =>
      (body.input as { type?: string; output?: string }[]).findLast(
        (item) => item.type === "function_call_output",
      )?.output,
    sentInstructions: (body) => body.instructions as string,
  },
  {
    name: "openai-compatible",
    client: (baseURL) => new ChatCompletionsClient({ baseURL }),
    path: "/v1/chat/completions",
    toolCall: (id, name, args) => ({
      id: "c",
      object: "chat.completion",
      created: 0,
      model: "m",
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id, type: "function", function: { name, arguments: args } }],
          },
        },
      ],
      usage: {
        prompt_tokens: usage.input,
        completion_tokens: usage.output,
        total_tokens: usage.input + usage.output,
        prompt_tokens_details: { cached_tokens: usage.cached },
      },
    }),
    text: (text) => ({
      id: "c",
      object: "chat.completion",
      created: 0,
      model: "m",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }],
    }),
    sentToolResult: (body) =>
      (body.messages as { role: string; content: string }[]).findLast((m) => m.role === "tool")
        ?.content,
    sentInstructions: (body) =>
      (body.messages as { role: string; content: string }[]).find((m) => m.role === "system")
        ?.content,
  },
];

const request: ModelRequest = {
  model: "test-model",
  instructions: "Be brief.",
  items: [
    { type: "message", role: "user", content: [{ type: "text", text: "Read a.ts" }] },
    { type: "tool_call", callId: "c0", name: "read_file", arguments: '{"path":"a.ts"}' },
    { type: "tool_result", callId: "c0", outcome: "ok", content: [{ type: "text", text: "ABC" }] },
  ],
  tools: [{ name: "read_file", description: "Read", parameters: { type: "object" } }],
};

for (const fixture of fixtures) {
  describe(`model adapter contract: ${fixture.name}`, () => {
    const client = () => fixture.client(`${server.url.origin}/v1`);

    test("sends instructions and the whole conversation in its own format", async () => {
      next = { status: 200, body: fixture.text("ok") };
      await client().complete(request);
      expect(lastRequest?.path).toBe(fixture.path);
      expect(fixture.sentInstructions(lastRequest?.body ?? {})).toBe("Be brief.");
      expect(fixture.sentToolResult(lastRequest?.body ?? {})).toBe("ABC");
    });

    test("returns tool calls with their raw arguments and usage", async () => {
      next = { status: 200, body: fixture.toolCall("c1", "read_file", '{"path":"b.ts"}') };
      const response = await client().complete(request);
      expect(response.items).toEqual([
        { type: "tool_call", callId: "c1", name: "read_file", arguments: '{"path":"b.ts"}' },
      ]);
      expect(response.stopReason).toBe("tool_calls");
      expect(response.usage).toMatchObject({
        inputTokens: usage.input,
        outputTokens: usage.output,
        cachedInputTokens: usage.cached,
      });
    });

    test("returns text as an assistant message that ends the turn", async () => {
      next = { status: 200, body: fixture.text("Done.") };
      const response = await client().complete(request);
      expect(response.items).toEqual([
        { type: "message", role: "assistant", content: [{ type: "text", text: "Done." }] },
      ]);
      expect(response.stopReason).toBe("end_turn");
    });

    const failures: [string, Reply, Partial<ModelError>][] = [
      [
        "429 with retry-after",
        { status: 429, body: { error: { message: "slow" } }, headers: { "retry-after": "3" } },
        { kind: "retryable", retryAfterMs: 3000 },
      ],
      ["500", { status: 500, body: { error: { message: "boom" } } }, { kind: "retryable" }],
      ["401", { status: 401, body: { error: { message: "bad key" } } }, { kind: "fatal" }],
      [
        "context too long",
        {
          status: 400,
          body: { error: { message: "too long", code: "context_length_exceeded" } },
        },
        { kind: "context_overflow" },
      ],
    ];
    for (const [name, reply, expected] of failures) {
      test(`classifies ${name}`, async () => {
        next = reply;
        const error = await client()
          .complete(request)
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ModelError);
        expect(error).toMatchObject(expected);
      });
    }

    test("treats an unreachable server as retryable", async () => {
      const unreachable = fixture.client("http://127.0.0.1:9/v1");
      const error = await unreachable.complete(request).catch((e: unknown) => e);
      expect(error).toMatchObject({ kind: "retryable" });
    });
  });
}
