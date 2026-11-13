import { type ModelClient, ModelError, type ModelRequest, type ModelResponse } from "@warren/core";
import type { ConversationItem, ModelOutputItem, StopReason } from "@warren/protocol";
import OpenAI from "openai";
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseInputItem,
} from "openai/resources/responses/responses";
import { classifyError } from "./errors.ts";

/**
 * OpenAI Responses API adapter.
 *
 * Runs stateless (`store: false`): every request carries the whole conversation, and reasoning
 * is round-tripped as encrypted content, so the task log alone is enough to continue a task.
 * The SDK's own retries are off; the loop decides retries for every provider in one place.
 */

export const OPENAI_RESPONSES = "openai-responses";

/** What a reasoning item keeps in `data`: exactly what the API needs to accept it back. */
interface OpenAIReasoningData {
  id: string;
  encrypted_content: string;
  summary: { type: "summary_text"; text: string }[];
}

export interface OpenAIResponsesOptions {
  apiKey: string;
  baseURL?: string;
  /** Per request; long reasoning turns can take minutes. */
  timeoutMs?: number;
}

export class OpenAIResponsesClient implements ModelClient {
  readonly provider = OPENAI_RESPONSES;
  private readonly client: OpenAI;

  constructor(options: OpenAIResponsesOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      maxRetries: 0,
      timeout: options.timeoutMs ?? 10 * 60_000,
      ...(options.baseURL && { baseURL: options.baseURL }),
    });
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    let response: Response;
    try {
      response = await this.client.responses.create(toRequestBody(request), {
        ...(request.signal && { signal: request.signal }),
      });
    } catch (error) {
      throw classifyError(error);
    }
    return fromResponse(response);
  }
}

export function toRequestBody(request: ModelRequest): ResponseCreateParamsNonStreaming {
  return {
    model: request.model,
    instructions: request.instructions,
    input: toInput(request.items),
    tools: request.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      // Warren validates arguments itself; strict mode would forbid optional parameters.
      strict: false,
    })),
    store: false,
    include: ["reasoning.encrypted_content"],
    ...(request.reasoningEffort && { reasoning: { effort: request.reasoningEffort } }),
    ...(request.maxOutputTokens && { max_output_tokens: request.maxOutputTokens }),
    ...(request.cacheKey && { prompt_cache_key: request.cacheKey }),
  };
}

export function toInput(items: readonly ConversationItem[]): ResponseInputItem[] {
  const input: ResponseInputItem[] = [];
  for (const item of items) {
    switch (item.type) {
      case "message":
        if (item.role === "user") {
          input.push({
            type: "message",
            role: "user",
            content: item.content.map((part) => ({ type: "input_text", text: part.text })),
          });
        } else {
          input.push({ role: "assistant", content: joinText(item.content) });
        }
        break;
      case "reasoning": {
        // Reasoning from another provider, or without its encrypted state, cannot be sent back.
        const data = item.data as Partial<OpenAIReasoningData> | undefined;
        if (item.provider !== OPENAI_RESPONSES || !data?.id || !data.encrypted_content) break;
        input.push({
          type: "reasoning",
          id: data.id,
          encrypted_content: data.encrypted_content,
          summary: data.summary ?? [],
        });
        break;
      }
      case "tool_call":
        input.push({
          type: "function_call",
          call_id: item.callId,
          name: item.name,
          arguments: item.arguments,
        });
        break;
      case "tool_result":
        input.push({
          type: "function_call_output",
          call_id: item.callId,
          output: joinText(item.content),
        });
        break;
    }
  }
  return input;
}

export function fromResponse(response: Response): ModelResponse {
  if (response.status === "failed") {
    const code = response.error?.code ?? "unknown";
    const retryable = code === "server_error" || code === "rate_limit_exceeded";
    throw new ModelError(retryable ? "retryable" : "fatal", `${code}: ${response.error?.message}`);
  }

  const items: ModelOutputItem[] = [];
  for (const output of response.output) {
    if (output.type === "reasoning") {
      if (!output.encrypted_content) continue;
      const summary = output.summary.map((s) => s.text).join("\n");
      const data: OpenAIReasoningData = {
        id: output.id,
        encrypted_content: output.encrypted_content,
        summary: output.summary.map((s) => ({ type: "summary_text", text: s.text })),
      };
      items.push({
        type: "reasoning",
        provider: OPENAI_RESPONSES,
        data,
        ...(summary && { summary }),
      });
    } else if (output.type === "message") {
      const content = output.content.map((part) => ({
        type: "text" as const,
        text: part.type === "output_text" ? part.text : `[refusal] ${part.refusal}`,
      }));
      if (content.length > 0) items.push({ type: "message", role: "assistant", content });
    } else if (output.type === "function_call") {
      items.push({
        type: "tool_call",
        callId: output.call_id,
        name: output.name,
        arguments: output.arguments,
      });
    }
    // Built-in tool outputs (web search and others) are not requested, so they are not mapped.
  }

  const usage = response.usage;
  return {
    items,
    stopReason: stopReason(response, items),
    usage: {
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      ...(usage?.input_tokens_details?.cached_tokens !== undefined && {
        cachedInputTokens: usage.input_tokens_details.cached_tokens,
      }),
      ...(usage?.output_tokens_details?.reasoning_tokens !== undefined && {
        reasoningTokens: usage.output_tokens_details.reasoning_tokens,
      }),
    },
  };
}

function stopReason(response: Response, items: ModelOutputItem[]): StopReason {
  if (items.some((item) => item.type === "tool_call")) return "tool_calls";
  if (response.status === "incomplete") {
    const reason = response.incomplete_details?.reason;
    if (reason === "max_output_tokens") return "max_tokens";
    if (reason === "content_filter") return "refusal";
    return "other";
  }
  return "end_turn";
}

function joinText(parts: readonly { text: string }[]): string {
  return parts.map((part) => part.text).join("\n");
}
