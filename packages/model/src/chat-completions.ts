import type { ModelClient, ModelRequest, ModelResponse } from "@warren/core";
import { ModelError } from "@warren/core";
import type { ContentPart, ConversationItem, ModelOutputItem, StopReason } from "@warren/protocol";
import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionAssistantMessageParam,
  ChatCompletionContentPart,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions/completions";
import { classifyError } from "./errors.ts";
import { dataUrl, type Files, joinText, sentFile } from "./files.ts";

/**
 * Adapter for OpenAI-compatible Chat Completions APIs: DeepSeek, Qwen (DashScope), Ollama,
 * vLLM and others, and OpenAI itself.
 *
 * Only the common subset of the protocol is used, so one adapter covers every such provider.
 * Provider reasoning text (DeepSeek's `reasoning_content`) is kept in the log for reading but
 * not sent back, which is what those APIs expect between turns.
 */

export const OPENAI_COMPATIBLE = "openai-compatible";

export interface ChatCompletionsOptions {
  baseURL: string;
  /** Local servers such as Ollama need none. */
  apiKey?: string;
  timeoutMs?: number;
}

export class ChatCompletionsClient implements ModelClient {
  readonly provider = OPENAI_COMPATIBLE;
  private readonly client: OpenAI;

  constructor(options: ChatCompletionsOptions) {
    this.client = new OpenAI({
      baseURL: options.baseURL,
      apiKey: options.apiKey || "unused",
      maxRetries: 0,
      timeout: options.timeoutMs ?? 10 * 60_000,
    });
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    let completion: ChatCompletion;
    try {
      completion = await this.client.chat.completions.create(toChatRequest(request), {
        ...(request.signal && { signal: request.signal }),
      });
    } catch (error) {
      throw classifyError(error);
    }
    return fromCompletion(completion);
  }
}

export function toChatRequest(request: ModelRequest): ChatCompletionCreateParamsNonStreaming {
  return {
    model: request.model,
    messages: [
      { role: "system", content: request.instructions },
      ...toMessages(request.items, request.files),
    ],
    ...(request.tools.length > 0 && {
      tools: request.tools.map((tool) => ({
        type: "function" as const,
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      })),
    }),
    ...(request.reasoningEffort && { reasoning_effort: request.reasoningEffort }),
    ...(request.maxOutputTokens && { max_tokens: request.maxOutputTokens }),
  };
}

/**
 * One model response may hold text, reasoning and several calls as separate items; Chat
 * Completions wants them as one assistant message. Consecutive assistant-side items are merged.
 */
export function toMessages(
  items: readonly ConversationItem[],
  files?: Files,
): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = [];
  let assistant:
    | { texts: string[]; calls: NonNullable<ChatCompletionAssistantMessageParam["tool_calls"]> }
    | undefined;

  const flush = () => {
    if (assistant && (assistant.texts.length > 0 || assistant.calls.length > 0)) {
      messages.push({
        role: "assistant",
        content: assistant.texts.length > 0 ? assistant.texts.join("\n") : null,
        ...(assistant.calls.length > 0 && { tool_calls: assistant.calls }),
      });
    }
    assistant = undefined;
  };

  for (const item of items) {
    switch (item.type) {
      case "message":
        if (item.role === "user") {
          flush();
          messages.push({ role: "user", content: userContent(item.content, files) });
        } else {
          assistant ??= { texts: [], calls: [] };
          assistant.texts.push(joinText(item.content));
        }
        break;
      case "reasoning":
        break;
      case "tool_call":
        assistant ??= { texts: [], calls: [] };
        assistant.calls.push({
          id: item.callId,
          type: "function",
          function: { name: item.name, arguments: item.arguments },
        });
        break;
      case "tool_result":
        flush();
        messages.push({ role: "tool", tool_call_id: item.callId, content: joinText(item.content) });
        break;
    }
  }
  flush();
  return messages;
}

/** Fields some compatible providers add to the standard response. */
interface ProviderExtras {
  message?: { reasoning_content?: string | null };
  usage?: { prompt_cache_hit_tokens?: number };
}

export function fromCompletion(completion: ChatCompletion): ModelResponse {
  const choice = completion.choices[0];
  if (!choice) throw new ModelError("retryable", "response had no choices");
  const message = choice.message;
  const extras = choice as unknown as ProviderExtras;

  const items: ModelOutputItem[] = [];
  const reasoning = extras.message?.reasoning_content;
  if (reasoning) {
    items.push({ type: "reasoning", provider: OPENAI_COMPATIBLE, summary: reasoning, data: null });
  }
  const text = [message.content, message.refusal && `[refusal] ${message.refusal}`]
    .filter(Boolean)
    .join("\n");
  if (text) items.push({ type: "message", role: "assistant", content: [{ type: "text", text }] });
  for (const call of message.tool_calls ?? []) {
    if (call.type !== "function") continue;
    items.push({
      type: "tool_call",
      callId: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    });
  }

  const usage = completion.usage;
  const cached =
    usage?.prompt_tokens_details?.cached_tokens ??
    (usage as ProviderExtras["usage"] | undefined)?.prompt_cache_hit_tokens;
  const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens;
  return {
    items,
    stopReason: stopReason(choice.finish_reason, items),
    usage: {
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      ...(cached !== undefined && { cachedInputTokens: cached }),
      ...(reasoningTokens !== undefined && { reasoningTokens }),
    },
  };
}

function stopReason(reason: string | null, items: ModelOutputItem[]): StopReason {
  if (items.some((item) => item.type === "tool_call")) return "tool_calls";
  if (reason === "length") return "max_tokens";
  if (reason === "content_filter") return "refusal";
  if (reason === "stop") return "end_turn";
  return "other";
}

/** Plain text unless a file goes along; text-only models then see the same request as before. */
function userContent(
  parts: readonly ContentPart[],
  files: Files | undefined,
): string | ChatCompletionContentPart[] {
  const sent = parts.map((part) => sentFile(part, files));
  if (!sent.some(Boolean)) return joinText(parts);
  return parts.flatMap((part, i): ChatCompletionContentPart[] => {
    if (part.type === "text") return [{ type: "text", text: part.text }];
    const file = sent[i];
    if (!file) return [];
    return file.mediaType === "application/pdf"
      ? [{ type: "file", file: { filename: file.name, file_data: dataUrl(file) } }]
      : [{ type: "image_url", image_url: { url: dataUrl(file) } }];
  });
}
