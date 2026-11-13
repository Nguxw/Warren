import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { OPENAI_KEY, SECRET_NAME } from "./secrets.ts";

/**
 * `~/.warren/config.json`. Every field is optional; a missing file means all defaults.
 * Model roles in the file replace the default of the same name and keep the others.
 */

const common = {
  model: z.string(),
  reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  /** Context window in tokens; long tasks are compacted well before they reach it. */
  contextWindow: z.number().int().positive().optional(),
  /** US dollars per million tokens; used for budgets and reporting. */
  price: z
    .object({
      input: z.number().nonnegative(),
      cachedInput: z.number().nonnegative().optional(),
      output: z.number().nonnegative(),
    })
    .optional(),
  /** Name of the secret holding the API key, such as WARREN_DEEPSEEK_API_KEY. */
  apiKeySecret: z
    .string()
    .regex(SECRET_NAME, "must look like WARREN_<NAME>_API_KEY or WARREN_<NAME>_TOKEN")
    .optional(),
};

export const ModelConfig = z.preprocess(
  // `provider` may be left out and defaults to OpenAI's Responses API.
  (value) =>
    value && typeof value === "object" && !("provider" in value)
      ? { ...value, provider: "openai-responses" }
      : value,
  z.discriminatedUnion("provider", [
    z.object({
      provider: z.literal("openai-responses"),
      baseUrl: z.url().optional(),
      ...common,
    }),
    z.object({
      /** DeepSeek, Qwen, Ollama and other OpenAI-compatible Chat Completions endpoints. */
      provider: z.literal("openai-compatible"),
      baseUrl: z.url(),
      ...common,
    }),
  ]),
);
export type ModelConfig = z.infer<typeof ModelConfig>;

/** The secret a model needs, if any. Local OpenAI-compatible servers often need none. */
export function secretOf(config: ModelConfig): string | undefined {
  return config.apiKeySecret ?? (config.provider === "openai-responses" ? OPENAI_KEY : undefined);
}

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
  /** `auto`: Seatbelt on macOS, none elsewhere. `seatbelt` refuses to start without it. */
  sandbox: z.enum(["auto", "seatbelt", "none"]).optional(),
  tasks: z
    .object({
      /** Whether new tasks may reach the network unless the request says otherwise. */
      network: z.boolean().optional(),
    })
    .optional(),
  /** Per privileged tool: whether each call needs a person's approval. */
  approvals: z.record(z.string(), z.enum(["required", "auto"])).optional(),
  /** Desktop notifications when a task needs you or finishes. */
  notifications: z.boolean().optional(),
  github: z
    .object({
      /** How people address Warren in comments. */
      handle: z.string().default("@warren"),
      /** Warren's own GitHub account; found from the token when left out. */
      botLogin: z.string().optional(),
      /** People whose requests Warren takes. */
      allowedActors: z.array(z.string()).default([]),
      /** Reconcile poll interval. */
      pollSeconds: z.number().int().min(30).default(120),
      /** Local port for webhook deliveries (put a tunnel in front of it); off when absent. */
      webhookPort: z.number().int().min(0).max(65535).optional(),
      apiBase: z.url().optional(),
      repos: z
        .record(
          z.string().regex(/^[\w.-]+\/[\w.-]+$/, "use owner/name"),
          z.object({
            /** The local clone tasks for this repository work from. */
            path: z.string(),
            label: z.string().default("warren"),
            defaultBranch: z.string().default("main"),
            network: z.boolean().default(false),
            modelRole: z.string().optional(),
            rules: z
              .object({
                mention: z.enum(["off", "observe", "auto"]).default("auto"),
                label: z.enum(["off", "observe", "auto"]).default("auto"),
                ciFailure: z.enum(["off", "observe", "auto"]).default("observe"),
              })
              .prefault({}),
          }),
        )
        .default({}),
    })
    .optional(),
});

export type GitHubConfig = NonNullable<z.infer<typeof ConfigFile>["github"]>;

export interface Config {
  models: Record<string, ModelConfig>;
  server: { host: string; port: number };
  concurrency: number;
  sandbox: "auto" | "seatbelt" | "none";
  tasks: { network: boolean };
  approvals: Record<string, "required" | "auto">;
  notifications: boolean;
  github?: GitHubConfig;
}

export const DEFAULT_PORT = 7349;

export function loadConfig(file: string | undefined): Config {
  const raw = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const parsed = ConfigFile.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid config ${file}:\n${z.prettifyError(parsed.error)}`);
  }
  const { models, server, concurrency, sandbox, tasks, approvals, notifications, github } =
    parsed.data;
  return {
    models: { ...DEFAULT_MODELS, ...models },
    server: { host: server?.host ?? "127.0.0.1", port: server?.port ?? DEFAULT_PORT },
    concurrency: concurrency ?? 3,
    sandbox: sandbox ?? "auto",
    tasks: { network: tasks?.network ?? false },
    approvals: approvals ?? {},
    notifications: notifications ?? true,
    ...(github && { github }),
  };
}
