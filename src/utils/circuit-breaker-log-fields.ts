/**
 * Canonical pino log-field schema for the triage circuit breaker (issue #216).
 *
 * Mirrors `src/webhook/idempotency-log-fields.ts`: a strict Zod shape pins the
 * structured `circuit.*` event family so the emit sites in `CircuitBreaker` and
 * its triage caller cannot drift on a field name (e.g. `open_ms` vs `openMs`, or
 * a stray `latency_tripped` on a path that never trips on latency) without the
 * co-located test catching it. Emitters log plain objects via `log.info` /
 * `log.warn`; the schema is the drift-prevention contract, not a runtime
 * validator on the hot path.
 *
 * WHY a generic `circuit.*` family rather than `triage.circuit.*`: the breaker
 * module is provider-agnostic and the only caller is triage, so the request
 * context (deliveryId) rides on the pino child binding, not the event name. A
 * future second breaker caller reuses the same family and gets the same fields.
 *
 * Field-presence is pinned per-event by a discriminated union of strict objects:
 *   - opened     → `from` + `consecutive_failures` + `latency_tripped` (warn)
 *   - half_open  → `from` only (info)
 *   - closed     → `open_ms` (info; time from trip to recovery, the MTTR signal)
 *   - skipped    → `open_ms` + `skips_since_opened` (warn; one per short-circuit)
 *   - failure    → pre-trip progress counter, gates the operator head-start alert (warn)
 *
 * snake_case for the new metric fields; `from`/`to` stay bare because they are
 * the established `CircuitBreakerState` enum bindings on the existing transition log.
 */
import { z } from "zod";

export const CIRCUIT_LOG_EVENTS = {
  opened: "circuit.opened",
  halfOpen: "circuit.half_open",
  closed: "circuit.closed",
  skipped: "circuit.skipped",
  failure: "circuit.failure",
} as const;

const state = z.enum(["closed", "open", "half-open"]);
const nonNegativeInt = z.number().int().nonnegative();

export const CircuitLogFieldsSchema = z.discriminatedUnion("event", [
  /** Warn: the breaker tripped to open. `latency_tripped` distinguishes a slow-call trip from a thrown-error trip. */
  z.strictObject({
    event: z.literal(CIRCUIT_LOG_EVENTS.opened),
    from: state,
    consecutive_failures: nonNegativeInt,
    latency_tripped: z.boolean(),
  }),
  /** Info: cooldown elapsed; the next call is admitted as the half-open probe. */
  z.strictObject({
    event: z.literal(CIRCUIT_LOG_EVENTS.halfOpen),
    from: state,
  }),
  /** Info: a probe succeeded and the breaker closed. `open_ms` is trip→recovery wall-clock (MTTR). */
  z.strictObject({
    event: z.literal(CIRCUIT_LOG_EVENTS.closed),
    open_ms: nonNegativeInt,
  }),
  /** Warn: a request was short-circuited while open. One line per skip, with the running count for the open window. */
  z.strictObject({
    event: z.literal(CIRCUIT_LOG_EVENTS.skipped),
    open_ms: nonNegativeInt,
    skips_since_opened: nonNegativeInt,
  }),
  /** Warn: pre-trip progress. Fires on every recorded failure short of tripping, so operators get a head start. */
  z.strictObject({
    event: z.literal(CIRCUIT_LOG_EVENTS.failure),
    consecutive_failures: nonNegativeInt,
    max_consecutive_failures: nonNegativeInt,
    latency_tripped: z.boolean(),
  }),
]);

export type CircuitLogFields = z.infer<typeof CircuitLogFieldsSchema>;
