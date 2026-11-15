import { z } from "zod";

/**
 * Warren's provider-neutral conversation format.
 *
 * Model adapters translate between these items and each provider's wire format.
 * The event log stores only these items, never a provider's raw request or response,
 * so a task can switch models and logs stay readable after an SDK changes.
 */

export const TextPart = z.object({
  type: z.literal("text"),
  text: z.string(),
});

/**
 * A file a person attached. Its bytes stay on disk with the task (`attachments/<name>`); the log
 * keeps only this reference, so a task's log stays small however large the files are.
 */
export const FilePart = z.object({
  type: z.literal("file"),
  /** The file's name among the task's attachments, unique within the task. */
  name: z.string(),
  mediaType: z.string(),
  size: z.number().int().nonnegative(),
});
export type FilePart = z.infer<typeof FilePart>;

/** Union kept open on purpose: new kinds of content become new members, not new fields. */
export const ContentPart = z.discriminatedUnion("type", [TextPart, FilePart]);
export type ContentPart = z.infer<typeof ContentPart>;

export const UserMessageItem = z.object({
  type: z.literal("message"),
  role: z.literal("user"),
  content: z.array(ContentPart),
});
export type UserMessageItem = z.infer<typeof UserMessageItem>;

export const AssistantMessageItem = z.object({
  type: z.literal("message"),
  role: z.literal("assistant"),
  content: z.array(ContentPart),
});
export type AssistantMessageItem = z.infer<typeof AssistantMessageItem>;

/**
 * Provider-private reasoning state (for example OpenAI encrypted reasoning, Anthropic thinking
 * signatures). Only the adapter named in `provider` may interpret `data`; other adapters drop
 * the item when a task switches models.
 */
export const ReasoningItem = z.object({
  type: z.literal("reasoning"),
  provider: z.string(),
  summary: z.string().optional(),
  data: z.unknown(),
});
export type ReasoningItem = z.infer<typeof ReasoningItem>;

export const ToolCallItem = z.object({
  type: z.literal("tool_call"),
  callId: z.string(),
  name: z.string(),
  /** Raw JSON text exactly as the model produced it; it may be invalid and is checked at run time. */
  arguments: z.string(),
});
export type ToolCallItem = z.infer<typeof ToolCallItem>;

export const ToolOutcome = z.enum([
  "ok",
  "error",
  /** Started but the process stopped before it finished; the effect is unknown. */
  "interrupted",
  /** Refused by the Grant or by a person. */
  "denied",
]);
export type ToolOutcome = z.infer<typeof ToolOutcome>;

export const ToolResultItem = z.object({
  type: z.literal("tool_result"),
  callId: z.string(),
  outcome: ToolOutcome,
  content: z.array(ContentPart),
});
export type ToolResultItem = z.infer<typeof ToolResultItem>;

/** What a model response may contain. */
export const ModelOutputItem = z.union([AssistantMessageItem, ReasoningItem, ToolCallItem]);
export type ModelOutputItem = z.infer<typeof ModelOutputItem>;

/** Everything that can appear in a task's conversation history. */
export type ConversationItem =
  | UserMessageItem
  | AssistantMessageItem
  | ReasoningItem
  | ToolCallItem
  | ToolResultItem;

export const Usage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  /** Computed by Warren from the model's price table at response time. */
  costUsd: z.number().nonnegative().optional(),
});
export type Usage = z.infer<typeof Usage>;

export function text(value: string): ContentPart[] {
  return [{ type: "text", text: value }];
}

/** The text of some content, without its files. */
export function textOf(parts: readonly ContentPart[]): string {
  return parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

/** The files in some content. */
export function filesOf(parts: readonly ContentPart[]): FilePart[] {
  return parts.filter((part): part is FilePart => part.type === "file");
}
