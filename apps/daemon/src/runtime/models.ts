import type { ModelClient, ModelResolver } from "@warren/core";
import { OPENAI_RESPONSES, OpenAIResponsesClient } from "@warren/model";
import type { ModelConfig } from "../config/config.ts";
import type { Secrets } from "../config/secrets.ts";

export type ClientFactory = (provider: ModelConfig["provider"]) => ModelClient;

/** Builds provider clients on first use, so a missing key only fails the tasks that need it. */
export function providerClients(secrets: Secrets): ClientFactory {
  const clients = new Map<string, ModelClient>();
  return (provider) => {
    const existing = clients.get(provider);
    if (existing) return existing;
    let client: ModelClient;
    switch (provider) {
      case OPENAI_RESPONSES: {
        const apiKey = secrets.WARREN_OPENAI_API_KEY;
        if (!apiKey) {
          throw new Error(
            "WARREN_OPENAI_API_KEY is not set (environment or ~/.warren/credentials.env)",
          );
        }
        client = new OpenAIResponsesClient({ apiKey });
        break;
      }
    }
    clients.set(provider, client);
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
        client: clientFor(config.provider),
        model: config.model,
        ...(config.reasoningEffort && { reasoningEffort: config.reasoningEffort }),
        ...(config.maxOutputTokens && { maxOutputTokens: config.maxOutputTokens }),
        ...(config.price && { price: config.price }),
      };
    },
  };
}
