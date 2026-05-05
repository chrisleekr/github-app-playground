/**
 * LLM provider adaptor for non-agent single-turn inference (triage).
 *
 * Per the constitution amendment in PATCH v1.2.1 (Slice A of
 * triage-dispatch-modes), direct SDK use outside the Claude Agent SDK is
 * permitted strictly for single-turn classification / embedding /
 * summarisation calls. This module is the SINGLE entry point for those —
 * multi-turn agent work MUST go through `@anthropic-ai/claude-agent-sdk`.
 *
 * Design (per research.md R2):
 *   - A provider-agnostic `LLMClient` interface exposing `messages.create()`.
 *   - `createLLMClient(cfg)` branches on the already-validated
 *     `config.provider` enum to return the right SDK wrapper.
 *   - `resolveModelId(alias, provider)` turns operator-friendly aliases
 *     (e.g. "haiku-3-5") into provider-specific IDs, falling through to
 *     the raw value if no alias matches so operators can pin any ID.
 */

import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";
import Anthropic from "@anthropic-ai/sdk";

export type Provider = "anthropic" | "bedrock";

/**
 * Operator-friendly aliases → provider-specific model IDs. Haiku entries
 * remain available for cost-sensitive deployments; Sonnet 4.6 is the
 * default for triage and the output scanner where reasoning quality
 * outweighs the higher per-token cost.
 */
export const MODEL_MAP: Readonly<Record<string, Readonly<Record<Provider, string>>>> = {
  "haiku-3-5": {
    anthropic: "claude-3-5-haiku-20241022",
    bedrock: "anthropic.claude-3-5-haiku-20241022-v1:0",
  },
  "haiku-4-5": {
    anthropic: "claude-haiku-4-5-20251001",
    bedrock: "anthropic.claude-haiku-4-5-20251001-v1:0",
  },
  "sonnet-4-6": {
    anthropic: "claude-sonnet-4-6",
    bedrock: "us.anthropic.claude-sonnet-4-6",
  },
};

/**
 * Resolve an alias to a provider-specific model ID. When the input doesn't
 * match any alias, return it verbatim — this lets operators pin exact model
 * IDs (e.g. a newer snapshot) via `TRIAGE_MODEL` without needing code changes.
 */
export function resolveModelId(aliasOrId: string, provider: Provider): string {
  const entry = MODEL_MAP[aliasOrId];
  if (entry === undefined) return aliasOrId;
  return entry[provider];
}

/** One message in the request — Anthropic-style schema. */
export interface LLMMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface LLMCreateParams {
  readonly model: string;
  readonly system?: string;
  readonly messages: readonly LLMMessage[];
  /** Hard upper bound on generated tokens; prevents runaway cost on malformed responses. */
  readonly maxTokens: number;
  /** Optional temperature; default 0 for classification determinism. */
  readonly temperature?: number;
}

export interface LLMUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface LLMResponse {
  /** Concatenated text output across all content blocks. */
  readonly text: string;
  /** Token usage as reported by the provider. */
  readonly usage: LLMUsage;
  /** The model that served the request (provider may downgrade on capacity). */
  readonly model: string;
}

/**
 * Minimal provider-agnostic interface. Both Anthropic and Bedrock SDKs
 * already expose compatible shapes — this wrapper normalises response
 * parsing so the triage engine doesn't branch on provider.
 */
export interface LLMClient {
  readonly provider: Provider;
  create(params: LLMCreateParams): Promise<LLMResponse>;
}

export interface CreateLLMClientParams {
  readonly provider: Provider;
  readonly anthropicApiKey?: string;
  readonly claudeCodeOauthToken?: string;
  readonly awsRegion?: string;
}

/**
 * Branch on provider and return a configured LLMClient. Validation of
 * provider-specific required fields (API key / region) lives in config.ts
 * and runs at startup — this function trusts its input, but defensively
 * throws if called with incompatible config so mis-wiring fails fast at
 * the first call rather than silently hitting the wrong endpoint.
 */
export function createLLMClient(params: CreateLLMClientParams): LLMClient {
  let sdk: AnthropicLikeSdk;
  if (params.provider === "anthropic") {
    const apiKeyRaw = params.anthropicApiKey;
    const oauthRaw = params.claudeCodeOauthToken;
    // Trim before checking length so whitespace-only credentials are treated as
    // absent — matches `nonEmptyOptionalString` in config.ts. Direct callers
    // (tests, future code paths) that bypass the schema must not be able to
    // leak " " into `new Anthropic({ apiKey })` and produce a confusing 401.
    const apiKey = apiKeyRaw !== undefined && apiKeyRaw.trim().length > 0 ? apiKeyRaw : undefined;
    const oauth = oauthRaw !== undefined && oauthRaw.trim().length > 0 ? oauthRaw : undefined;
    const chosen = apiKey ?? oauth;
    if (chosen === undefined) {
      const apiKeyState = apiKeyRaw === undefined ? "missing" : "empty";
      const oauthState = oauthRaw === undefined ? "missing" : "empty";
      throw new Error(
        `createLLMClient: provider=anthropic requires a non-empty anthropicApiKey or claudeCodeOauthToken (anthropicApiKey=${apiKeyState}, claudeCodeOauthToken=${oauthState})`,
      );
    }
    sdk = new Anthropic({ apiKey: chosen }) as unknown as AnthropicLikeSdk;
  } else {
    if (params.awsRegion === undefined || params.awsRegion.length === 0) {
      throw new Error("createLLMClient: provider=bedrock requires awsRegion");
    }
    sdk = new AnthropicBedrock({ awsRegion: params.awsRegion }) as unknown as AnthropicLikeSdk;
  }
  return { provider: params.provider, create: (p) => invokeSdk(sdk, p) };
}

