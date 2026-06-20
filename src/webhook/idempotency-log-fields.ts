/**
 * Canonical pino log-field schema for `claimDelivery` observability (issue #232).
 *
 * Mirrors `src/utils/retry-log-fields.ts`: a strict Zod shape pins the
 * structured `idempotency.*` event family so the emit sites in `claimDelivery`
 * cannot drift on a field name (e.g. `reason` value or `failed_open` vs
 * `failed-open`) without the co-located test catching it. Emitters log plain
 * objects via `log.info` / `log.warn`; the schema is the drift-prevention
 * contract, not a runtime validator on the hot path.
 *
 * The schema is a `z.discriminatedUnion` on `event` so per-event field presence
 * is pinned: `idempotency.failed_open` requires a `reason` enum and may carry
 * `err`; the `claimed` / `duplicate_skipped` branches carry neither. Future
 * emitter changes that drop `reason` or attach it to the wrong event trip the
 * co-located test.
 */
import { z } from "zod";

export const IDEMPOTENCY_LOG_EVENTS = {
  claimed: "idempotency.claimed",
  duplicateSkipped: "idempotency.duplicate_skipped",
  failedOpen: "idempotency.failed_open",
} as const;

// `deliveryId` stays camelCase because it is the established repo-wide
// child-logger delivery identifier binding; new metric-style fields use snake_case.
const deliveryId = z.string().min(1);

export const IdempotencyLogFieldsSchema = z.discriminatedUnion("event", [
  /**
   * Info-level emit when the SET-NX won the claim (first delivery seen). The
   * caller proceeds.
   */
  z.strictObject({
    event: z.literal(IDEMPOTENCY_LOG_EVENTS.claimed),
    deliveryId,
  }),
  /**
   * Info-level emit when the SET-NX found an existing key (a redelivery). The
   * caller skips.
   */
  z.strictObject({
    event: z.literal(IDEMPOTENCY_LOG_EVENTS.duplicateSkipped),
    deliveryId,
  }),
  /**
   * Warn-level emit on the fail-open path: `reason` is `unavailable` when
   * Valkey is unconfigured/disconnected (no SET issued) or `error` when the SET
   * threw. `err` carries the error message on the `error` branch only. Either
   * way the caller proceeds (at-least-once degradation).
   */
  z.strictObject({
    event: z.literal(IDEMPOTENCY_LOG_EVENTS.failedOpen),
    deliveryId,
    reason: z.enum(["unavailable", "error"]),
    err: z.string().optional(),
  }),
]);

export type IdempotencyLogFields = z.infer<typeof IdempotencyLogFieldsSchema>;
