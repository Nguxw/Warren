import { describe, expect, test } from "bun:test";
import { text } from "@warren/protocol";
import type { ChatCompletion } from "openai/resources/chat/completions/completions";
import { fromCompletion, OPENAI_COMPATIBLE, toChatRequest, toMessages } from "../src/index.ts";

describe("toMessages", () => {
  test("merges one response's text and calls into a single assistant message", () => {
    expect(
      toMessages([
        { type: "message", role: "user", content: text("Fix it") },
        { type: "reasoning", provider: "openai-responses", data: { id: "rs" } },
        { type: "message", role: "assistant", content: text("Looking") },
        { type: "tool_call", callId: "c1", name: "read_file", arguments: "{}" },
        { type: "tool_call", callId: "c2", name: "search", arguments: '{"pattern":"x"}' },
        { type: "tool_result", callId: "c1", outcome: "ok", content: text("A") },
        { type: "tool_result", callId: "c2", outcome: "error", content: text("B") },
        { type: "message", role: "assistant", content: text("Done") },
      ]),
    ).toEqual([
      { role: "user", content: "Fix it" },
      {
        role: "assistant",
        content: "Looking",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } },
          {
            id: "c2",
            type: "function",
            function: { name: "search", arguments: '{"pattern":"x"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "A" },
      { role: "tool", tool_call_id: "c2", content: "B" },
      { role: "assistant", content: "Done" },
    ]);
  });

  test("a response with only reasoning sends nothing", () => {
    expect(toMessages([{ type: "reasoning", provider: OPENAI_COMPATIBLE, data: null }])).toEqual(
      [],
    );
  });
});

test("toChatRequest puts instructions first and leaves out unset options", () => {
  const body = toChatRequest({
    model: "deepseek-chat",
    instructions: "Be brief",
    items: [],
    tools: [],
  });
  expect(body).toEqual({
    model: "deepseek-chat",
    messages: [{ role: "system", content: "Be brief" }],
  });
});

test("fromCompletion keeps DeepSeek reasoning and cache hits", () => {
  const completion = {
    id: "c",
    object: "chat.completion",
    created: 0,
    model: "deepseek-reasoner",
    choices: [
      {
        index: 0,
        finish_reason: "length",
        logprobs: null,
        message: {
          role: "assistant",
          content: "partial",
          refusal: null,
          reasoning_content: "thinking hard",
        },
      },
    ],
    usage: {
      prompt_tokens: 500,
      completion_tokens: 50,
      total_tokens: 550,
      prompt_cache_hit_tokens: 400,
    },
  } as unknown as ChatCompletion;
  const response = fromCompletion(completion);
  expect(response.items).toEqual([
    { type: "reasoning", provider: OPENAI_COMPATIBLE, summary: "thinking hard", data: null },
    { type: "message", role: "assistant", content: text("partial") },
  ]);
  expect(response.stopReason).toBe("max_tokens");
  expect(response.usage).toEqual({ inputTokens: 500, outputTokens: 50, cachedInputTokens: 400 });
});
