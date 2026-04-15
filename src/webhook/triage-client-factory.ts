/**
 * Cached LLM client factory for the triage path. The SDK constructors
 * allocate an HTTP keep-alive pool; re-creating the client per request
 * would leak sockets and defeat keep-alive.
 */

import { createLLMClient, type LLMClient } from "../ai/llm-client";
import { config } from "../config";

let cached: LLMClient | undefined;

/**
 * Lazily build a singleton `LLMClient` from `config`. Tests inject a stub
 * via `_setTriageLLMClientForTests()` before driving the router, which
 * bypasses this factory entirely.
 */
export function getTriageLLMClient(): LLMClient {
  if (cached !== undefined) return cached;
  cached = createLLMClient({
    provider: config.provider,
    ...(config.anthropicApiKey !== undefined && { anthropicApiKey: config.anthropicApiKey }),
    ...(config.claudeCodeOauthToken !== undefined && {
      claudeCodeOauthToken: config.claudeCodeOauthToken,
    }),
    ...(config.awsRegion !== undefined && { awsRegion: config.awsRegion }),
  });
  return cached;
}

/** Test-only hook: replace the singleton with a stub. */
export function _setTriageLLMClientForTests(client: LLMClient | undefined): void {
  cached = client;
}
