import type { TaskState } from "./task-state.ts";

/** Rules for the privileged tools this task was granted, if any. */
function privileged(state: TaskState): string {
  const granted = state.grant.privilegedTools;
  const lines: string[] = [];
  if (granted.includes("publish_branch")) {
    lines.push(
      "- When your work is committed, call publish_branch so the user can review the branch in their repository.",
    );
  }
  if (granted.includes("open_pull_request")) {
    lines.push("- Open a pull request only when the task asks for one.");
  }
  if (granted.length > 0) {
    lines.push(
      "- Pushing, publishing and similar actions affect things outside the workspace. If such a call was interrupted, check the current state before trying again.",
    );
  }
  return lines.length > 0 ? `\n${lines.join("\n")}` : "";
}

/**
 * The system instructions. They change only with the task's workspace and Grant, so the prefix stays
 * identical across a task's calls and providers can cache it.
 */
/** A skill as the model first sees it: what it is for, not yet its instructions. */
export interface SkillSummary {
  name: string;
  description: string;
}

/**
 * Skills listed by name and purpose; the model loads one's instructions with `load_skill` when
 * the task calls for it, so unused skills cost a line each.
 */
function skillsSection(skills: readonly SkillSummary[], chosen: readonly string[]): string {
  if (skills.length === 0) return "";
  const list = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  const required =
    chosen.length > 0
      ? `\nThe user chose ${chosen.join(", ")} for this task: load ${chosen.length > 1 ? "each" : "it"} with load_skill before anything else, and follow it.`
      : "";
  return `\n\nSkills: instructions and files for kinds of work. When the task matches one, call load_skill with its name before you start, and follow it.${required}\n${list}`;
}

/** Where the person's files are, once there are any; until then the prompt does not change. */
function attachmentsSection(state: TaskState, scratch: string | undefined): string {
  if (state.attachments.length === 0 || !scratch) return "";
  return `\n\nFiles the user attached are copied to ${scratch}/attachments/. Messages name them by their path there; work on them with the shell, and copy any you change into the workspace.`;
}

export function systemPrompt(
  state: TaskState,
  workspace: string,
  model?: { provider: string; model: string },
  skills: readonly SkillSummary[] = [],
  scratch?: string,
): string {
  const { grant } = state;
  const identity = model
    ? `\n\nYou run on the model ${model.model} (${model.provider} API). If asked which model you are, say so.`
    : "";
  const where =
    grant.workspace.kind === "clone"
      ? `Your workspace is ${workspace}, a git clone of ${grant.workspace.source}. Commit your work there on the current branch; the user reviews it from the clone.`
      : grant.workspace.kind === "copy"
        ? `Your workspace is ${workspace}, a copy of the folder ${grant.workspace.source}. Make your changes there; the user reviews the files you change or add and saves them where they choose. The original folder is not changed.`
        : `Your workspace is ${workspace}, an empty directory. Save what you produce for the user there (reports, data, files): the user sees and opens the files in it.`;

  return `You are Warren, an autonomous agent that works in the background on the user's own computer. Nobody watches you while you work; the user reads your result when you finish.${identity}

${where}

How to work:
- Use the tools. Look before you change: read and search the relevant files first.
- Keep every change inside the workspace.
- Verify your work when you can, for example by running the tests, and say how you verified it.
- The user sees only your messages and the complete_task summary, never your reasoning or tool output. So the summary carries the result itself: for a question, the full answer; for research, the findings and the files you saved; for a change, what changed, how it was verified, and anything left open. Never only report that you did something (such as "answered the question"); give the content.
- A question you can answer from what you know needs no tools: answer it in complete_task right away.
- If you cannot go on without a decision only the user can make, call ask_user with one concrete question. Do not ask about things you can find out yourself.
- Report honestly. A partial result is reported as partial, a failure as a failure.
- Keep messages short.${privileged(state)}${attachmentsSection(state, scratch)}${skillsSection(skills, state.skills)}`;
}
