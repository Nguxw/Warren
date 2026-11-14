import { expect, test } from "bun:test";
import { EVENT_VERSIONS, type TaskEvent } from "@warren/protocol";
import { foldEvents, systemPrompt } from "../src/index.ts";

function state(workspace: { kind: "none" } | { kind: "copy"; source: string }) {
  return foldEvents([
    {
      type: "task.created",
      v: EVENT_VERSIONS["task.created"],
      taskId: "t",
      seq: 0,
      at: 0,
      data: {
        title: "Q",
        instruction: "Which model are you?",
        grant: {
          workspace,
          network: false,
          privilegedTools: [],
          budget: {},
        },
        trigger: { source: "manual" },
      },
    } as TaskEvent,
  ]);
}

test("the prompt names the model and asks for the result itself, not a report of it", () => {
  const prompt = systemPrompt(state({ kind: "none" }), "/w", {
    provider: "openai-responses",
    model: "gpt-6.1-terra",
  });
  expect(prompt).toContain("You run on the model gpt-6.1-terra");
  expect(prompt).toContain("for a question, the full answer");
  expect(prompt).toContain("Save what you produce for the user there");
  expect(systemPrompt(state({ kind: "none" }), "/w")).not.toContain("You run on the model");
});

test("a copied folder is described as a copy whose original stays as it was", () => {
  const prompt = systemPrompt(state({ kind: "copy", source: "/Users/me/notes" }), "/w");
  expect(prompt).toContain("a copy of the folder /Users/me/notes");
  expect(prompt).toContain("The original folder is not changed");
});
