import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConversationItem } from "@warren/protocol";
import { ChatCompletionsClient, OpenAIResponsesClient } from "../src/index.ts";

/**
 * Calls the real OpenAI API. Off by default; run with `WARREN_LIVE=1 bun test packages/model`.
 * Costs well under one cent.
 */

function apiKey(): string | undefined {
  if (process.env.WARREN_OPENAI_API_KEY) return process.env.WARREN_OPENAI_API_KEY;
  const file = join(process.env.WARREN_HOME ?? join(homedir(), ".warren"), "credentials.env");
  if (!existsSync(file)) return undefined;
  return /^WARREN_OPENAI_API_KEY=(.+)$/m.exec(readFileSync(file, "utf8"))?.[1]?.trim();
}

const key = process.env.WARREN_LIVE === "1" ? apiKey() : undefined;

test.skipIf(!key)(
  "round-trips encrypted reasoning and a tool call through the real API",
  async () => {
    const client = new OpenAIResponsesClient({ apiKey: key as string });
    const tools = [
      {
        name: "run_tests",
        description: "Run the test suite filtered by name and return failures",
        parameters: {
          type: "object",
          properties: { filter: { type: "string" } },
          required: ["filter"],
        },
      },
    ];
    const items: ConversationItem[] = [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "text",
            text: "A date parser accepts '2024-02-30'. Think carefully about which single test filter (dates, leap, parse) is most likely to expose it, call run_tests with it, then explain the failure in one sentence.",
          },
        ],
      },
    ];
    const request = {
      model: "gpt-6.1-sol",
      instructions: "You are a careful engineer.",
      tools,
      reasoningEffort: "high" as const,
      cacheKey: "warren-live-test",
    };

    const first = await client.complete({ ...request, items });
    const call = first.items.find((item) => item.type === "tool_call");
    expect(call).toBeDefined();
    expect(first.stopReason).toBe("tool_calls");
    expect(first.items.some((item) => item.type === "reasoning")).toBe(true);

    items.push(...first.items, {
      type: "tool_result",
      callId: call?.type === "tool_call" ? call.callId : "",
      outcome: "ok",
      content: [{ type: "text", text: "1 failure: test_feb_30_is_rejected" }],
    });
    const second = await client.complete({ ...request, items });
    expect(second.stopReason).toBe("end_turn");
    expect(second.items.some((item) => item.type === "message")).toBe(true);
  },
  120_000,
);

test.skipIf(!key)(
  "the OpenAI-compatible adapter completes a tool round trip against a real endpoint",
  async () => {
    const client = new ChatCompletionsClient({
      baseURL: "https://api.openai.com/v1",
      apiKey: key as string,
    });
    const request = {
      model: "gpt-6-luna",
      // OpenAI's Chat Completions refuses function tools alongside reasoning for this model.
      reasoningEffort: "none" as const,
      instructions: "Use the tool, then answer in one short sentence.",
      tools: [
        {
          name: "read_file",
          description: "Read a text file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
    };
    const items: ConversationItem[] = [
      {
        type: "message",
        role: "user",
        content: [{ type: "text", text: "What is the first word of notes.txt?" }],
      },
    ];
    const first = await client.complete({ ...request, items });
    const call = first.items.find((item) => item.type === "tool_call");
    expect(first.stopReason).toBe("tool_calls");
    expect(call?.type === "tool_call" && JSON.parse(call.arguments)).toEqual({ path: "notes.txt" });
    expect(first.usage.inputTokens).toBeGreaterThan(0);

    items.push(...first.items, {
      type: "tool_result",
      callId: call?.type === "tool_call" ? call.callId : "",
      outcome: "ok",
      content: [{ type: "text", text: "Pineapple is the first word." }],
    });
    const second = await client.complete({ ...request, items });
    expect(second.stopReason).toBe("end_turn");
    const answer = second.items.find((item) => item.type === "message");
    expect(answer?.type === "message" && answer.content[0]?.text).toContain("Pineapple");
  },
  120_000,
);
