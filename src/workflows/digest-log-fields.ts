/**
 * Canonical pino log-field schema for the discussion-digest LLM family (issue #228).
 *
 * Mirrors `src/orchestrator/log-fields.ts` and `src/core/log-fields.ts`: a strict
 * Zod shape pins the structured `digest.*` event family so the emit sites in
 * `discussion-digest.ts` cannot drift on a field name, level, or enum value
 * without the co-located test catching it. Emitters log plain objects via
 * `log.info` / `log.warn`; the schema is the drift-prevention contract, not a
 * runtime validator on the hot path.
 *
 * The digest is on the forced prefix of every comment-aware workflow (triage,
 * plan, implement, review, resolve, remember). It runs ≥1 LLM call per event
 * and was previously invisible: a successful run emitted nothing, so skip rate,
 * token spend, per-call latency, and trust-boundary effectiveness were all
 * un-observable. These four events surface those signals.
 *
 * Each event is a strict per-shape branch in a `z.discriminatedUnion("event")`,
 * so per-event field presence is pinned exactly (e.g. `digest.call.completed`
 * carries `phase`/token counts but no `reason`; `digest.failed` carries only
 * `reason`). A flat optional-laden object could not express that.
 *
 * Field-naming: new metric fields are snake_case (`input_tokens`, `latency_ms`,
 * `total_latency_ms`), matching the codebase's numeric-metric idiom
 * (`delta_ms`, `offer_latency_ms`). No attacker-controlled comment content is
 * ever logged here: counts, lengths, durations, and bounded enums only.
 */
import { z } from "zod";

export const DIGEST_LOG_EVENTS = {
  skipped: "digest.skipped",
  callCompleted: "digest.call.completed",
  completed: "digest.completed",
  failed: "digest.failed",
} as const;

/** The two LLM-call roles: single-pass / per-chunk extract, and the merge pass. */
const phase = z.enum(["extract", "reduce"]);
/** `parseStructuredResponse` strategy carried through for JSON-quality monitoring. */
const strategy = z.enum(["strict", "tolerant"]);
/** The `DigestResult` failure reasons, 1:1 with the union in discussion-digest.ts. */
const failReason = z.enum(["no-comments", "llm-error", "parse-error"]);

export const DigestLogFieldsSchema = z.discriminatedUnion("event", [
  /** Info: bot-only/empty thread, no LLM call issued. Counts only, never bodies. */
  z.strictObject({
    event: z.literal(DIGEST_LOG_EVENTS.skipped),
    comment_counts: z.strictObject({
      owner: z.number().int().nonnegative(),
      other: z.number().int().nonnegative(),
      bot: z.number().int().nonnegative(),
    }),
  }),
  /** Info: one LLM call returned and parsed. Token + latency + parse strategy. */
  z.strictObject({
    event: z.literal(DIGEST_LOG_EVENTS.callCompleted),
    phase,
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    latency_ms: z.number().int().nonnegative(),
    strategy,
  }),
  /** Info: digest built end-to-end. Shape metrics + trust-boundary outcome. */
  z.strictObject({
    event: z.literal(DIGEST_LOG_EVENTS.completed),
    chunks: z.number().int().positive(),
    total_latency_ms: z.number().int().nonnegative(),
    directives_kept: z.number().int().nonnegative(),
    directives_dropped: z.number().int().nonnegative(),
    has_prior_bot_output: z.boolean(),
    untrusted_context_count: z.number().int().nonnegative(),
    conversation_summary_chars: z.number().int().nonnegative(),
  }),
  /** Warn: digest failed; `reason` carries the propagated DigestResult reason. */
  z.strictObject({
    event: z.literal(DIGEST_LOG_EVENTS.failed),
    reason: failReason,
  }),
]);

export type DigestLogFields = z.infer<typeof DigestLogFieldsSchema>;
