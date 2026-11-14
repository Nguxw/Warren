import type {
  ConversationItem,
  EventDraft,
  Grant,
  ModelErrorKind,
  ModelOutputItem,
  StopReason,
  ToolEffect,
  Usage,
} from "@warren/protocol";
import type { z } from "zod";
import type { TaskState } from "./task-state.ts";

/**
 * The interfaces the core depends on. Adapters implement them; the daemon wires them together.
 */

// ---------------------------------------------------------------- model

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments object. */
  parameters: Record<string, unknown>;
}

export interface ModelRequest {
  model: string;
  /** System instructions, sent separately from the conversation. */
  instructions: string;
  items: readonly ConversationItem[];
  tools: readonly ToolSpec[];
  reasoningEffort?: ReasoningEffort;
  maxOutputTokens?: number;
  /** Stable per task, so providers that cache by key can reuse the prefix. */
  cacheKey?: string;
  signal?: AbortSignal;
}

export interface ModelResponse {
  items: ModelOutputItem[];
  stopReason: StopReason;
  usage: Usage;
}

/** Adapters throw this, normalised, so the loop decides retries for every provider alike. */
export class ModelError extends Error {
  override name = "ModelError";
  constructor(
    readonly kind: ModelErrorKind,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export interface ModelClient {
  /** Adapter id recorded in the log, such as `openai-responses`. */
  readonly provider: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

/** Per million tokens, in US dollars. */
export interface ModelPrice {
  input: number;
  cachedInput?: number;
  output: number;
}

/** A configured model role (`main`, `cheap`, `hard`) resolved to a client and settings. */
export interface ResolvedModel {
  client: ModelClient;
  model: string;
  reasoningEffort?: ReasoningEffort;
  maxOutputTokens?: number;
  price?: ModelPrice;
  /** Context window in tokens; compaction keeps requests well below it. */
  contextWindow?: number;
}

export interface ModelResolver {
  resolve(role: string): ResolvedModel;
}

// ---------------------------------------------------------------- tools

export interface ToolContext {
  taskId: string;
  /** Absolute path of the task's workspace; tools must stay inside it. */
  workspace: string;
  /** The task's private scratch directory (temp files, tool caches), outside the workspace. */
  scratch: string;
  grant: Grant;
  signal: AbortSignal;
}

export interface ToolOutput {
  outcome: "ok" | "error";
  text: string;
}

export interface Tool<A = unknown> {
  name: string;
  description: string;
  parameters: z.ZodType<A>;
  /**
   * The JSON Schema the model sees, when the tool comes with its own (an MCP tool) rather than
   * one derived from `parameters`; `parameters` then only checks that arguments are an object.
   */
  inputSchema?: Record<string, unknown>;
  effect: ToolEffect;
  /**
   * Privileged tools run in the trusted daemon with credentials the sandbox never sees, such as
   * pushing or opening a pull request. A task can call one only if its Grant lists it.
   */
  privileged?: boolean;
  /** `required`: a person approves each call before it runs. */
  approval?: "required" | "auto";
  /** One line telling the person what an approval would allow. */
  describe?(args: A, context: Omit<ToolContext, "signal">): string;
  run(args: A, context: ToolContext): Promise<ToolOutput>;
}

// ---------------------------------------------------------------- log

/** The part of the store the loop needs. */
export interface TaskLog {
  get(taskId: string): TaskState | undefined;
  append(taskId: string, drafts: readonly EventDraft[]): TaskState;
}

export interface Clock {
  now(): number;
}
