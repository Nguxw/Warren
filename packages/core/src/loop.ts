import {
  type EventDraft,
  type ToolCallItem,
  type ToolOutcome,
  text,
  type Usage,
} from "@warren/protocol";
import { z } from "zod";
import {
  ModelError,
  type ModelPrice,
  type ModelResolver,
  type TaskLog,
  type Tool,
  type ToolSpec,
} from "./ports.ts";
import { systemPrompt } from "./prompt.ts";
import { type NextStep, nextStep, type RunningCall, type TaskState } from "./task-state.ts";

/**
 * The agent loop. It keeps no state of its own: each turn reads the task's state from the log,
 * takes the step `nextStep` names, and appends what happened. Stopping it at any point and
 * starting it again continues the same work.
 */

export interface LoopDeps {
  log: TaskLog;
  models: ModelResolver;
  tools: readonly Tool[];
  workspaceOf(taskId: string): string;
  scratchOf(taskId: string): string;
  newId(): string;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  limits?: Partial<LoopLimits>;
}

export interface LoopLimits {
  /** Model calls a task may make when its Grant sets no limit. */
  defaultMaxModelCalls: number;
  /** Retryable model failures in a row before the task pauses. */
  maxModelRetries: number;
  /** Longest wait between retries. */
  maxBackoffMs: number;
}

export const DEFAULT_LIMITS: LoopLimits = {
  defaultMaxModelCalls: 200,
  maxModelRetries: 6,
  maxBackoffMs: 60_000,
};

/** Tools the loop handles itself, because they change the task rather than the workspace. */
export const CONTROL_TOOLS = {
  ask_user: {
    description:
      "Ask the user one concrete question and wait for the answer. Use only for decisions you cannot make or find out yourself.",
    parameters: z.object({ question: z.string().describe("The question, short and specific") }),
  },
  complete_task: {
    description:
      "Finish the task. Call this once the work is done (or cannot be done), with a short summary of the result.",
    parameters: z.object({
      summary: z
        .string()
        .describe("What changed, how it was verified, and anything left open or unfinished"),
    }),
  },
} as const;

type ControlToolName = keyof typeof CONTROL_TOOLS;

function isControlTool(name: string): name is ControlToolName {
  return Object.hasOwn(CONTROL_TOOLS, name);
}

export const INTERRUPTED_EXTERNAL =
  "This call was cut off by a restart. Whether it took effect is unknown. Check the current state before you try it again.";

