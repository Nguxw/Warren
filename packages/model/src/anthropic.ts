import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  Message,
  MessageCreateParamsNonStreaming,
  MessageParam,
} from "@anthropic-ai/sdk/resources/messages/messages";
import {
  type ModelClient,
  ModelError,
  type ModelRequest,
  type ModelResponse,
  type ReasoningEffort,
} from "@warren/core";
import type { ConversationItem, ModelOutputItem, StopReason } from "@warren/protocol";
import { type Files, joinText, sentFile } from "./files.ts";

/**
 * Anthropic Messages API adapter (official SDK).
 *
 * Thinking blocks are kept in the log exactly as returned, signature included, and sent back
 * unchanged on later requests, as the API requires; reasoning from other providers is dropped.
 * Top-level `cache_control` lets the API cache the longest stable prefix. The SDK's own retries
 * are off: the loop decides retries for every provider in one place.
 */

export const ANTHROPIC = "anthropic";

export interface AnthropicOptions {
  apiKey: string;
  baseURL?: string;
  timeoutMs?: number;
}

const DEFAULT_MAX_TOKENS = 16_000;

export class AnthropicClient implements ModelClient {
  readonly provider = ANTHROPIC;
  private readonly client: Anthropic;

  constructor(options: AnthropicOptions) {
    this.client = new Anthropic({
      apiKey: options.apiKey,
      maxRetries: 0,
      timeout: options.timeoutMs ?? 10 * 60_000,
      ...(options.baseURL && { baseURL: options.baseURL }),
    });
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    let message: Message;
    try {
      message = await this.client.messages.create(toAnthropicRequest(request), {
        ...(request.signal && { signal: request.signal }),
      });
    } catch (error) {
      throw classifyAnthropicError(error);
    }
    return fromAnthropicMessage(message);
  }
}

const EFFORT: Record<ReasoningEffort, "low" | "medium" | "high" | "xhigh"> = {
  none: "low",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};

export function toAnthropicRequest(request: ModelRequest): MessageCreateParamsNonStreaming {
  return {
    model: request.model,
    max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
    system: request.instructions,
    messages: toAnthropicMessages(request.items, request.files),
    cache_control: { type: "ephemeral" },
    ...(request.tools.length > 0 && {
      tools: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters as Anthropic.Tool.InputSchema,
      })),
    }),
    ...(request.reasoningEffort && { output_config: { effort: EFFORT[request.reasoningEffort] } }),
  };
}

/** Groups items into alternating user and assistant messages. */
export function toAnthropicMessages(
  items: readonly ConversationItem[],
  files?: Files,
): MessageParam[] {
  const messages: MessageParam[] = [];
  const push = (role: "user" | "assistant", block: ContentBlockParam) => {
    const last = messages.at(-1);
    if (last?.role === role && Array.isArray(last.content)) {
      (last.content as ContentBlockParam[]).push(block);
    } else {
      messages.push({ role, content: [block] } as MessageParam);
    }
  };

  for (const item of items) {
    switch (item.type) {
      case "message": {
        const sent = item.content.flatMap((part) => sentFile(part, files) ?? []);
        // Files first, as Anthropic recommends, then the text that refers to them.
        for (const file of sent) {
          push(
            "user",
            file.mediaType === "application/pdf"
              ? {
                  type: "document",
                  source: { type: "base64", media_type: "application/pdf", data: file.base64 },
                  title: file.name,
                }
              : {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: file.mediaType as "image/png",
                    data: file.base64,
                  },
                },
          );
        }
        push(item.role, { type: "text", text: joinText(item.content) || " " });
        break;
      }
      case "reasoning":
        // Only Anthropic's own thinking blocks can go back, and only exactly as they came.
        if (item.provider === ANTHROPIC && item.data && typeof item.data === "object") {
          push("assistant", item.data as ContentBlockParam);
        }
        break;
      case "tool_call":
        push("assistant", {
          type: "tool_use",
          id: item.callId,
          name: item.name,
          input: parseInput(item.arguments),
        });
        break;
      case "tool_result":
        push("user", {
          type: "tool_result",
          tool_use_id: item.callId,
          content: joinText(item.content),
          ...(item.outcome !== "ok" && { is_error: true }),
        });
        break;
    }
  }
  return messages;
}

export function fromAnthropicMessage(message: Message): ModelResponse {
  const items: ModelOutputItem[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      items.push({
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: block.text }],
      });
    } else if (block.type === "thinking") {
      items.push({
        type: "reasoning",
        provider: ANTHROPIC,
        ...(block.thinking && { summary: block.thinking }),
        data: { type: "thinking", thinking: block.thinking, signature: block.signature },
      });
    } else if (block.type === "redacted_thinking") {
      items.push({
        type: "reasoning",
        provider: ANTHROPIC,
        data: { type: "redacted_thinking", data: block.data },
      });
    } else if (block.type === "tool_use") {
      items.push({
        type: "tool_call",
        callId: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input),
      });
    }
  }

  const usage = message.usage;
  const cached = usage.cache_read_input_tokens ?? 0;
  const written = usage.cache_creation_input_tokens ?? 0;
  return {
    items,
    stopReason: stopReason(message.stop_reason),
    usage: {
      inputTokens: usage.input_tokens + cached + written,
      outputTokens: usage.output_tokens,
      cachedInputTokens: cached,
    },
  };
}

function stopReason(reason: Message["stop_reason"]): StopReason {
  switch (reason) {
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    default:
      return "other";
  }
}

export function classifyAnthropicError(error: unknown): ModelError {
  if (error instanceof ModelError) return error;
  if (error instanceof Anthropic.APIUserAbortError)
    return new ModelError("retryable", "request aborted");
  if (error instanceof Anthropic.APIConnectionError) {
    return new ModelError("retryable", `connection: ${error.message}`);
  }
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 0;
    if (status === 400 && /prompt is too long|too long|context/i.test(error.message)) {
      return new ModelError("context_overflow", error.message);
    }
    // 529 is Anthropic's "overloaded".
    if (status === 408 || status === 409 || status === 429 || status >= 500) {
      return new ModelError("retryable", error.message, retryAfterMs(error.headers));
    }
    return new ModelError("fatal", error.message);
  }
  return new ModelError("fatal", error instanceof Error ? error.message : String(error));
}

function retryAfterMs(headers: Headers | undefined): number | undefined {
  const seconds = Number(headers?.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

function parseInput(args: string): Record<string, unknown> {
  try {
    const value = JSON.parse(args);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
