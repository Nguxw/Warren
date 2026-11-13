import type { ConversationItem } from "@warren/protocol";
import { isSafeCut } from "./task-state.ts";

/**
 * Context management: deciding when a task's conversation must be compacted and how much of it.
 *
 * Token counts are estimated (about four characters per token), which is enough to decide when
 * to act; a provider that still finds the request too long reports a context overflow, and the
 * loop compacts then too.
 */

export function estimateTokens(items: readonly ConversationItem[]): number {
  let chars = 0;
  for (const item of items) {
    switch (item.type) {
      case "message":
      case "tool_result":
        for (const part of item.content) chars += part.text.length;
        break;
      case "tool_call":
        chars += item.name.length + item.arguments.length;
        break;
      case "reasoning":
        chars += JSON.stringify(item.data ?? "").length;
        break;
    }
    chars += 16;
  }
  return Math.ceil(chars / 4);
}

/**
 * How many items after the instruction to replace so that roughly `keepTokens` of the most
 * recent conversation stays verbatim, moved earlier to the nearest cut that separates no tool
 * call from its result. Undefined when there is too little to compact.
 */
export function planCompaction(
  history: readonly ConversationItem[],
  keepTokens: number,
): number | undefined {
  let kept = 0;
  let end = history.length;
  while (end > 2) {
    const tokens = estimateTokens([history[end - 1] as ConversationItem]);
    if (kept + tokens > keepTokens) break;
    kept += tokens;
    end -= 1;
  }
  while (end > 1 && !isSafeCut(history, end)) end -= 1;
  const replaces = end - 1;
  return replaces >= 2 ? replaces : undefined;
}

const MAX_RESULT = 1500;
const MAX_ARGS = 600;

/** The conversation as plain text for the summarising model; long outputs are shortened. */
export function transcript(items: readonly ConversationItem[]): string {
  const lines: string[] = [];
  for (const item of items) {
    switch (item.type) {
      case "message":
        lines.push(
          `${item.role === "user" ? "USER" : "AGENT"}: ${item.content.map((p) => p.text).join("\n")}`,
        );
        break;
      case "tool_call":
        lines.push(`TOOL CALL ${item.name} ${clip(item.arguments, MAX_ARGS)}`);
        break;
      case "tool_result":
        lines.push(
          `RESULT (${item.outcome}): ${clip(item.content.map((p) => p.text).join("\n"), MAX_RESULT)}`,
        );
        break;
      case "reasoning":
        if (item.summary) lines.push(`AGENT THOUGHT: ${clip(item.summary, MAX_RESULT)}`);
        break;
    }
  }
  return lines.join("\n\n");
}

export const SUMMARIZE_INSTRUCTIONS = `You compact the working memory of an autonomous coding agent. Summarise the transcript you are given so the agent can continue the task without it.

Keep: what has been done and verified, decisions and the reasons for them, the current state of files and branches, commands that worked, errors still open, anything the user said or asked, and the next steps. Drop: file contents and command output that can be read again, dead ends that taught nothing.

Write plain prose and short lists, in the past tense for what happened. Be specific: names of files, functions, commands, test names. At most about 600 words.`;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
