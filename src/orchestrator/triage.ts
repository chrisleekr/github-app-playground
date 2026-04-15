/**
 * Triage engine (T034) — single-turn classification of ambiguous events.
 *
 * Called by the router only when:
 *   (a) `config.agentJobMode === "auto"`, AND
 *   (b) `classifyStatic(ctx)` returned `{ outcome: "ambiguous" }`.
 *
 * Contract (FR-007 — FR-010, SC-002, SC-005):
 *   - Wraps one LLM call in a circuit breaker + hard timeout.
 *   - Validates the response against the triage-response.schema.json /
 *     Zod schema. Any deviation → fallback.
 *   - Gates on `config.triageConfidenceThreshold`. Sub-threshold → fallback.
 *   - Persists a `triage_results` row on clean parse+mode-known (advisory:
 *     the row survives sub-threshold gating so ops can observe what the
 *     model thought).
 *   - NEVER throws. All failure paths return `{ outcome: "fallback", reason }`
 *     so the router can deterministically carry on to the default target.
 */

import { z } from "zod";

import { estimateHaikuCostUsd, type LLMClient, resolveModelId } from "../ai/llm-client";
import { config } from "../config";
import { getDb } from "../db";
import { logger } from "../logger";
import { CircuitBreaker } from "../utils/circuit-breaker";
import { sanitizeContent } from "../utils/sanitize";

/** Zod schema mirroring contracts/triage-response.schema.json. */
export const TriageResponseSchema = z.object({
  mode: z.enum(["daemon", "shared-runner", "isolated-job"]),
  confidence: z.number().min(0).max(1),
  complexity: z.enum(["trivial", "moderate", "complex"]),
  rationale: z.string().min(1).max(500),
});
export type TriageResponse = z.infer<typeof TriageResponseSchema>;

export interface TriageResult extends TriageResponse {
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly provider: "anthropic" | "bedrock";
  readonly model: string;
  readonly deliveryId: string;
}

export type TriageFallbackReason =
  | "disabled"
  | "circuit-open"
  | "timeout"
  | "llm-error"
  | "parse-error"
  | "sub-threshold";

export type TriageOutcome =
  | { readonly outcome: "result"; readonly result: TriageResult }
  | {
      readonly outcome: "fallback";
      readonly reason: TriageFallbackReason;
      /**
       * Populated when triage parsed successfully but was gated by the
       * confidence threshold (`reason === "sub-threshold"`). Callers surface
       * this so the `default-fallback` path still carries triage telemetry
       * into logs, tracking comments, and denormalized execution columns.
       */
      readonly result?: TriageResult;
    };

/**
 * Minimal context that the triage prompt needs. Decoupled from `BotContext`
 * so unit tests can drive the engine without constructing Octokit stubs.
 */
export interface TriageInput {
  readonly deliveryId: string;
  readonly owner: string;
  readonly repo: string;
  readonly eventName: string;
  readonly isPR: boolean;
  readonly labels: readonly string[];
  readonly triggerBody: string;
}

const SYSTEM_PROMPT = `You are a dispatch-routing classifier for a GitHub-integration bot. Given an event that a deterministic classifier could not confidently route, you pick one of three execution targets:

- "daemon": local daemon pool, standard tooling only (no Docker / no privileged commands). Default for most code changes.
- "shared-runner": a shared long-lived sandbox with broader tooling. Use when the event mentions running tests / builds across multiple services and Docker is NOT required.
- "isolated-job": ephemeral Kubernetes pod with Docker-in-Docker. Use ONLY when the event requires container tooling (docker build, docker compose, dind, kind, etc.).

You must respond with ONLY a JSON object, no prose, matching:
{"mode":"daemon"|"shared-runner"|"isolated-job","confidence":0.0-1.0,"complexity":"trivial"|"moderate"|"complex","rationale":"one sentence, max 500 chars"}

Confidence is your probability that \`mode\` is the right target. Complexity is independent of mode: how many turns a competent agent needs — "trivial" = ≤10, "moderate" = ~30, "complex" = 50+.`;

