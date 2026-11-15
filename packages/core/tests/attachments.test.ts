import { describe, expect, test } from "bun:test";
import type { ConversationItem, FilePart, UserMessageItem } from "@warren/protocol";
import { estimateTokens, modelView, runTask, systemPrompt, transcript } from "../src/index.ts";
import { reply, ScriptedModel, say, testDeps, testTask, toolCall } from "../src/testing/index.ts";

const png: FilePart = { type: "file", name: "chart.png", mediaType: "image/png", size: 3 };
const pdf: FilePart = { type: "file", name: "paper.pdf", mediaType: "application/pdf", size: 3 };
const csv: FilePart = { type: "file", name: "data.csv", mediaType: "text/csv", size: 8 };
const docx: FilePart = {
  type: "file",
  name: "notes.docx",
  mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  size: 2048,
};

const disk: Record<string, Uint8Array> = {
  "chart.png": new Uint8Array([1, 2, 3]),
  "paper.pdf": new Uint8Array([4, 5, 6]),
  "data.csv": new TextEncoder().encode("a,b\n1,2\n"),
};
const read = async (name: string) => {
  const bytes = disk[name];
  if (!bytes) throw new Error("missing");
  return bytes;
};

const message = (...content: FilePart[]): UserMessageItem => ({
  type: "message",
  role: "user",
  content: [{ type: "text", text: "Look" }, ...content],
});

describe("modelView", () => {
  test("images and PDFs go to a model that takes them, with their bytes", async () => {
    const view = await modelView([message(png, pdf)], ["image", "pdf"], read);
    expect(view.items[0]).toEqual({
      type: "message",
      role: "user",
      content: [
        { type: "text", text: "Look" },
        { type: "text", text: "[Attached file attachments/chart.png]" },
        png,
        { type: "text", text: "[Attached file attachments/paper.pdf]" },
        pdf,
      ],
    });
    expect([...view.files.keys()]).toEqual(["chart.png", "paper.pdf"]);
  });

  test("a model that takes no files is told where they are instead", async () => {
    const view = await modelView([message(png, docx)], [], read);
    const content = view.items[0]?.type === "message" ? view.items[0].content : [];
    expect(content.every((part) => part.type === "text")).toBe(true);
    expect(JSON.stringify(content)).toContain("attachments/chart.png (image/png, 3 B)");
    expect(JSON.stringify(content)).toContain("attachments/notes.docx");
    expect(view.files.size).toBe(0);
  });

  test("small text files are written into the message for every model", async () => {
    const view = await modelView([message(csv)], [], read);
    const content = view.items[0]?.type === "message" ? view.items[0].content : [];
    expect(content[1]).toEqual({
      type: "text",
      text: '<file path="attachments/data.csv">\na,b\n1,2\n\n</file>',
    });
  });

  test("a file that can no longer be read is named as missing, not an error", async () => {
    const gone: FilePart = { ...png, name: "gone.png" };
    const view = await modelView([message(gone)], ["image"], read);
    expect(JSON.stringify(view.items)).toContain("attachments/gone.png is no longer available");
    expect(view.files.size).toBe(0);
  });

  test("a conversation without files is passed through unchanged", async () => {
    const items: ConversationItem[] = [
      { type: "message", role: "user", content: [{ type: "text", text: "Hi" }] },
    ];
    const view = await modelView(items, ["image"], read);
    expect(view.items[0]).toBe(items[0] as ConversationItem);
  });
});

test("files count towards the context estimate and appear in summaries by path", () => {
  const plain = estimateTokens([
    { type: "message", role: "user", content: [{ type: "text", text: "Look" }] },
  ]);
  expect(estimateTokens([message(png)])).toBeGreaterThan(plain + 1000);
  expect(transcript([message(png)])).toContain("[attached file attachments/chart.png]");
});

test("attachments reach the model from the instruction and later messages", async () => {
  const model = new ScriptedModel([
    reply(say("A chart.")),
    reply(toolCall("complete_task", { summary: "ok" })),
  ]);
  const deps = testDeps({
    model,
    readAttachment: async (_task, name) => read(name),
  });
  deps.models = { resolve: () => ({ client: model, model: "m", inputs: ["image"] }) };
  deps.log.create("t1", { ...testTask, attachments: [png] });
  const never = new AbortController().signal;

  const state = deps.log.get("t1");
  expect(state?.attachments).toEqual([png]);
  expect(state?.history[0]).toEqual({
    type: "message",
    role: "user",
    content: [{ type: "text", text: testTask.instruction }, png],
  });

  await runTask("t1", deps, never);
  expect(model.requests[0]?.files?.get("chart.png")).toEqual(disk["chart.png"] as Uint8Array);
  expect(model.requests[0]?.instructions).toContain(
    "Files the user attached are copied to /tmp/warren-test-scratch/attachments/",
  );

  deps.log.append("t1", [
    {
      type: "input.received",
      data: { item: message(pdf), trigger: { source: "manual" } },
    },
  ]);
  expect(deps.log.get("t1")?.attachments).toEqual([png, pdf]);
  await runTask("t1", deps, never);
  // PDFs are not among this model's inputs: named, not sent.
  expect(model.requests[1]?.files?.has("paper.pdf")).toBe(false);
  expect(JSON.stringify(model.requests[1]?.items)).toContain("attachments/paper.pdf");
});

test("the prompt mentions attachments only once a task has some", () => {
  const deps = testDeps();
  const state = deps.log.create("t1", testTask);
  expect(systemPrompt(state, "/w", undefined, [], "/s")).not.toContain("attached");
});
