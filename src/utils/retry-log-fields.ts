/**
 * Canonical pino log-field schema for `retryWithBackoff` observability (issue #215).
 *
 * Mirrors `src/utils/octokit-observability.ts` and `src/core/log-fields.ts`: a
 * `.strict()` Zod shape pins the structured `retry.*` event family so the four
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
 */
import { z } from "zod";

export const RETRY_LOG_EVENTS = {
  attemptFailed: "retry.attempt_failed",
  nonRetriable: "retry.non_retriable",
  exhausted: "retry.exhausted",
  succeededAfterRetry: "retry.succeeded_after_retry",
} as const;

/**
 * `.strict()` shape for the four-event family. `err` is intentionally not
 * enumerated here: it is serialized via pino's existing `errSerializer` and
 * remains attached to the line as-is, mirroring the existing
 * `GithubApiLogFieldsSchema` pattern (which also does not enumerate `err`).
 * Callers test the structured scalar fields; pino serializes the error.
 */
export const RetryLogFieldsSchema = z
  .object({
    event: z.enum([
      RETRY_LOG_EVENTS.attemptFailed,
      RETRY_LOG_EVENTS.nonRetriable,
      RETRY_LOG_EVENTS.exhausted,
      RETRY_LOG_EVENTS.succeededAfterRetry,
    ]),
    op: z.string().min(1),
    attempt: z.number().int().positive(),
    max_attempts: z.number().int().positive(),
    elapsed_ms: z.number().int().nonnegative(),
    delay_ms: z.number().int().nonnegative().optional(),
    status: z.number().int().optional(),
  })
  .strict();

export type RetryLogFields = z.infer<typeof RetryLogFieldsSchema>;