/**
 * A single shared circuit breaker for the process. Per research.md R7 the
 * breaker is in-process shared-memory; module-level singleton is the
 * idiomatic way to share it across triage calls.
 */
const breaker = new CircuitBreaker({
  maxConsecutiveFailures: 5,
  latencyTripMs: 10_000,
  cooldownMs: 60_000,
  onStateChange: (from, to, reason) => {
    logger.warn({ from, to, reason }, "triage circuit breaker transition");
  },
});

/** Test-only: reset the shared breaker between test files. */
export function _resetTriageBreakerForTests(): void {
  breaker.reset();
}

/** Build the user-role prompt from the event context. */
export function buildTriagePrompt(input: TriageInput): string {
  // Sanitize BEFORE clipping so HTML comments / invisible chars / leaked
  // GitHub tokens cannot ride into the LLM prompt. Mirrors the treatment
  // in src/core/prompt-builder.ts for the main agent prompt.
  const sanitizedLabels = input.labels.map((l) => sanitizeContent(l));
  const labelsLine = sanitizedLabels.length > 0 ? sanitizedLabels.join(", ") : "(none)";
  const sanitizedBody = sanitizeContent(input.triggerBody);
  const body = sanitizedBody.length > 2_000 ? sanitizedBody.slice(0, 2_000) : sanitizedBody;
  return [
    `Repository: ${input.owner}/${input.repo}`,
    `Event: ${input.eventName} on ${input.isPR ? "pull request" : "issue"}`,
    `Labels: ${labelsLine}`,
    `Trigger body:`,
    body,
  ].join("\n");
}

/**
 * Extract a JSON object from the model's reply. The system prompt asks for
 * pure JSON, but models occasionally wrap in code fences or add a leading
 * sentence. Rather than rejecting those, try to locate the first top-level
 * JSON object and parse it. Any parse failure returns null and the caller
 * reports `parse-error`.
 */
export function extractJsonObject(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
  return trimmed.slice(firstBrace, lastBrace + 1);
}

/**
 * Persist a `triage_results` row. Called only on a clean parse+mode-known
 * outcome (confidence gating is a separate concern). Non-fatal: logs and
 * continues on DB write failure so a transient Postgres outage doesn't
 * abort an already-successful triage call.
 */
export async function persistTriageResult(result: TriageResult): Promise<void> {
  const db = getDb();
  if (db === null) return;
  try {
    await db`
      INSERT INTO triage_results (
        delivery_id, mode, confidence, complexity, rationale,
        cost_usd, latency_ms, provider, model
      ) VALUES (
        ${result.deliveryId}, ${result.mode}, ${result.confidence}, ${result.complexity},
        ${result.rationale}, ${result.costUsd}, ${result.latencyMs},
        ${result.provider}, ${result.model}
      )
      ON CONFLICT (delivery_id) DO NOTHING
    `;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), deliveryId: result.deliveryId },
      "Failed to persist triage_results row (non-fatal)",
    );
  }
}

