import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MODELS,
  loadConfig,
  modelResolver,
  providerClients,
  secretOf,
  secretStatus,
} from "../src/index.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "warren-config-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(config: unknown): string {
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify(config));
  return file;
}

describe("loadConfig", () => {
  test("a missing file means defaults", () => {
    const config = loadConfig(join(dir, "none.json"));
    expect(config.models).toEqual(DEFAULT_MODELS);
    expect(config.server).toEqual({ host: "127.0.0.1", port: 7349 });
    expect(config.concurrency).toBe(3);
  });

  test("a role can move to an OpenAI-compatible provider; others keep their defaults", () => {
    const config = loadConfig(
      write({
        models: {
          cheap: {
            provider: "openai-compatible",
            baseUrl: "https://api.deepseek.com/v1",
            model: "deepseek-chat",
            apiKeySecret: "WARREN_DEEPSEEK_API_KEY",
          },
          local: {
            provider: "openai-compatible",
            baseUrl: "http://localhost:11434/v1",
            model: "qwen3",
          },
          main: { model: "gpt-6.1-sol" },
        },
      }),
    );
    expect(config.models.cheap).toMatchObject({
      provider: "openai-compatible",
      model: "deepseek-chat",
    });
    expect(config.models.main).toEqual({ provider: "openai-responses", model: "gpt-6.1-sol" });
    expect(config.models.hard).toEqual(DEFAULT_MODELS.hard);
    expect(secretOf(config.models.main as never)).toBe("WARREN_OPENAI_API_KEY");
    expect(secretOf(config.models.local as never)).toBeUndefined();
  });

  test("rejects a compatible provider without baseUrl and unsafe secret names", () => {
    expect(() =>
      loadConfig(write({ models: { x: { provider: "openai-compatible", model: "m" } } })),
    ).toThrow(/baseUrl/);
    expect(() =>
      loadConfig(write({ models: { x: { model: "m", apiKeySecret: "OPENAI_API_KEY" } } })),
    ).toThrow(/WARREN_<NAME>_API_KEY/);
  });
});

describe("model clients", () => {
  const configured = () =>
    loadConfig(
      write({
        models: {
          ds: {
            provider: "openai-compatible",
            baseUrl: "https://api.deepseek.com/v1",
            model: "deepseek-chat",
            apiKeySecret: "WARREN_DEEPSEEK_API_KEY",
          },
          local: {
            provider: "openai-compatible",
            baseUrl: "http://localhost:11434/v1",
            model: "q",
          },
        },
      }),
    ).models;

  test("roles on the same endpoint and key share one client", () => {
    const resolver = modelResolver(configured(), providerClients({ WARREN_OPENAI_API_KEY: "k" }));
    expect(resolver.resolve("main").client).toBe(resolver.resolve("hard").client);
    expect(resolver.resolve("main").client.provider).toBe("openai-responses");
    expect(resolver.resolve("local").client.provider).toBe("openai-compatible");
    expect(resolver.resolve("hard")).toMatchObject({
      model: "gpt-6.1-sol",
      reasoningEffort: "high",
    });
  });

  test("a missing key fails only the roles that need it", () => {
    const models = configured();
    const resolver = modelResolver(models, providerClients({ WARREN_OPENAI_API_KEY: "k" }));
    expect(() => resolver.resolve("ds")).toThrow("WARREN_DEEPSEEK_API_KEY is not set");
    expect(() => resolver.resolve("nope")).toThrow(/unknown model role/);
    expect(secretStatus(models, { WARREN_OPENAI_API_KEY: "k" })).toEqual({
      WARREN_OPENAI_API_KEY: true,
      WARREN_DEEPSEEK_API_KEY: false,
    });
  });
});
