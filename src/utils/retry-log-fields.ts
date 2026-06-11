/**
 * Canonical pino log-field schema for `retryWithBackoff` observability (issue #215).
 *
 * Mirrors `src/utils/octokit-observability.ts` and `src/core/log-fields.ts`: a
 * strict Zod shape pins the structured `retry.*` event family so the four
 * emit sites in `retryWithBackoff` cannot drift on a field name (e.g. `delayMs`
 * vs `delay_ms`) without the co-located test catching it. Emitters log plain
 * objects via `log.warn` / `log.info` / `log.error`; the schema is the
 * drift-prevention contract, not a runtime validator on the hot path.
 *
 * `attempt` is the 1-based attempt ordinal (aligns with OpenTelemetry
 * `http.request.resend_count`). `elapsed_ms` is wall-clock since
 * `retryWithBackoff` entry, so an `exhausted` line carries the full retry
 * window's duration without parsing prior lines. `delay_ms` is the *next*
 * backoff that will be slept (set on `retry.attempt_failed` only when another
 * attempt will follow; omitted on the final attempt because no sleep will
 * occur).
 *
 * The schema is a `z.discriminatedUnion` on `event` so per-event field
 * presence is pinned: `retry.non_retriable` requires `status` (the 4xx branch
 * always has it), only `retry.attempt_failed` may carry `delay_ms`, and
 * `retry.exhausted` / `retry.succeeded_after_retry` carry neither. Future
 * emitter changes that drop a required field or attach `delay_ms` to the
 * wrong event trip the co-located test.
 *
 * `op` follows lowercase-dotted segments with snake_case inside each segment
 * (e.g. `mcp.inline_comment.fetch_pr`, `github.state.pr_state_check_rollup`,
 * `tracking_comment.create`). The convention is documented under "Retry log
 * fields" in `docs/operate/observability.md`; new call sites should follow it
 * so future operator queries (`op =~ "mcp\\..*"`) stay regular.
 */
import { z } from "zod";

export const RETRY_LOG_EVENTS = {
  attemptFailed: "retry.attempt_failed",
  nonRetriable: "retry.non_retriable",
  exhausted: "retry.exhausted",
  succeededAfterRetry: "retry.succeeded_after_retry",
} as const;

/**
 * Shared scalar shape across every `retry.*` event. `err` is intentionally
 * not enumerated here: it is serialized via pino's existing `errSerializer`
 * and remains attached to the line as-is, mirroring the existing
 * `GithubApiLogFieldsSchema` pattern (which also does not enumerate `err`).
 * Callers test the structured scalar fields; pino serializes the error.
 */
const baseFields = {
  op: z.string().min(1),
  attempt: z.number().int().positive(),
  max_attempts: z.number().int().positive(),
  elapsed_ms: z.number().int().nonnegative(),
} as const;

export const RetryLogFieldsSchema = z.discriminatedUnion("event", [
  /**
   * Warn-level emit on a retriable failure. `delay_ms` is present when
   * another attempt will follow (and equals the next backoff sleep);
   * omitted on the final attempt because no sleep occurs. `status` is
   * present when the raw error carried one (HTTP errors) and absent for
   * non-HTTP errors like connection resets.
   */
  z.strictObject({
    event: z.literal(RETRY_LOG_EVENTS.attemptFailed),
    ...baseFields,
    delay_ms: z.number().int().nonnegative().optional(),
    status: z.number().int().optional(),
  }),
  /**
   * Warn-level emit on a 4xx (except 429 and 403 secondary-rate-limit) that
   * bypasses retry. `status` is always present in this branch because
   * `isNonRetriable` only returns `true` when a numeric 4xx status was
   * read off the error.
   */
  z.strictObject({
    event: z.literal(RETRY_LOG_EVENTS.nonRetriable),
    ...baseFields,
    status: z.number().int(),
  }),
  /**
   * Error-level emit after `maxAttempts` retriable failures. No `delay_ms`
   * (no further sleep), no `status` (last-error context lives on `err`).
   */
  z.strictObject({
    event: z.literal(RETRY_LOG_EVENTS.exhausted),
    ...baseFields,
  }),
  /**
   * Info-level emit when an attempt succeeded after at least one prior
   * failure. Gated on `attempt > 1` so first-try successes stay silent.
   */
  z.strictObject({
    event: z.literal(RETRY_LOG_EVENTS.succeededAfterRetry),
    ...baseFields,
  }),
]);

export type RetryLogFields = z.infer<typeof RetryLogFieldsSchema>;
