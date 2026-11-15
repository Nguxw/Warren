import type { ModelClient, ModelResolver } from "@warren/core";
import { AnthropicClient, ChatCompletionsClient, OpenAIResponsesClient } from "@warren/model";
import { type ModelConfig, secretOf } from "../config/config.ts";
import type { Secrets } from "../config/secrets.ts";

export type ClientFactory = (config: ModelConfig) => ModelClient;

/**
 * Builds provider clients on first use and shares them between roles that use the same
 * endpoint and key, so a missing key only fails the tasks that need it.
 */
export function providerClients(secrets: Secrets): ClientFactory {
  const clients = new Map<string, ModelClient>();
  return (config) => {
    const secret = secretOf(config);
    const apiKey = secret ? secrets[secret] : undefined;
    // The key's value is part of the identity, so a key replaced in the settings takes effect on
    // the next model call without a restart.
    const key = [config.provider, config.baseUrl ?? "", secret ?? "", apiKey ?? ""].join("|");
    const existing = clients.get(key);
    if (existing) return existing;

    if (secret && !apiKey) {
      throw new Error(`${secret} is not set (environment or ~/.warren/credentials.env)`);
    }
    let client: ModelClient;
    switch (config.provider) {
      case "openai-responses":
        client = new OpenAIResponsesClient({
          apiKey: apiKey ?? "",
          ...(config.baseUrl && { baseURL: config.baseUrl }),
        });
        break;
      case "anthropic":
        client = new AnthropicClient({
          apiKey: apiKey ?? "",
          ...(config.baseUrl && { baseURL: config.baseUrl }),
        });
        break;
      case "openai-compatible":
        client = new ChatCompletionsClient({
          baseURL: config.baseUrl,
          ...(apiKey && { apiKey }),
        });
        break;
    }
    clients.set(key, client);
    return client;
  };
}

export function modelResolver(
  models: Record<string, ModelConfig>,
  clientFor: ClientFactory,
): ModelResolver {
  return {
    resolve(role) {
      const config = models[role];
      if (!config) {
        throw new Error(`unknown model role; configured: ${Object.keys(models).join(", ")}`);
      }
      return {
        client: clientFor(config),
        model: config.model,
        ...(config.reasoningEffort && { reasoningEffort: config.reasoningEffort }),
        ...(config.maxOutputTokens && { maxOutputTokens: config.maxOutputTokens }),
        ...(config.price && { price: config.price }),
        ...(config.contextWindow && { contextWindow: config.contextWindow }),
        inputs:
          config.inputs ??
          (config.provider === "openai-compatible" ? [] : (["image", "pdf"] as const)),
      };
    },
  };
}

/** The secrets the configured models need, and whether each is loaded; never their values. */
export function secretStatus(
  models: Record<string, ModelConfig>,
  secrets: Secrets,
): Record<string, boolean> {
  const status: Record<string, boolean> = {};
  for (const config of Object.values(models)) {
    const secret = secretOf(config);
    if (secret) status[secret] = Boolean(secrets[secret]);
  }
  return status;
}
