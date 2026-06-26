/**
 * Canonical pino log-field schema for `parseStructuredResponse` observability
 * (issue #233).
 *
 * Mirrors `src/utils/retry-log-fields.ts` and `src/webhook/idempotency-log-fields.ts`:
 * a strict Zod shape pins the structured `structured_output.*` event family so
 * the three emit sites in the chokepoint cannot drift on a field name (e.g.
 * `parseMs` vs `parse_ms`) without the co-located test catching it. Emitters log
 * plain objects via `log.info` / `log.warn`; the schema is the drift-prevention
 * contract, not a runtime validator on the hot path.
 *
 * The chokepoint owns the emit so all eight LLM JSON call sites report the same
 * field shape. `site` is the call-site discriminator (e.g. `chat-thread`,
 * `triage-orchestrator`) so an operator can compute the strict-vs-tolerant ratio
 * per site, the leading indicator of a model JSON-quality regression. `raw_len`
 * is the length of the model's raw text (a length, never the bytes, so no
 * attacker-influenced content reaches the log line). `parse_ms` is wall-clock
 * from chokepoint entry to return.
 *
 * The schema is a `z.discriminatedUnion` on `event` so per-event field presence
 * is pinned: `structured_output.parsed` carries `strategy`; the two failure
 * events carry `error` (serialized via redaction at the emit site), and
 * `validate_failed` additionally carries `parsed_kind` for debuggability. A
 * future emit attaching `strategy` to a failure event or dropping a required
 * field trips the co-located test.
 */
import { z } from "zod";

export const STRUCTURED_OUTPUT_EVENTS = {
  parsed: "structured_output.parsed",
  parseFailed: "structured_output.parse_failed",
  validateFailed: "structured_output.validate_failed",
} as const;

/** Shared scalar shape across every `structured_output.*` event. */
const baseFields = {
  site: z.string().min(1),
  raw_len: z.number().int().nonnegative(),
  parse_ms: z.number().int().nonnegative(),
} as const;

export const StructuredOutputLogFieldsSchema = z.discriminatedUnion("event", [
  /**
   * Info: parse + validate succeeded. `strategy` distinguishes a clean
   * `JSON.parse` (`strict`) from a tolerant repair pass (`tolerant`); a
   * rising tolerant share per `site` is the model JSON-quality regression
   * signal.
   */
  z.strictObject({
    event: z.literal(STRUCTURED_OUTPUT_EVENTS.parsed),
    ...baseFields,
    strategy: z.enum(["strict", "tolerant"]),
  }),
  /** Warn: both strict and tolerant parse failed. `error` is the parser message. */
  z.strictObject({
    event: z.literal(STRUCTURED_OUTPUT_EVENTS.parseFailed),
    ...baseFields,
    error: z.string(),
  }),
  /**
   * Warn: parse succeeded but schema validation rejected the value.
   * `parsed_kind` is the JSON shape that validated against the wrong schema,
   * useful when a model returns an array where an object was expected.
   */
  z.strictObject({
    event: z.literal(STRUCTURED_OUTPUT_EVENTS.validateFailed),
    ...baseFields,
    error: z.string(),
    parsed_kind: z.enum(["object", "array", "primitive"]),
  }),
]);

export type StructuredOutputLogFields = z.infer<typeof StructuredOutputLogFieldsSchema>;
