import { expect, test } from "bun:test";
import type { Message } from "@anthropic-ai/sdk/resources/messages/messages";
import { text } from "@warren/protocol";
import {
  ANTHROPIC,
  fromAnthropicMessage,
  toAnthropicMessages,
  toAnthropicRequest,
} from "../src/index.ts";

test("thinking blocks round-trip unchanged; other providers' reasoning is dropped", () => {
  const response = fromAnthropicMessage({
    id: "m",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [
      { type: "thinking", thinking: "", signature: "SIG" },
      { type: "text", text: "Checking", citations: null },
      { type: "tool_use", id: "tu1", name: "read_file", input: { path: "a.ts" } },
    ],
    stop_reason: "tool_use",
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 90,
      cache_creation_input_tokens: 0,
    },
  } as unknown as Message);
  expect(response.stopReason).toBe("tool_calls");
  expect(response.usage).toEqual({ inputTokens: 100, outputTokens: 5, cachedInputTokens: 90 });

  const messages = toAnthropicMessages([
    { type: "message", role: "user", content: text("Fix it") },
    { type: "reasoning", provider: "openai-responses", data: { id: "rs" } },
    ...response.items,
    { type: "tool_result", callId: "tu1", outcome: "error", content: text("missing") },
    { type: "message", role: "user", content: text("also check b.ts") },
  ]);
  expect(messages).toEqual([
    { role: "user", content: [{ type: "text", text: "Fix it" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "SIG" },
        { type: "text", text: "Checking" },
        { type: "tool_use", id: "tu1", name: "read_file", input: { path: "a.ts" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu1", content: "missing", is_error: true },
        { type: "text", text: "also check b.ts" },
      ],
    },
  ]);
  expect(response.items[0]).toMatchObject({ provider: ANTHROPIC });
});

test("requests carry effort, caching and a generous output limit", () => {
  const body = toAnthropicRequest({
    model: "claude-opus-5-5",
    instructions: "Be brief",
    items: [{ type: "message", role: "user", content: text("hi") }],
    tools: [],
    reasoningEffort: "high",
  });
  expect(body).toMatchObject({
    model: "claude-opus-5-5",
    system: "Be brief",
    max_tokens: 16000,
    cache_control: { type: "ephemeral" },
    output_config: { effort: "high" },
  });
  expect(body).not.toHaveProperty("tools");
});
