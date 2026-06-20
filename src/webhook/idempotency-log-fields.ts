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
 * The schema is a union of strict per-outcome objects so per-event field
 * presence is pinned exactly: `claimed` / `duplicate_skipped` carry only
 * `deliveryId`; `failed_open` splits into a `reason: "unavailable"` branch
 * (no `err`) and a `reason: "error"` branch (`err` required). The fail-open
 * split is two branches rather than a `reason` enum + optional `err` so the
 * contract "`err` only on the `error` path" is enforced by the schema itself,
 * not just by emit-site discipline: a future emit attaching `err` to an
 * `unavailable` line is rejected here and trips the co-located test.
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

export const IdempotencyLogFieldsSchema = z.union([
  /** Info: the SET-NX won the claim (first delivery seen); the caller proceeds. */
  z.strictObject({
    event: z.literal(IDEMPOTENCY_LOG_EVENTS.claimed),
    deliveryId,
  }),
  /** Info: the SET-NX found an existing key (a redelivery); the caller skips. */
  z.strictObject({
    event: z.literal(IDEMPOTENCY_LOG_EVENTS.duplicateSkipped),
    deliveryId,
  }),
  /** Warn: Valkey unconfigured/disconnected, no SET issued. The caller proceeds. */
  z.strictObject({
    event: z.literal(IDEMPOTENCY_LOG_EVENTS.failedOpen),
    deliveryId,
    reason: z.literal("unavailable"),
  }),
  /** Warn: the SET threw; `err` carries the message. The caller proceeds. */
  z.strictObject({
    event: z.literal(IDEMPOTENCY_LOG_EVENTS.failedOpen),
    deliveryId,
    reason: z.literal("error"),
    err: z.string(),
  }),
]);

export type IdempotencyLogFields = z.infer<typeof IdempotencyLogFieldsSchema>;