/**
 * Race a promise against a timeout. Resolves with the original promise or
 * rejects with a typed error whose message starts with "triage-timeout".
 */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<T>([
      p,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`triage-timeout after ${String(ms)}ms`));
        }, ms);
      }),
    ]);
  } finally {
    // Clear the timer once either branch settles. Without this, a fast
    // success leaves a pending setTimeout on the event loop that fires
    // into a no-op rejection — cheap but measurable on hot paths.
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

/**
 * Primary triage entry point. Called by the router when auto mode + static
 * classifier were ambiguous.
 *
 * @param input Event context — decoupled from BotContext for testability.
 * @param client Injected LLM client. Production callers pass the module-level
 *               singleton from `src/ai/llm-client.ts`; tests pass a stub.
 * @returns `{ outcome: "result", result }` on success above the threshold,
 *          `{ outcome: "fallback", reason }` otherwise. Never throws.
 */
export async function triageRequest(input: TriageInput, client: LLMClient): Promise<TriageOutcome> {
  if (!config.triageEnabled) {
    return { outcome: "fallback", reason: "disabled" };
  }

  const modelId = resolveModelId(config.triageModel, client.provider);
  const prompt = buildTriagePrompt(input);
  const timeoutMs = config.triageTimeoutMs;

  const breakerResult = await breaker.execute(async () =>
    withTimeout(
      client.create({
        model: modelId,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
        maxTokens: config.triageMaxTokens,
      }),
      timeoutMs,
    ),
  );

  if (breakerResult.outcome === "circuit-open") {
    logger.warn({ deliveryId: input.deliveryId }, "triage short-circuited by open breaker");
    return { outcome: "fallback", reason: "circuit-open" };
  }
  if (breakerResult.outcome === "error") {
    const msg = breakerResult.error?.message ?? "unknown";
    const reason: TriageFallbackReason = msg.startsWith("triage-timeout") ? "timeout" : "llm-error";
    logger.warn(
      { deliveryId: input.deliveryId, err: msg, reason },
      "triage LLM call failed; falling back",
    );
    return { outcome: "fallback", reason };
  }

  const response = breakerResult.value;
  if (response === undefined) {
    // Defensive: outcome:"ok" means value is defined. This branch exists to
    // satisfy exactOptionalPropertyTypes without a non-null assertion.
    return { outcome: "fallback", reason: "llm-error" };
  }

  const jsonText = extractJsonObject(response.text);
  if (jsonText === null) {
    // Run model output through the sanitizer before logging. The prompt
    // includes user-controlled text; a confused model could echo tokens
    // or HTML comments that would otherwise land unredacted in log sinks.
    const rawPreview = sanitizeContent(response.text.slice(0, 200));
    logger.warn(
      { deliveryId: input.deliveryId, rawPreview },
      "triage response did not contain a JSON object; falling back",
    );
    return { outcome: "fallback", reason: "parse-error" };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(jsonText);
  } catch (err) {
    logger.warn(
      { deliveryId: input.deliveryId, err: err instanceof Error ? err.message : String(err) },
      "triage response was not valid JSON; falling back",
    );
    return { outcome: "fallback", reason: "parse-error" };
  }

  const schemaResult = TriageResponseSchema.safeParse(parsedJson);
  if (!schemaResult.success) {
    logger.warn(
      { deliveryId: input.deliveryId, issues: schemaResult.error.issues },
      "triage response failed schema validation; falling back",
    );
    return { outcome: "fallback", reason: "parse-error" };
  }

  const triage = schemaResult.data;
  const result: TriageResult = {
    ...triage,
    costUsd: estimateHaikuCostUsd(response.usage),
    latencyMs: breakerResult.latencyMs,
    provider: client.provider,
    model: response.model,
    deliveryId: input.deliveryId,
  };

  // Persist BEFORE the confidence gate so observers always see what the
  // model returned, even when the router chooses to fall back for low
  // confidence. This is critical for SC-004 (dashboard aggregates).
  await persistTriageResult(result);

  if (triage.confidence < config.triageConfidenceThreshold) {
    logger.info(
      {
        deliveryId: input.deliveryId,
        confidence: triage.confidence,
        threshold: config.triageConfidenceThreshold,
      },
      "triage result below confidence threshold; falling back",
    );
    // Carry the parsed result through so the router can still populate
    // `default-fallback` executions with triage_confidence / triage_cost_usd
    // / triage_complexity and emit full telemetry on the dispatch-decision
    // log. The persisted `triage_results` row exists independently.
    return { outcome: "fallback", reason: "sub-threshold", result };
  }

  return { outcome: "result", result };
}
