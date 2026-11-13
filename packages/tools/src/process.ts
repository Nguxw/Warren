import type { Tool, ToolContext } from "@warren/core";
import { z } from "zod";
import { display, MAX_OUTPUT_CHARS, resolveInside, toolEnv, truncateMiddle } from "./common.ts";
import { noSandbox, type Sandbox, type SandboxPolicy } from "./sandbox.ts";

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ProcessOptions {
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  /** Confines the process. Without it the process runs with the daemon's rights. */
  sandbox?: { sandbox: Sandbox; policy: SandboxPolicy };
  /** Added to the clean environment, for trusted commands that need a credential. */
  env?: Record<string, string>;
}

/** Runs a command with a clean environment, a timeout, cancellation and optionally a sandbox. */
export async function runProcess(argv: string[], options: ProcessOptions): Promise<ProcessResult> {
  const { sandbox } = options;
  const command = sandbox ? sandbox.sandbox.wrap(argv, sandbox.policy) : argv;
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    env: { ...toolEnv(process.env, sandbox?.policy.scratch), ...options.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, options.timeoutMs);
  const onAbort = () => child.kill("SIGKILL");
  options.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode: timedOut ? null : exitCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", onAbort);
  }
}

/** The sandbox options for a tool call: the task's workspace, scratch and network grant. */
function confine(sandbox: Sandbox, context: ToolContext): ProcessOptions["sandbox"] {
  return {
    sandbox,
    policy: {
      workspace: context.workspace,
      scratch: context.scratch,
      network: context.grant.network,
    },
  };
}

export function shellTool(
  sandbox: Sandbox = noSandbox,
): Tool<{ command: string; timeout_seconds?: number | undefined }> {
  return {
    name: "shell",
    description:
      "Run a shell command (bash) in the workspace, for builds, tests, git and other CLI tools. Not interactive: stdin is closed. Output is truncated in the middle when long. Runs in a sandbox: only the workspace and $TMPDIR are writable, and the network is available only if the task was granted it.",
    // The sandbox confines writes to the workspace and scratch, so a command interrupted by a crash
    // can be run again: whatever it did is visible in the workspace.
    effect: "write",
    parameters: z.object({
      command: z.string().min(1).describe("The bash command line"),
      timeout_seconds: z
        .number()
        .int()
        .min(1)
        .max(1800)
        .optional()
        .describe("Kill the command after this many seconds; default 120"),
    }),
    async run({ command, timeout_seconds = 120 }, context) {
      const result = await runProcess(["/bin/bash", "-c", command], {
        cwd: context.workspace,
        timeoutMs: timeout_seconds * 1000,
        signal: context.signal,
        sandbox: confine(sandbox, context),
      });
      const status = result.timedOut
        ? `timed out after ${timeout_seconds}s`
        : `exit code ${result.exitCode}`;
      const parts = [status];
      if (result.stdout) parts.push(result.stdout.trimEnd());
      if (result.stderr) parts.push(`[stderr]\n${result.stderr.trimEnd()}`);
      return {
        outcome: result.exitCode === 0 ? "ok" : "error",
        text: truncateMiddle(parts.join("\n"), MAX_OUTPUT_CHARS),
      };
    },
  };
}

const MAX_MATCH_LINES = 200;

export function searchTool(sandbox: Sandbox = noSandbox): Tool<{
  pattern: string;
  path?: string | undefined;
  glob?: string | undefined;
  ignore_case?: boolean | undefined;
}> {
  return {
    name: "search",
    description: `Search file contents with a regular expression (ripgrep syntax when available). Returns matching lines as path:line:text, at most ${MAX_MATCH_LINES}. Skips .git and node_modules.`,
    effect: "read",
    parameters: z.object({
      pattern: z.string().min(1).describe("Regular expression"),
      path: z
        .string()
        .optional()
        .describe("File or directory relative to the workspace; default ."),
      glob: z.string().optional().describe('Only files matching this glob, such as "*.ts"'),
      ignore_case: z.boolean().optional(),
    }),
    async run({ pattern, path = ".", glob, ignore_case }, context) {
      const { workspace, signal } = context;
      const target = display(workspace, resolveInside(workspace, path));
      const rg = Bun.which("rg");
      const argv = rg
        ? [
            rg,
            "--line-number",
            "--no-heading",
            "--color=never",
            ...(ignore_case ? ["-i"] : []),
            ...(glob ? ["--glob", glob] : []),
            "-e",
            pattern,
            "--",
            target,
          ]
        : [
            "/usr/bin/grep",
            "-rnE",
            "--exclude-dir=.git",
            "--exclude-dir=node_modules",
            ...(ignore_case ? ["-i"] : []),
            ...(glob ? [`--include=${glob}`] : []),
            "-e",
            pattern,
            "--",
            target,
          ];
      const result = await runProcess(argv, {
        cwd: workspace,
        timeoutMs: 60_000,
        signal,
        sandbox: confine(sandbox, context),
      });
      if (result.exitCode === 1) return { outcome: "ok", text: "No matches" };
      if (result.exitCode !== 0) {
        return {
          outcome: "error",
          text: result.stderr.trim() || `search failed (${result.exitCode})`,
        };
      }
      const lines = result.stdout.trimEnd().split("\n");
      const more =
        lines.length > MAX_MATCH_LINES
          ? `\n[${lines.length - MAX_MATCH_LINES} more matches; narrow the search]`
          : "";
      return {
        outcome: "ok",
        text: truncateMiddle(lines.slice(0, MAX_MATCH_LINES).join("\n") + more, MAX_OUTPUT_CHARS),
      };
    },
  };
}
