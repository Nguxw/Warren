/**
 * One daemon lifetime for the chaos run: `bun child.ts <home>`.
 *
 * Runs the real daemon (SQLite store, scheduler, loop) with the push scenario. The scenario's
 * world lives in `<home>/world.json` and every change to it is fsynced before the tool returns,
 * so it survives SIGKILL like a real external system would. Small random delays spread the
 * parent's kills over every phase: startup, model calls, tool runs and commits.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { ModelClient, Tool } from "@warren/core";
import {
  newPushWorld,
  type PushWorld,
  pushPolicyModel,
  pushScenarioTools,
  testTask,
} from "@warren/core/testing";
import { startDaemon } from "@warren/daemon";

export const TASK_ID = "chaos";

const home = process.argv[2];
if (!home) throw new Error("usage: bun child.ts <home>");
const worldFile = join(home, "world.json");

const jitter = () => Bun.sleep(Math.random() * 40);

function loadWorld(): PushWorld {
  return existsSync(worldFile) ? JSON.parse(readFileSync(worldFile, "utf8")) : newPushWorld();
}

/** Write, fsync, rename: a kill at any moment leaves either the old world or the new one. */
function persist(world: PushWorld): void {
  const temp = `${worldFile}.tmp`;
  const fd = openSync(temp, "w");
  try {
    writeSync(fd, JSON.stringify(world));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, worldFile);
}

const world = loadWorld();
const policy = pushPolicyModel();
const model: ModelClient = {
  provider: policy.provider,
  async complete(request) {
    await jitter();
    return policy.complete(request);
  },
};
const tools: Tool[] = pushScenarioTools(world, () => persist(world)).map((tool) => ({
  ...tool,
  async run(args, context) {
    await jitter();
    const output = await tool.run(args, context);
    await jitter();
    return output;
  },
}));

const daemon = await startDaemon({
  home,
  port: 0,
  models: { resolve: () => ({ client: model, model: "policy" }) },
  tools,
  logger: { info() {}, error() {} },
  sleep: async () => {},
});

if (!daemon.store.get(TASK_ID)) {
  daemon.store.create(TASK_ID, testTask);
  daemon.scheduler.wake(TASK_ID);
}
// Stay alive until the parent kills this process.
setInterval(() => {}, 1 << 30);