export async function runTask(
  taskId: string,
  deps: LoopDeps,
  signal: AbortSignal,
): Promise<NextStep> {
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };

  for (;;) {
    const state = deps.log.get(taskId);
    if (!state) throw new Error(`no task ${taskId}`);
    const step = nextStep(state);
    if (signal.aborted) return step;
    const tools = availableTools(deps.tools, state);

    switch (step.kind) {
      case "ended":
      case "paused":
      case "wait_for_person":
      case "idle":
        return step;
      case "recover_tools":
        await recover(state, step.calls, tools);
        break;
      case "run_tool":
        await runTool(state, step.call, true, tools);
        break;
      case "call_model":
        await callModel(state, toolSpecs([...tools.values()]));
        break;
    }
  }

  async function callModel(state: TaskState, specs: ToolSpec[]): Promise<void> {
    const exhausted = budgetExhausted(state, limits);
    if (exhausted) {
      deps.log.append(taskId, [
        {
          type: "task.ended",
          data: { outcome: "failed", summary: `Budget exhausted: ${exhausted}` },
        },
      ]);
      return;
    }

    const role = state.modelRole ?? "main";
    let resolved: ReturnType<ModelResolver["resolve"]>;
    try {
      resolved = deps.models.resolve(role);
    } catch (error) {
      deps.log.append(taskId, [
        {
          type: "task.ended",
          data: { outcome: "failed", summary: `Model role "${role}": ${message(error)}` },
        },
      ]);
      return;
    }
    const model = { provider: resolved.client.provider, model: resolved.model };

    const started = Date.now();
    try {
      const response = await resolved.client.complete({
        model: resolved.model,
        instructions: systemPrompt(state, deps.workspaceOf(taskId)),
        items: state.history,
        tools: specs,
        cacheKey: taskId,
        signal,
        ...(resolved.reasoningEffort && { reasoningEffort: resolved.reasoningEffort }),
        ...(resolved.maxOutputTokens && { maxOutputTokens: resolved.maxOutputTokens }),
      });
      deps.log.append(taskId, [
        {
          type: "model.responded",
          data: {
            model,
            items: response.items,
            stopReason: response.stopReason,
            usage: withCost(response.usage, resolved.price),
            latencyMs: Date.now() - started,
          },
        },
      ]);
    } catch (error) {
      if (signal.aborted) return;
      const failure =
        error instanceof ModelError
          ? error
          : new ModelError("fatal", `unexpected: ${message(error)}`);
      deps.log.append(taskId, [
        { type: "model.failed", data: { model, kind: failure.kind, message: failure.message } },
      ]);
      await afterFailure(failure, state.modelFailuresInARow + 1);
    }
  }

  async function afterFailure(failure: ModelError, failuresInARow: number): Promise<void> {
    if (failure.kind === "retryable") {
      if (failuresInARow >= limits.maxModelRetries) {
        deps.log.append(taskId, [
          {
            type: "task.paused",
            data: {
              reason: `Model unavailable after ${failuresInARow} attempts: ${failure.message}`,
            },
          },
        ]);
        return;
      }
      const backoff = Math.min(2_000 * 2 ** (failuresInARow - 1), limits.maxBackoffMs);
      await deps.sleep(Math.max(backoff, failure.retryAfterMs ?? 0), signal);
      return;
    }
    const summary =
      failure.kind === "context_overflow"
        ? `The conversation no longer fits the model's context: ${failure.message}`
        : `Model error: ${failure.message}`;
    deps.log.append(taskId, [{ type: "task.ended", data: { outcome: "failed", summary } }]);
  }

  async function recover(
    state: TaskState,
    calls: readonly RunningCall[],
    tools: ReadonlyMap<string, Tool>,
  ): Promise<void> {
    for (const running of calls) {
      if (running.effect === "external") {
        deps.log.append(taskId, [
          {
            type: "tool.finished",
            data: {
              callId: running.callId,
              outcome: "interrupted",
              content: text(INTERRUPTED_EXTERNAL),
            },
          },
        ]);
        continue;
      }
      const call = state.pendingCalls.find((c) => c.callId === running.callId);
      if (call) await runTool(state, call, false, tools);
      if (signal.aborted) return;
    }
  }

  async function runTool(
    state: TaskState,
    call: ToolCallItem,
    writeStarted: boolean,
    tools: ReadonlyMap<string, Tool>,
  ): Promise<void> {
    const finish = (outcome: ToolOutcome, output: string, extra: EventDraft[] = []) =>
      deps.log.append(taskId, [
        { type: "tool.finished", data: { callId: call.callId, outcome, content: text(output) } },
        ...extra,
      ]);

    const args = parseArguments(call);
    if (isControlTool(call.name)) {
      if (!args.ok) {
        finish("error", args.error);
        return;
      }
      const parsed = CONTROL_TOOLS[call.name].parameters.safeParse(args.value);
      if (!parsed.success) {
        finish("error", `Invalid arguments for ${call.name}:\n${z.prettifyError(parsed.error)}`);
        return;
      }
      if (call.name === "complete_task") {
        const { summary } = parsed.data as { summary: string };
        finish("ok", "Task completed.", [
          { type: "task.ended", data: { outcome: "completed", summary } },
        ]);
        return;
      }
      const answer = state.answers[call.callId];
      if (answer) {
        finish("ok", answer.response);
        return;
      }
      const { question } = parsed.data as { question: string };
      deps.log.append(taskId, [
        {
          type: "attention.requested",
          data: {
            attentionId: deps.newId(),
            kind: "question",
            prompt: question,
            callId: call.callId,
          },
        },
      ]);
      return;
    }

    const tool = tools.get(call.name);
    if (!tool) {
      if (deps.tools.some((t) => t.name === call.name)) {
        finish("denied", `${call.name} is not granted to this task.`);
      } else {
        const known = [...tools.keys(), ...Object.keys(CONTROL_TOOLS)].join(", ");
        finish("error", `Unknown tool "${call.name}". Available: ${known}`);
      }
      return;
    }
    if (!args.ok) {
      finish("error", args.error);
      return;
    }
    const parsed = tool.parameters.safeParse(args.value);
    if (!parsed.success) {
      finish("error", `Invalid arguments for ${tool.name}:\n${z.prettifyError(parsed.error)}`);
      return;
    }

    const context = {
      taskId,
      workspace: deps.workspaceOf(taskId),
      scratch: deps.scratchOf(taskId),
      grant: state.grant,
    };
    if (tool.approval === "required") {
      const answer = state.answers[call.callId];
      if (!answer) {
        deps.log.append(taskId, [
          {
            type: "attention.requested",
            data: {
              attentionId: deps.newId(),
              kind: "approval",
              prompt: tool.describe?.(parsed.data, context) ?? `${tool.name} ${call.arguments}`,
              callId: call.callId,
            },
          },
        ]);
        return;
      }
      if (!answer.approved) {
        const said = answer.response ? ` They said: ${answer.response}` : "";
        finish("denied", `The user did not approve this call.${said}`);
        return;
      }
    }

    if (writeStarted) {
      deps.log.append(taskId, [
        {
          type: "tool.started",
          data: { callId: call.callId, name: call.name, effect: tool.effect },
        },
      ]);
    }
    let output: { outcome: "ok" | "error"; text: string };
    try {
      output = await tool.run(parsed.data, { ...context, signal });
    } catch (error) {
      output = { outcome: "error", text: `${tool.name} failed: ${message(error)}` };
    }
    // A shutdown cut the call off; leave it open so recovery decides after the restart.
    if (signal.aborted) return;
    finish(output.outcome, output.text);
  }
}

