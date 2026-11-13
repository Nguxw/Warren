import { describe, expect, test } from "bun:test";
import { ModelError } from "@warren/core";
import { text } from "@warren/protocol";
import { APIConnectionError, APIError } from "openai";
import type { Response } from "openai/resources/responses/responses";
import {
  classifyError,
  fromResponse,
  OPENAI_RESPONSES,
  toInput,
  toRequestBody,
} from "../src/index.ts";

const reasoning = {
  type: "reasoning" as const,
  provider: OPENAI_RESPONSES,
  summary: "thinking",
  data: {
    id: "rs_1",
    encrypted_content: "ENC",
    summary: [{ type: "summary_text", text: "thinking" }],
  },
};

describe("toInput", () => {
  test("maps every conversation item to the Responses input format", () => {
    expect(
      toInput([
        { type: "message", role: "user", content: text("Fix it") },
        reasoning,
        { type: "message", role: "assistant", content: text("Looking") },
        { type: "tool_call", callId: "c1", name: "read_file", arguments: '{"path":"a"}' },
        { type: "tool_result", callId: "c1", outcome: "ok", content: text("abc") },
      ]),
    ).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "Fix it" }] },
      {
        type: "reasoning",
        id: "rs_1",
        encrypted_content: "ENC",
        summary: [{ type: "summary_text", text: "thinking" }],
      },
      { role: "assistant", content: "Looking" },
      { type: "function_call", call_id: "c1", name: "read_file", arguments: '{"path":"a"}' },
      { type: "function_call_output", call_id: "c1", output: "abc" },
    ]);
  });

  test("drops reasoning it cannot send back", () => {
    expect(
      toInput([
        { ...reasoning, provider: "anthropic" },
        { ...reasoning, data: { id: "rs_2" } },
      ]),
    ).toEqual([]);
  });
});

test("toRequestBody runs stateless and asks for encrypted reasoning", () => {
  const body = toRequestBody({
    model: "gpt-6.1-terra",
    instructions: "be brief",
    items: [],
    tools: [{ name: "read_file", description: "read", parameters: { type: "object" } }],
    reasoningEffort: "high",
    cacheKey: "task_1",
  });
  expect(body).toMatchObject({
    model: "gpt-6.1-terra",
    instructions: "be brief",
    store: false,
    include: ["reasoning.encrypted_content"],
    reasoning: { effort: "high" },
    prompt_cache_key: "task_1",
    tools: [{ type: "function", name: "read_file", strict: false }],
  });
  expect(body).not.toHaveProperty("max_output_tokens");
});

function response(partial: Partial<Response>): Response {
  return {
    id: "resp_1",
    status: "completed",
    output: [],
    usage: {
      input_tokens: 120,
      input_tokens_details: { cached_tokens: 100 },
      output_tokens: 30,
      output_tokens_details: { reasoning_tokens: 20 },
      total_tokens: 150,
    },
    ...partial,
  } as Response;
}

describe("fromResponse", () => {
  test("maps reasoning, messages and calls, and reads usage", () => {
    const result = fromResponse(
      response({
        output: [
          {
            type: "reasoning",
            id: "rs_1",
            encrypted_content: "ENC",
            summary: [{ type: "summary_text", text: "thinking" }],
          },
          {
            type: "message",
            id: "msg_1",
            role: "assistant",
            status: "completed",
            content: [
              { type: "output_text", text: "Looking", annotations: [] },
              { type: "refusal", refusal: "not that" },
            ],
          },
          {
            type: "function_call",
            id: "fc_1",
            call_id: "c1",
            name: "read_file",
            arguments: "{}",
          },
        ] as Response["output"],
      }),
    );
    expect(result.items).toEqual([
      reasoning,
      {
        type: "message",
        role: "assistant",
        content: [
          { type: "text", text: "Looking" },
          { type: "text", text: "[refusal] not that" },
        ],
      },
      { type: "tool_call", callId: "c1", name: "read_file", arguments: "{}" },
    ]);
    expect(result.stopReason).toBe("tool_calls");
    expect(result.usage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      cachedInputTokens: 100,
      reasoningTokens: 20,
    });
  });

  test("reports why an incomplete response stopped", () => {
    const cut = fromResponse(
      response({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }),
    );
    expect(cut.stopReason).toBe("max_tokens");
    expect(fromResponse(response({})).stopReason).toBe("end_turn");
  });

  test("a failed response becomes a ModelError", () => {
    expect(() =>
      fromResponse(
        response({ status: "failed", error: { code: "server_error", message: "boom" } }),
      ),
    ).toThrow(ModelError);
  });
});

describe("classifyError", () => {
  const apiError = (status: number, code?: string, message = "msg", headers = new Headers()) =>
    APIError.generate(status, { error: { message, code } }, message, headers);

  test("normalises provider errors into three kinds", () => {
    expect(classifyError(apiError(429)).kind).toBe("retryable");
    expect(classifyError(apiError(503)).kind).toBe("retryable");
    expect(classifyError(apiError(429, "insufficient_quota")).kind).toBe("fatal");
    expect(classifyError(apiError(400, "context_length_exceeded")).kind).toBe("context_overflow");
    expect(classifyError(apiError(401)).kind).toBe("fatal");
    expect(classifyError(new APIConnectionError({ message: "reset" })).kind).toBe("retryable");
  });

  test("honours retry-after", () => {
    const headers = new Headers({ "retry-after": "7" });
    expect(classifyError(apiError(429, undefined, "slow down", headers)).retryAfterMs).toBe(7000);
  });
});
