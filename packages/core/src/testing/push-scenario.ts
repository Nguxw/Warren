import { z } from "zod";
import type { ModelClient, Tool } from "../ports.ts";
import { reply, toolCall } from "./index.ts";

/**
 * The scenario used by crash tests: read a file, rewrite it, push (an external action), then
 * complete. It is small on purpose; what matters is that it has every kind of effect.
 */

export interface PushWorld {
  file: string;
  remote: boolean;
  pushes: number;
}

export function newPushWorld(): PushWorld {
  return { file: "v1", remote: false, pushes: 0 };
}

/**
 * A model that answers from the conversation alone, so asking again after a crash gives the
 * same answer. Like a careful model, it checks the remote when a push's outcome is unknown.
 */
export function pushPolicyModel(): ModelClient {
  return {
    provider: "policy",
    async complete(request) {
      const names = new Map<string, string>();
      let last: { name: string; outcome: string; text: string } | undefined;
      for (const item of request.items) {
        if (item.type === "tool_call") names.set(item.callId, item.name);
        if (item.type === "tool_result") {
          last = {
            name: names.get(item.callId) ?? "?",
            outcome: item.outcome,
            text: item.content.map((part) => part.text).join(""),
          };
        }
      }
      const call = (name: string, args: unknown = {}) =>
        reply(toolCall(name, args, `call_${request.items.length}`));
      const done = () => call("complete_task", { summary: "pushed v2" });
      if (!last) return call("read_file");
      switch (last.name) {
        case "read_file":
          return call("write_file");
        case "write_file":
          return call("push");
        case "push":
          return last.outcome === "ok" ? done() : call("check_remote");
        case "check_remote":
          return last.text === "pushed" ? done() : call("push");
        default:
          throw new Error(`policy has no move after ${last.name}`);
      }
    },
  };
}

/**
 * The scenario's tools. `afterEffect` runs right after each change to the world and before the
 * tool returns: tests use it to persist the world or to crash between an effect and its record.
 */
export function pushScenarioTools(world: PushWorld, afterEffect: () => void = () => {}): Tool[] {
  const tool = (name: string, effect: Tool["effect"], run: () => string): Tool => ({
    name,
    description: name,
    effect,
    parameters: z.object({}),
    async run() {
      return { outcome: "ok", text: run() };
    },
  });
  return [
    tool("read_file", "read", () => world.file),
    tool("write_file", "write", () => {
      world.file = "v2";
      afterEffect();
      return "written";
    }),
    tool("push", "external", () => {
      world.pushes += 1;
      world.remote = true;
      afterEffect();
      return "pushed";
    }),
    tool("check_remote", "read", () => (world.remote ? "pushed" : "not pushed")),
  ];
}
