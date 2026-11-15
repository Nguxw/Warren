import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reply, ScriptedModel, say, toolCall } from "@warren/core/testing";
import type { TaskEvent } from "@warren/protocol";
import {
  AttachmentError,
  Attachments,
  type Logger,
  mediaTypeOf,
  type RunningDaemon,
  safeName,
  startDaemon,
} from "../src/index.ts";

const quiet: Logger = { info() {}, error() {} };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PDF = new TextEncoder().encode("%PDF-1.7\n...");

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "warren-attachments-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("media types come from a file's bytes first, and text is text whatever its name", () => {
  expect(mediaTypeOf("scan", PDF)).toBe("application/pdf");
  expect(mediaTypeOf("photo.jpg", PNG)).toBe("image/png");
  expect(mediaTypeOf("Makefile", new TextEncoder().encode("all:\n\techo hi\n"))).toBe("text/plain");
  expect(mediaTypeOf("notes.md", new TextEncoder().encode("# Notes\n"))).toBe("text/markdown");
  expect(mediaTypeOf("blob.bin", new Uint8Array([0, 1, 2, 255]))).toBe("application/octet-stream");
});

test("names are one safe path component", () => {
  expect(safeName("../../etc/passwd")).toBe("passwd");
  expect(safeName("C:\\Users\\me\\report.pdf")).toBe("report.pdf");
  expect(safeName(".hidden")).toBe("hidden");
  expect(safeName("a\nb.txt")).toBe("a_b.txt");
  expect(safeName("")).toBe("file");
  expect(safeName(`${"x".repeat(200)}.pdf`)).toHaveLength(120);
  expect(safeName(`${"x".repeat(200)}.pdf`).endsWith(".pdf")).toBe(true);
});

describe("Attachments", () => {
  const make = (now = () => Date.now()) =>
    new Attachments({
      uploads: join(root, "uploads"),
      taskDir: (id) => join(root, "tasks", id),
      scratchOf: (id) => join(root, "tasks", id, "scratch"),
      now,
    });

  test("a claimed upload moves into the task, with a copy in its scratch directory", async () => {
    const attachments = make();
    const a = await attachments.stage({ name: "chart.png", bytes: PNG });
    const b = await attachments.stage({ name: "chart.png", bytes: PNG });
    expect(a).toMatchObject({ name: "chart.png", mediaType: "image/png", size: PNG.length });

    const parts = attachments.claim("t1", [a.id, b.id]);
    expect(parts.map((p) => p.name)).toEqual(["chart.png", "chart (2).png"]);
    expect(readFileSync(join(root, "tasks/t1/attachments/chart (2).png"))).toEqual(
      Buffer.from(PNG),
    );
    expect(existsSync(join(root, "tasks/t1/scratch/attachments/chart.png"))).toBe(true);
    expect(existsSync(join(root, "uploads", a.id))).toBe(false);
    expect(await attachments.read("t1", "chart.png")).toEqual(PNG);
  });

  test("an unknown upload is refused before anything moves", async () => {
    const attachments = make();
    const a = await attachments.stage({ name: "a.pdf", bytes: PDF });
    expect(() => attachments.claim("t1", [a.id, "f".repeat(32)])).toThrow(AttachmentError);
    expect(() => attachments.claim("t1", ["../../etc"])).toThrow(AttachmentError);
    expect(existsSync(join(root, "uploads", a.id))).toBe(true);
    expect(existsSync(join(root, "tasks/t1"))).toBe(false);
  });

  test("only the task's own attachments can be read", async () => {
    const attachments = make();
    const a = await attachments.stage({ name: "a.pdf", bytes: PDF });
    attachments.claim("t1", [a.id]);
    expect(() => attachments.path("t1", "../scratch/attachments/a.pdf")).toThrow(AttachmentError);
    expect(() => attachments.path("t1", "missing.pdf")).toThrow(AttachmentError);
  });

  test("empty files are refused, and uploads nobody claims expire after a day", async () => {
    let now = Date.now();
    const attachments = make(() => now);
    await expect(attachments.stage({ name: "e.txt", bytes: new Uint8Array() })).rejects.toThrow(
      AttachmentError,
    );
    const a = await attachments.stage({ name: "a.pdf", bytes: PDF });
    const old = (Date.now() - 2 * 24 * 60 * 60_000) / 1000;
    utimesSync(join(root, "uploads", a.id), old, old);
    now = Date.now();
    attachments.sweep();
    expect(existsSync(join(root, "uploads", a.id))).toBe(false);
  });
});

describe("attachments over the API", () => {
  let daemon: RunningDaemon | undefined;
  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
  });

  test("uploaded files reach the model and can be opened in the interface", async () => {
    const model = new ScriptedModel([
      reply(say("A chart and a paper.")),
      reply(toolCall("complete_task", { summary: "Looked at both" })),
    ]);
    const home = join(root, "home");
    mkdirSync(home);
    daemon = await startDaemon({
      home,
      port: 0,
      models: { resolve: () => ({ client: model, model: "m", inputs: ["image", "pdf"] }) },
      logger: quiet,
      sleep: async () => {},
    });
    const d = daemon;
    const auth = { Authorization: `Bearer ${d.info.token}` };
    const json = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${d.url}${path}`, {
        method,
        headers: { ...auth, ...(body !== undefined && { "Content-Type": "application/json" }) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      // biome-ignore lint/suspicious/noExplicitAny: tests inspect JSON responses loosely
      return { status: res.status, body: (await res.json()) as any };
    };
    const upload = async (name: string, bytes: Uint8Array, type: string) => {
      const form = new FormData();
      form.append("file", new File([new Uint8Array(bytes)], name, { type }));
      const res = await fetch(`${d.url}/uploads`, { method: "POST", headers: auth, body: form });
      expect(res.status).toBe(201);
      return ((await res.json()) as { uploads: { id: string }[] }).uploads[0]?.id ?? "";
    };

    const chart = await upload("chart.png", PNG, "image/png");
    const created = await json("POST", "/tasks", {
      instruction: "What is in this chart?",
      attachments: [chart],
    });
    expect(created.status).toBe(201);
    const id: string = created.body.task.id;
    await d.scheduler.idle();
    expect(model.requests[0]?.files?.get("chart.png")).toEqual(PNG);

    // A follow-up may be only a file.
    const paper = await upload("paper.pdf", PDF, "application/pdf");
    expect(
      (await json("POST", `/tasks/${id}/input`, { text: "", attachments: [paper] })).status,
    ).toBe(200);
    await d.scheduler.idle();
    expect(model.requests[1]?.files?.get("paper.pdf")).toEqual(PDF);

    const events = (await json("GET", `/tasks/${id}/events`)).body.events as TaskEvent[];
    const created0 = events[0];
    expect(created0?.type === "task.created" && created0.data.attachments).toEqual([
      { type: "file", name: "chart.png", mediaType: "image/png", size: PNG.length },
    ]);

    const image = await fetch(`${d.url}/tasks/${id}/attachments/chart.png?token=${d.info.token}`);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("content-disposition")).toStartWith("inline");
    expect(image.headers.get("content-security-policy")).toBe("sandbox");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(PNG);
    expect(
      (await fetch(`${d.url}/tasks/${id}/attachments/other.png`, { headers: auth })).status,
    ).toBe(404);

    // Ids that were never uploaded, or already used, are refused.
    expect((await json("POST", "/tasks", { instruction: "x", attachments: [chart] })).status).toBe(
      400,
    );
    expect((await json("POST", `/tasks/${id}/input`, { text: " " })).status).toBe(400);
  });
});
