import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * OS sandboxes for processes that tools start on the model's behalf (shell commands, search).
 *
 * The boundary, for each task:
 * - Writes: only the task's workspace and scratch directory (plus /dev/null). Everything else,
 *   including the source repository and the user's shared temporary directory, is read-only.
 * - Reads: allowed, except credential and personal-data locations (`hiddenPaths`) and the whole
 *   Warren home, of which only the task's own directories are visible.
 * - Network: on or off per task (Grant.network). Off also blocks localhost.
 * - Other processes: signals only within the sandbox; no Apple Events, no launching apps, no
 *   access to services such as the keychain. The profile denies by default and allows only
 *   what command-line tools need, so new ways out have to be granted, not discovered.
 *
 * In-process file tools are not sandboxed; they confine paths themselves (`resolveInside`).
 */

export interface SandboxPolicy {
  workspace: string;
  scratch: string;
  network: boolean;
}

export interface Sandbox {
  readonly name: "seatbelt" | "none";
  /** The command line that runs `argv` under the policy. */
  wrap(argv: string[], policy: SandboxPolicy): string[];
}

export const noSandbox: Sandbox = { name: "none", wrap: (argv) => argv };

const SEATBELT = "/usr/bin/sandbox-exec";

export function seatbeltAvailable(): boolean {
  return process.platform === "darwin" && existsSync(SEATBELT);
}

/** Credentials and personal data a task never needs to read. Paths that do not exist are fine. */
export function defaultHiddenPaths(home = homedir()): string[] {
  return [
    ".ssh",
    ".gnupg",
    ".aws",
    ".azure",
    ".kube",
    ".docker",
    ".config/gh",
    ".config/gcloud",
    ".netrc",
    ".npmrc",
    ".pypirc",
    ".git-credentials",
    ".codex",
    ".claude",
    ".claude.json",
    "Library/Keychains",
    "Library/Cookies",
    "Library/Application Support",
    "Library/Mail",
    "Library/Messages",
    "Library/Safari",
  ].map((path) => join(home, path));
}

export class SeatbeltSandbox implements Sandbox {
  readonly name = "seatbelt";
  private readonly hidden: string[];

  constructor(options: { warrenHome: string; hiddenPaths?: string[] }) {
    this.hidden = [options.warrenHome, ...(options.hiddenPaths ?? defaultHiddenPaths())].map(real);
  }

  wrap(argv: string[], policy: SandboxPolicy): string[] {
    installShims(policy.scratch);
    const params: Record<string, string> = {
      WORKSPACE: real(policy.workspace),
      SCRATCH: real(policy.scratch),
    };
    this.hidden.forEach((path, i) => {
      params[`HIDDEN_${i}`] = path;
    });
    return [
      SEATBELT,
      "-p",
      seatbeltProfile({ hidden: this.hidden.length, network: policy.network }),
      ...Object.entries(params).flatMap(([key, value]) => ["-D", `${key}=${value}`]),
      ...argv,
    ];
  }
}

/**
 * The profile text. Paths arrive as `-D` parameters, never spliced into the text, so no path can
 * change the profile's meaning. In Seatbelt the last matching rule wins, which lets the task's own
 * directories be readable inside the hidden Warren home.
 */
export function seatbeltProfile(options: { hidden: number; network: boolean }): string {
  const hidden = Array.from(
    { length: options.hidden },
    (_, i) => `(subpath (param "HIDDEN_${i}"))`,
  );
  return `(version 1)
(deny default)
(import "bsd.sb")

(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))
(allow sysctl-read)

(allow file-read*)
${hidden.length > 0 ? `(deny file-read* ${hidden.join(" ")})` : ""}
(allow file-read* (subpath (param "WORKSPACE")) (subpath (param "SCRATCH")))

(allow file-write*
  (subpath (param "WORKSPACE"))
  (subpath (param "SCRATCH"))
  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (regex #"^/dev/fd/"))
(allow file-ioctl (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/fd/"))
(allow pseudo-tty)
(allow ipc-posix-shm)
(allow ipc-posix-sem)
(allow mach-lookup
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.system.notification_center")
  (global-name "com.apple.system.logger"))
${
  options.network
    ? `
(allow network-outbound)
(allow network-inbound (local ip))
(allow system-socket)
(allow mach-lookup
  (global-name "com.apple.dnssd.service")
  (global-name "com.apple.SystemConfiguration.configd")
  (global-name "com.apple.SystemConfiguration.DNSConfiguration")
  (global-name "com.apple.trustd")
  (global-name "com.apple.trustd.agent"))`
    : ""
}
`;
}

/** Directory of command shims, first on PATH for sandboxed commands (see `toolEnv`). */
export function shimDir(scratch: string): string {
  return join(scratch, "bin");
}

/**
 * macOS `mktemp` ignores TMPDIR, even with -t, and writes to the user's shared temporary
 * directory, which the sandbox does not allow. This shim gives it a template inside TMPDIR;
 * explicit templates and other options pass through unchanged.
 */
const MKTEMP_SHIM = `#!/bin/sh
# Installed by Warren: make mktemp use $TMPDIR inside the sandbox.
dir=""; quiet=""; prefix="tmp"
while [ $# -gt 0 ]; do
  case "$1" in
    -d) dir="-d" ;;
    -q) quiet="-q" ;;
    -t) shift; prefix="$1" ;;
    *) exec /usr/bin/mktemp "$@" ;;
  esac
  shift
done
exec /usr/bin/mktemp $dir $quiet "\${TMPDIR:-/tmp}/$prefix.XXXXXXXX"
`;

function installShims(scratch: string): void {
  const file = join(shimDir(scratch), "mktemp");
  if (existsSync(file)) return;
  mkdirSync(shimDir(scratch), { recursive: true });
  writeFileSync(file, MKTEMP_SHIM);
  chmodSync(file, 0o755);
}

/** Seatbelt matches real paths (`/private/var/…`, not `/var/…`). */
function real(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}