/**
 * Test-only factory: wraps a stubbed `AnthropicLikeSdk` in the LLMClient
 * contract so unit tests can exercise request-shaping and response-parsing
 * without touching the network. NEVER imported in production code —
 * production uses `createLLMClient`.
 */
export function _createLLMClientForTests(provider: Provider, sdk: AnthropicLikeSdk): LLMClient {
  return { provider, create: (p) => invokeSdk(sdk, p) };
}

/**
 * Anthropic SDK's `messages.create` shape. Pinned to the fields used so the
 * consumer doesn't depend on the full SDK type surface.
 */
export interface AnthropicMessageResponse {
  readonly content: readonly { type: string; text?: string }[];
  readonly model: string;
  readonly usage: { input_tokens: number; output_tokens: number };
}

/** The subset of an SDK client used by this adaptor — fully stubbable in tests. */
export interface AnthropicLikeSdk {
  readonly messages: {
    create: (req: unknown) => Promise<unknown>;
  };
}

/** @internal — exported for tests only. */
export function buildRequest(p: LLMCreateParams): Record<string, unknown> {
  const base: Record<string, unknown> = {
    model: p.model,
    max_tokens: p.maxTokens,
    messages: p.messages.map((m) => ({ role: m.role, content: m.content })),
    temperature: p.temperature ?? 0,
  };
  if (p.system !== undefined) base["system"] = p.system;
  return base;
}

/** @internal — exported for tests only. */
export function parseAnthropicResponse(raw: AnthropicMessageResponse): LLMResponse {
  const text = raw.content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text ?? "")
    .join("");
  return {
    text,
    model: raw.model,
    usage: { inputTokens: raw.usage.input_tokens, outputTokens: raw.usage.output_tokens },
  };
}

async function invokeSdk(sdk: AnthropicLikeSdk, p: LLMCreateParams): Promise<LLMResponse> {
  const raw = (await sdk.messages.create(buildRequest(p))) as AnthropicMessageResponse;
  return parseAnthropicResponse(raw);
}

/**
 * Per-model rate sheet (USD per token). Anthropic public pricing as of
 * 2026-04. Bedrock charges the same underlying Anthropic rates (AWS adds a
 * region-dependent surcharge we don't model here — operators can read the
 * usage columns and multiply). The estimate is advisory — billing of record
 * is whatever the provider invoice says.
 *
 * Haiku 3.5 (2024-10): input $0.80 / output $4.00 per 1M tokens.
 * Haiku 4.5 (2025-10): input $1.00 / output $5.00 per 1M tokens.
 *
 * The map is keyed by the *resolved* provider model ID (what the API
 * returns in `response.model`), so callers don't have to know about aliases.
 */
const RATE_SHEET_USD_PER_TOKEN: Readonly<Record<string, { input: number; output: number }>> = {
  // Haiku 3.5
  "claude-3-5-haiku-20241022": { input: 0.8 / 1_000_000, output: 4.0 / 1_000_000 },
  "anthropic.claude-3-5-haiku-20241022-v1:0": { input: 0.8 / 1_000_000, output: 4.0 / 1_000_000 },
  // Haiku 4.5
  "claude-haiku-4-5-20251001": { input: 1.0 / 1_000_000, output: 5.0 / 1_000_000 },
  "anthropic.claude-haiku-4-5-20251001-v1:0": { input: 1.0 / 1_000_000, output: 5.0 / 1_000_000 },
};

/**
 * Cost estimate (USD) for a Haiku-class triage call. Branches on the
 * resolved model ID returned by the provider; falls back to Haiku 3.5
 * rates for unknown models so a stale rate sheet under-counts (warns the
 * operator) rather than over-counts.
 */
export function estimateHaikuCostUsd(usage: LLMUsage, modelId?: string): number {
  const FALLBACK = { input: 0.8 / 1_000_000, output: 4.0 / 1_000_000 };
  const rates = modelId !== undefined ? (RATE_SHEET_USD_PER_TOKEN[modelId] ?? FALLBACK) : FALLBACK;
  return usage.inputTokens * rates.input + usage.outputTokens * rates.output;
}
