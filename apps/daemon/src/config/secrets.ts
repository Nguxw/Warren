import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * Secrets Warren reads. Each has a Warren-specific name (`WARREN_…_API_KEY` or `WARREN_…_TOKEN`)
 * so Warren never shares a variable such as OPENAI_API_KEY with other tools on the machine.
 *
 * Lookup order: the process environment, then `~/.warren/credentials.env` (mode 0600, outside
 * any repository). Secret values never go into the event log, the database or tool processes.
 */
export const SECRET_NAME = /^WARREN_[A-Z0-9_]+_(API_KEY|TOKEN|SECRET)$/;

/** The secret the default models use. */
export const OPENAI_KEY = "WARREN_OPENAI_API_KEY";

export type Secrets = Record<string, string>;

export function loadSecrets(options: {
  env?: Record<string, string | undefined>;
  file?: string;
}): Secrets {
  const { env = process.env, file } = options;
  const fromFile = file && existsSync(file) ? parseEnvFile(readFileSync(file, "utf8")) : {};
  const secrets: Secrets = {};
  for (const source of [fromFile, env]) {
    for (const [name, value] of Object.entries(source)) {
      if (SECRET_NAME.test(name) && value) secrets[name] = value;
    }
  }
  return secrets;
}

/** Parses `KEY=value` lines; `#` starts a comment line; values may be single- or double-quoted. */
export function parseEnvFile(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key = "", value = ""] = match;
    const quoted = /^(["'])(.*)\1$/.exec(value);
    result[key] = quoted ? (quoted[2] ?? "") : value;
  }
  return result;
}

/** Shows enough of a secret to recognise it: `sk-proj…cB8c`. */
export function maskSecret(value: string): string {
  if (value.length < 16) return "****";
  return `${value.slice(0, 7)}…${value.slice(-4)}`;
}

/** A secret name or value that cannot be stored. */
export class InvalidSecretError extends Error {}

/** What a secret value may contain: printable characters without spaces or quotes. */
const SECRET_VALUE = /^[!#-&(-~]+$/;

/**
 * Sets (or with `undefined` removes) one secret in the credentials file, keeping every other
 * line, comments included. The file is replaced atomically and stays mode 0600.
 */
export function writeSecret(file: string, name: string, value: string | undefined): void {
  if (!SECRET_NAME.test(name)) {
    throw new InvalidSecretError(
      `${name}: secret names look like WARREN_<NAME>_API_KEY or WARREN_<NAME>_TOKEN`,
    );
  }
  if (value !== undefined && !SECRET_VALUE.test(value)) {
    throw new InvalidSecretError("a secret value must be one word without spaces or quotes");
  }
  const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : [];
  const assigns = (line: string) => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(line);
  const kept = lines.filter((line) => !assigns(line));
  while (kept.length > 0 && kept.at(-1) === "") kept.pop();
  if (value !== undefined) kept.push(`${name}=${value}`);
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${kept.join("\n")}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}
