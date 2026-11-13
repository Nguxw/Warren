import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { fromWebhook, GitHubClient, parseIssueThread, verifySignature } from "../src/index.ts";

const repository = { full_name: "acme/app" };
const issue = {
  number: 12,
  title: "Login breaks",
  body: "Steps…",
  html_url: "https://github.com/acme/app/issues/12",
  user: { login: "alice" },
  created_at: "2026-11-14T10:00:00Z",
};
const commentBody = {
  id: 501,
  body: "@warren please fix",
  user: { login: "alice" },
  html_url: "https://github.com/acme/app/issues/12#issuecomment-501",
  created_at: "2026-11-14T10:05:00Z",
};

test("webhook signatures are checked against the raw body", () => {
  const body = JSON.stringify({ hello: "world" });
  const good = `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`;
  expect(verifySignature("s3cret", body, good)).toBe(true);
  expect(verifySignature("other", body, good)).toBe(false);
  expect(verifySignature("s3cret", `${body} `, good)).toBe(false);
  expect(verifySignature("s3cret", body, null)).toBe(false);
});

describe("fromWebhook", () => {
  test("normalises the deliveries Warren uses and ignores the rest", () => {
    expect(
      fromWebhook("issue_comment", { action: "created", repository, issue, comment: commentBody }),
    ).toEqual([
      {
        source: "github",
        externalId: "comment:501",
        kind: "comment",
        repo: "acme/app",
        thread: "github:acme/app#12",
        actor: "alice",
        title: "Login breaks",
        body: "@warren please fix",
        url: commentBody.html_url,
        at: Date.parse(commentBody.created_at),
      },
    ]);
    expect(
      fromWebhook("issues", {
        action: "labeled",
        repository,
        issue,
        label: { name: "warren" },
        sender: { login: "bob" },
      })[0],
    ).toMatchObject({
      kind: "issue_labeled",
      externalId: "labeled:acme/app#12:warren",
      actor: "bob",
      label: "warren",
    });
    expect(
      fromWebhook("workflow_run", {
        action: "completed",
        repository,
        workflow_run: {
          id: 9,
          conclusion: "failure",
          name: "test",
          head_branch: "main",
          html_url: "u",
          updated_at: "2026-11-14T10:00:00Z",
        },
      })[0],
    ).toMatchObject({
      kind: "ci_failed",
      externalId: "run:9",
      branch: "main",
      thread: "github:acme/app@main",
    });
    expect(
      fromWebhook("issue_comment", { action: "edited", repository, issue, comment: commentBody }),
    ).toEqual([]);
    expect(fromWebhook("ping", { zen: "…" })).toEqual([]);
  });
});

describe("reconcile", () => {
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path.endsWith("/issues/comments")) {
          return Response.json([
            { ...commentBody, issue_url: "https://api.github.com/repos/acme/app/issues/12" },
          ]);
        }
        if (path.endsWith("/issues/events")) {
          return Response.json([
            {
              event: "labeled",
              label: { name: "warren" },
              actor: { login: "bob" },
              issue,
              created_at: "2026-11-14T10:06:00Z",
            },
            { event: "closed", issue, created_at: "2026-11-14T10:07:00Z" },
          ]);
        }
        if (path.endsWith("/issues"))
          return Response.json([issue, { ...issue, number: 13, pull_request: {} }]);
        return Response.json({ workflow_runs: [] });
      },
    });
  });
  afterAll(() => {
    server.stop(true);
  });

  test("polling yields the same keys as webhooks, so the two paths deduplicate", async () => {
    const client = new GitHubClient("t", server.url.origin);
    const events = await client.reconcile("acme/app", Date.parse("2026-11-14T09:00:00Z"));
    expect(events.map((e) => e.externalId)).toEqual([
      "opened:acme/app#12",
      "comment:501",
      "labeled:acme/app#12:warren",
    ]);
    const viaWebhook = fromWebhook("issue_comment", {
      action: "created",
      repository,
      issue,
      comment: commentBody,
    });
    expect(events[1]?.externalId).toBe(viaWebhook[0]?.externalId);
    // Older than the cursor: nothing.
    expect(await client.reconcile("acme/app", Date.parse("2026-11-15T00:00:00Z"))).toEqual([]);
  });
});

test("parseIssueThread", () => {
  expect(parseIssueThread("github:acme/app#12")).toEqual({ repo: "acme/app", number: 12 });
  expect(parseIssueThread("github:acme/app@main")).toBeUndefined();
});
