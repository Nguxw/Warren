import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { warrenPaths } from "@warren/daemon";

/**
 * Runs the daemon as a launchd user agent: it starts at login, restarts if it exits, and keeps
 * working with no terminal open. The agent runs the same `warren daemon` command as a terminal
 * would, from the compiled binary when there is one.
 */

/** `WARREN_SERVICE_LABEL` lets a development instance run next to the real one. */
export function serviceLabel(env = process.env): string {
  return env.WARREN_SERVICE_LABEL ?? "dev.warren.daemon";
}

export function plistPath(label = serviceLabel(), home = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${label}.plist`);
}

/** The command that starts the daemon: the compiled binary itself, or bun with this script. */
export function daemonCommand(): string[] {
  const compiled = import.meta.path.startsWith("/$bunfs/");
  return compiled
    ? [process.execPath, "daemon"]
    : [process.execPath, resolve(import.meta.dir, "main.ts"), "daemon"];
}

export interface AgentOptions {
  label: string;
  program: string[];
  logFile: string;
  workingDirectory: string;
  environment: Record<string, string>;
}

export function launchAgentPlist(options: AgentOptions): string {
  const strings = (values: string[]) =>
    values.map((value) => `      <string>${xml(value)}</string>`).join("\n");
  const env = Object.entries(options.environment)
    .map(([key, value]) => `      <key>${xml(key)}</key>\n      <string>${xml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xml(options.label)}</string>
    <key>ProgramArguments</key>
    <array>
${strings(options.program)}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${env}
    </dict>
    <key>WorkingDirectory</key>
    <string>${xml(options.workingDirectory)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${xml(options.logFile)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(options.logFile)}</string>
  </dict>
</plist>
`;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

function launchctl(...args: string[]) {
  const result = Bun.spawnSync(["/bin/launchctl", ...args], { stdout: "pipe", stderr: "pipe" });
  return {
    ok: result.exitCode === 0,
    output: `${result.stdout.toString()}${result.stderr.toString()}`.trim(),
  };
}

export function installService(): string {
  if (process.platform !== "darwin") throw new Error("the service uses launchd, which needs macOS");
  const label = serviceLabel();
  const paths = warrenPaths();
  const file = plistPath(label);
  mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(file), { recursive: true });

  // launchd starts with almost no PATH; tasks need git, bun and Homebrew tools.
  const path = [
    dirname(process.execPath),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  const environment: Record<string, string> = { PATH: [...new Set(path)].join(":") };
  if (process.env.WARREN_HOME) environment.WARREN_HOME = paths.home;

  writeFileSync(
    file,
    launchAgentPlist({
      label,
      program: daemonCommand(),
      logFile: join(paths.logs, "daemon.log"),
      workingDirectory: paths.home,
      environment,
    }),
  );
  launchctl("bootout", `${domain()}/${label}`); // replace a previous installation
  const loaded = launchctl("bootstrap", domain(), file);
  if (!loaded.ok) throw new Error(`launchctl bootstrap failed: ${loaded.output}`);
  return file;
}

export function uninstallService(): boolean {
  const label = serviceLabel();
  const file = plistPath(label);
  launchctl("bootout", `${domain()}/${label}`);
  const existed = existsSync(file);
  rmSync(file, { force: true });
  return existed;
}

export function serviceStatus(): { installed: boolean; running: boolean; pid?: number } {
  const label = serviceLabel();
  const installed = existsSync(plistPath(label));
  const printed = launchctl("print", `${domain()}/${label}`);
  if (!printed.ok) return { installed, running: false };
  const pid = /\bpid = (\d+)/.exec(printed.output)?.[1];
  const running = /\bstate = running\b/.test(printed.output);
  return { installed, running, ...(pid && { pid: Number(pid) }) };
}
