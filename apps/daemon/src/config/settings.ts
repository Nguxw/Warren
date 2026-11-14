import { renameSync, writeFileSync } from "node:fs";
import { McpServerConfig } from "@warren/mcp";
import { z } from "zod";
import { type Config, ModelConfig, parseConfig, readRawConfig, secretOf } from "./config.ts";
import { maskSecret, OPENAI_KEY, type Secrets, writeSecret } from "./secrets.ts";

/**
 * The settings a person changes from the interface: models, task defaults and secrets.
 *
 * Changes are written to `config.json` and `credentials.env`, merged into what the files already
 * hold, so fields the interface does not show (GitHub, server, prices) survive. They also take
 * effect at once: the running daemon shares the `config` and `secrets` objects edited here.
 * The exception is what is wired at start (server, sandbox, the GitHub connector), which the
 * view marks as needing a restart.
 */

export const SettingsPatch = z.object({
  /** Whole role definitions; a role in the patch replaces the role in the file. */
  models: z
    .record(z.string().regex(/^[a-z][\w-]*$/, "use a lowercase role name"), ModelConfig)
    .optional(),
  concurrency: z.number().int().min(1).max(32).optional(),
  notifications: z.boolean().optional(),
  tasks: z.object({ network: z.boolean() }).optional(),
  approvals: z.record(z.string(), z.enum(["required", "auto"])).optional(),
  /** Servers to add or replace by name; `null` removes one. */
  mcpServers: z.record(z.string(), McpServerConfig.nullable()).optional(),
  /** Installed skills to turn off (the whole list). */
  disabledSkills: z.array(z.string()).optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatch>;

export const SecretUpdate = z.object({ value: z.string().trim().min(1) });

/** A settings change that cannot be made; the request was wrong, not the daemon. */
export class SettingsError extends Error {}

export interface SecretInfo {
  name: string;
  set: boolean;
  /** Enough to recognise the value (`sk-proj…cB8c`), never the value. */
  masked?: string;
  /** Set in the daemon's environment, which wins over the file. */
  fromEnv: boolean;
  /** Model roles that use it. */
  usedBy: string[];
}

export interface SettingsView {
  models: Record<string, ModelConfig>;
  concurrency: number;
  notifications: boolean;
  tasks: { network: boolean };
  /** Effective approval rule per privileged tool. */
  approvals: Record<string, "required" | "auto">;
  mcpServers: Record<string, McpServerConfig>;
  disabledSkills: string[];
  secrets: SecretInfo[];
  sandbox: string;
  paths: { home: string; config: string; credentials: string };
}

/** Secrets the interface always offers, whether or not a model needs them yet. */
const KNOWN_SECRETS = [
  OPENAI_KEY,
  "WARREN_ANTHROPIC_API_KEY",
  "WARREN_GITHUB_TOKEN",
  "WARREN_GITHUB_WEBHOOK_SECRET",
];

export class Settings {
  constructor(
    private readonly deps: {
      config: Config;
      secrets: Secrets;
      /** Approval rules the tools have when the config says nothing. */
      defaultApprovals: Record<string, "required" | "auto">;
      paths: { home: string; config: string; credentials: string };
      sandbox: string;
      env?: Record<string, string | undefined>;
      onConcurrency(concurrency: number): void;
    },
  ) {}

  view(): SettingsView {
    const { config, paths, sandbox } = this.deps;
    return {
      models: config.models,
      concurrency: config.concurrency,
      notifications: config.notifications,
      tasks: config.tasks,
      approvals: { ...this.deps.defaultApprovals, ...config.approvals },
      mcpServers: config.mcp.servers,
      disabledSkills: config.skills.disabled,
      secrets: this.secretInfo(),
      sandbox,
      paths,
    };
  }

  update(patch: SettingsPatch): SettingsView {
    const raw = readRawConfig(this.deps.paths.config);
    const section = (key: string) => (raw[key] as Record<string, unknown> | undefined) ?? {};
    if (patch.models) raw.models = { ...section("models"), ...patch.models };
    if (patch.tasks) raw.tasks = { ...section("tasks"), ...patch.tasks };
    if (patch.approvals) raw.approvals = { ...section("approvals"), ...patch.approvals };
    if (patch.mcpServers) {
      const servers = { ...((section("mcp").servers as Record<string, unknown>) ?? {}) };
      for (const [name, server] of Object.entries(patch.mcpServers)) {
        if (server === null) delete servers[name];
        else servers[name] = server;
      }
      raw.mcp = { ...section("mcp"), servers };
    }
    if (patch.disabledSkills) raw.skills = { ...section("skills"), disabled: patch.disabledSkills };
    if (patch.concurrency !== undefined) raw.concurrency = patch.concurrency;
    if (patch.notifications !== undefined) raw.notifications = patch.notifications;
    // Validated as a whole before anything is written or applied.
    let next: Config;
    try {
      next = parseConfig(raw, "settings");
    } catch (error) {
      throw new SettingsError(error instanceof Error ? error.message : String(error));
    }

    const temp = `${this.deps.paths.config}.tmp`;
    writeFileSync(temp, `${JSON.stringify(raw, null, 2)}\n`);
    renameSync(temp, this.deps.paths.config);

    const live = this.deps.config;
    for (const role of Object.keys(live.models)) delete live.models[role];
    Object.assign(live.models, next.models);
    live.tasks.network = next.tasks.network;
    live.approvals = next.approvals;
    live.notifications = next.notifications;
    live.mcp = next.mcp;
    live.skills = next.skills;
    if (live.concurrency !== next.concurrency) {
      live.concurrency = next.concurrency;
      this.deps.onConcurrency(next.concurrency);
    }
    return this.view();
  }

  /** Sets a secret, or removes it with `undefined`. */
  setSecret(name: string, value: string | undefined): SettingsView {
    // The environment wins over the file at every start, so a change here would not last.
    if (this.deps.env?.[name]) {
      throw new SettingsError(`${name} comes from the daemon's environment; change it there`);
    }
    writeSecret(this.deps.paths.credentials, name, value);
    if (value !== undefined) this.deps.secrets[name] = value;
    else delete this.deps.secrets[name];
    return this.view();
  }

  private secretInfo(): SecretInfo[] {
    const { config, secrets, env = {} } = this.deps;
    const usedBy = new Map<string, string[]>();
    for (const [role, model] of Object.entries(config.models)) {
      const secret = secretOf(model);
      if (secret) usedBy.set(secret, [...(usedBy.get(secret) ?? []), role]);
    }
    const names = [...new Set([...KNOWN_SECRETS, ...usedBy.keys(), ...Object.keys(secrets)])];
    return names.map((name) => {
      const value = secrets[name];
      return {
        name,
        set: Boolean(value),
        ...(value && { masked: maskSecret(value) }),
        fromEnv: Boolean(env[name]),
        usedBy: usedBy.get(name) ?? [],
      };
    });
  }
}
