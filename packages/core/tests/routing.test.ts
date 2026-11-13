import { describe, expect, test } from "bun:test";
import type { TriggerEvent } from "@warren/protocol";
import { type RoutingConfig, route } from "../src/index.ts";

const appRepo = {
  rules: { mention: "auto", label: "auto", ciFailure: "observe" },
  label: "warren",
  defaultBranch: "main",
} as const;

const config: RoutingConfig = {
  handle: "@warren",
  allowedActors: ["alice"],
  botLogin: "warren-bot",
  marker: "<!-- warren -->",
  repos: {
    "acme/app": {
      rules: { mention: "auto", label: "auto", ciFailure: "observe" },
      label: "warren",
      defaultBranch: "main",
    },
  },
};

const event = (over: Partial<TriggerEvent>): TriggerEvent => ({
  source: "github",
  externalId: "x",
  kind: "comment",
  repo: "acme/app",
  thread: "github:acme/app#12",
  actor: "alice",
  title: "Login breaks on Safari",
  body: "@warren please fix this",
  url: "https://github.com/acme/app/issues/12#c1",
  at: 0,
  ...over,
});

describe("route", () => {
  test("an allowed person mentioning Warren starts a task with the request and its context", () => {
    const decision = route(event({}), config, []);
    expect(decision).toMatchObject({
      action: "create",
      rule: "mention",
      title: "Login breaks on Safari",
    });
    if (decision.action !== "create") throw new Error("expected create");
    expect(decision.instruction).toContain("acme/app#12");
    expect(decision.instruction).toContain("Request from @alice:\nplease fix this");
  });

  test("ignores people not on the list, messages not addressed to Warren, and unknown repos", () => {
    expect(route(event({ actor: "mallory" }), config, [])).toEqual({
      action: "ignore",
      reason: "@mallory is not on the allowed list",
    });
    expect(route(event({ body: "looks fine" }), config, []).action).toBe("ignore");
    expect(route(event({ body: "ping @warrenfan" }), config, []).action).toBe("ignore");
    expect(route(event({ repo: "other/repo" }), config, []).action).toBe("ignore");
  });

  test("never acts on its own messages, by account or by marker", () => {
    expect(route(event({ actor: "Warren-Bot" }), config, [])).toEqual({
      action: "ignore",
      reason: "own message",
    });
    expect(
      route(event({ actor: "alice", body: "<!-- warren -->\n@warren done" }), config, []).action,
    ).toBe("ignore");
  });

  test("a reply on a followed conversation feeds the task, or answers its open question", () => {
    expect(
      route(event({ body: "also check Firefox" }), config, [{ id: "t1", status: "active" }]),
    ).toEqual({
      action: "append",
      taskId: "t1",
      text: "also check Firefox",
    });
    expect(
      route(event({ body: "@warren use the v2 API" }), config, [
        { id: "t1", status: "waiting", questionId: "q1" },
      ]),
    ).toEqual({ action: "answer", taskId: "t1", attentionId: "q1", text: "use the v2 API" });
    // Ended tasks do not take replies; a new mention starts new work.
    expect(route(event({}), config, [{ id: "t0", status: "ended" }]).action).toBe("create");
  });

  test("the label rule takes the issue itself as the request", () => {
    const decision = route(
      event({ kind: "issue_labeled", label: "Warren", body: "Steps: open login on Safari" }),
      config,
      [],
    );
    expect(decision).toMatchObject({ action: "create", rule: "label" });
    if (decision.action === "create")
      expect(decision.instruction).toContain("Steps: open login on Safari");
    expect(route(event({ kind: "issue_labeled", label: "bug" }), config, []).action).toBe("ignore");
  });

  test("CI failures on the default branch are only observed until the rule is trusted", () => {
    const failed = event({
      kind: "ci_failed",
      actor: undefined,
      branch: "main",
      title: "test",
      thread: "github:acme/app@main",
    });
    expect(route(failed, config, [])).toMatchObject({ action: "observe", rule: "ciFailure" });
    expect(route({ ...failed, branch: "feature" }, config, []).action).toBe("ignore");
    const auto = {
      ...config,
      repos: {
        "acme/app": {
          ...appRepo,
          rules: { mention: "auto", label: "auto", ciFailure: "auto" },
        },
      },
    } as RoutingConfig;
    expect(route(failed, auto, []).action).toBe("create");
    expect(route(failed, auto, [{ id: "t1", status: "active" }]).action).toBe("ignore");
  });

  test("a rule that is off ignores, whatever the request", () => {
    const off = {
      ...config,
      repos: {
        "acme/app": {
          ...appRepo,
          rules: { mention: "off", label: "auto", ciFailure: "observe" },
        },
      },
    } as RoutingConfig;
    expect(route(event({}), off, [])).toEqual({ action: "ignore", reason: "rule mention is off" });
  });
});
