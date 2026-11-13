import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

/**
 * `~/.warren/config.json`. Every field is optional; a missing file means all defaults.
 * Model roles in the file replace the default of the same name and keep the others.
 */

export const ModelConfig = z.object({
  /** Adapter id. Only `openai-responses` exists today; others arrive as new adapters. */
  provider: z.literal("openai-responses").default("openai-responses"),
  model: z.string(),
  reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  /** US dollars per million tokens; used for budgets and reporting. */
  price: z
    .object({
      input: z.number().nonnegative(),
      cachedInput: z.number().nonnegative().optional(),
      output: z.number().nonnegative(),
    })
    .optional(),
});
export type ModelConfig = z.infer<typeof ModelConfig>;

/**
 * Defaults chosen for this project. Prices come from third-party reports and are not verified
 * against OpenAI's price list; override them in config.json once checked.
 */
export const DEFAULT_MODELS: Record<string, ModelConfig> = {
  main: {
    provider: "openai-responses",
    model: "gpt-6.1-terra",
    reasoningEffort: "medium",
    price: { input: 1, output: 5 },
  },
  cheap: {
    provider: "openai-responses",
    model: "gpt-6-luna",
    reasoningEffort: "low",
    price: { input: 0.1, cachedInput: 0.01, output: 0.5 },
  },
  hard: {
    provider: "openai-responses",
    model: "gpt-6.1-sol",
    reasoningEffort: "high",
    price: { input: 2, cachedInput: 0.2, output: 10 },
  },
};

const ConfigFile = z.object({
  models: z.record(z.string(), ModelConfig).optional(),
  server: z
    .object({
      host: z.string().optional(),
      port: z.number().int().min(0).max(65535).optional(),
    })
    .optional(),
  /** Tasks whose loops run at the same time. */
  concurrency: z.number().int().min(1).max(32).optional(),
});

export interface Config {
  models: Record<string, ModelConfig>;
  server: { host: string; port: number };
  concurrency: number;
}

export const DEFAULT_PORT = 7349;

export function loadConfig(file: string | undefined): Config {
  const raw = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const parsed = ConfigFile.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid config ${file}:\n${z.prettifyError(parsed.error)}`);
  }
  const { models, server, concurrency } = parsed.data;
  return {
    models: { ...DEFAULT_MODELS, ...models },
    server: { host: server?.host ?? "127.0.0.1", port: server?.port ?? DEFAULT_PORT },
    concurrency: concurrency ?? 3,
  };
}
