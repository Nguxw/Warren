import { existsSync, readFileSync } from "node:fs";

/**
 * Secrets Warren reads. Each has a Warren-specific name so Warren never shares a variable
 * (such as OPENAI_API_KEY) with other tools on the machine.
 *
 * Lookup order: the process environment, then `~/.warren/credentials.env` (mode 0600, outside
 * any repository). Secret values never go into the event log, the database or tool processes.
 */
export const SECRET_NAMES = ["WARREN_OPENAI_API_KEY"] as const;
export type SecretName = (typeof SECRET_NAMES)[number];
export type Secrets = Partial<Record<SecretName, string>>;

export function loadSecrets(options: {
  env?: Record<string, string | undefined>;
  file?: string;
}): Secrets {
  const { env = process.env, file } = options;
  const fromFile = file && existsSync(file) ? parseEnvFile(readFileSync(file, "utf8")) : {};
  const secrets: Secrets = {};
  for (const name of SECRET_NAMES) {
    const value = env[name] || fromFile[name];
    if (value) secrets[name] = value;
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
