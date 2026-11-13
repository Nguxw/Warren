import { ModelError } from "@warren/core";
import { APIConnectionError, APIError, APIUserAbortError } from "openai";

/**
 * Normalises errors from OpenAI-style HTTP APIs, shared by every adapter built on the OpenAI SDK
 * so that the same failure is classified the same way whichever API produced it.
 */
export function classifyError(error: unknown): ModelError {
  if (error instanceof ModelError) return error;
  if (error instanceof APIUserAbortError) return new ModelError("retryable", "request aborted");
  if (error instanceof APIConnectionError) {
    return new ModelError("retryable", `connection: ${error.message}`);
  }
  if (error instanceof APIError) {
    const { status, code } = error;
    // The SDK's message already starts with the status; add the provider's code when there is one.
    const text = code ? `${error.message} (${code})` : error.message;
    if (code === "context_length_exceeded" || /context (window|length)/i.test(error.message)) {
      return new ModelError("context_overflow", text);
    }
    if (code === "insufficient_quota") return new ModelError("fatal", text);
    if (status === 408 || status === 409 || status === 429 || (status ?? 0) >= 500) {
      return new ModelError("retryable", text, retryAfterMs(error.headers));
    }
    return new ModelError("fatal", text);
  }
  return new ModelError("fatal", error instanceof Error ? error.message : String(error));
}

function retryAfterMs(headers: Headers | undefined): number | undefined {
  const ms = Number(headers?.get("retry-after-ms"));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const seconds = Number(headers?.get("retry-after"));
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  return undefined;
}