/** The tools a task may use: every ordinary tool, and the privileged ones its Grant lists. */
export function availableTools(tools: readonly Tool[], state: TaskState): Map<string, Tool> {
  return new Map(
    tools
      .filter((tool) => !tool.privileged || state.grant.privilegedTools.includes(tool.name))
      .map((tool) => [tool.name, tool]),
  );
}

export function toolSpecs(tools: readonly Tool[]): ToolSpec[] {
  const control = Object.entries(CONTROL_TOOLS).map(([name, tool]) => ({
    name,
    description: tool.description,
    parameters: jsonSchema(tool.parameters),
  }));
  return [
    ...tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: jsonSchema(tool.parameters),
    })),
    ...control,
  ];
}

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, { io: "input" }) as Record<
    string,
    unknown
  >;
  return rest;
}

function parseArguments(
  call: ToolCallItem,
): { ok: true; value: unknown } | { ok: false; value?: undefined; error: string } {
  try {
    return { ok: true, value: call.arguments.trim() === "" ? {} : JSON.parse(call.arguments) };
  } catch {
    return { ok: false, error: `Arguments for ${call.name} are not valid JSON: ${call.arguments}` };
  }
}

function budgetExhausted(state: TaskState, limits: LoopLimits): string | undefined {
  const { budget } = state.grant;
  const maxCalls = budget.maxModelCalls ?? limits.defaultMaxModelCalls;
  if (state.usage.modelCalls >= maxCalls)
    return `${state.usage.modelCalls} of ${maxCalls} model calls used`;
  if (budget.maxCostUsd !== undefined && state.usage.costUsd >= budget.maxCostUsd) {
    return `$${state.usage.costUsd.toFixed(4)} of $${budget.maxCostUsd} spent`;
  }
  return undefined;
}

export function withCost(usage: Usage, price: ModelPrice | undefined): Usage {
  if (!price) return usage;
  const cached = usage.cachedInputTokens ?? 0;
  const costUsd =
    ((usage.inputTokens - cached) * price.input +
      cached * (price.cachedInput ?? price.input) +
      usage.outputTokens * price.output) /
    1_000_000;
  return { ...usage, costUsd };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
