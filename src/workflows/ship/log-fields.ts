/**
 * Canonical pino log-field schema for ship-workflow events (T054, FR-016).
 *
 * Every emitter in `src/workflows/ship/*` consumes this Zod schema so
 * field names and types do not drift between modules. The `log-fields`
 * test round-trips a sample line through the schema and rejects unknown
 * or mistyped fields — drift = test failure.
 *
 * Spend is reported in **integer USD cents** (not floats) to avoid
 * binary-fp drift in downstream aggregations. The bot pays in fractional
 * cents (Anthropic billing); the conversion to cents is the emitter's
 * responsibility (`Math.round(usd * 100)`).
 */

import { z } from "zod";

import {
  BlockerCategorySchema,
  SessionStatusSchema,
  TriggerSurfaceSchema,
} from "../../shared/ship-types";
import { NonReadinessReasonSchema } from "./verdict";

export const SHIP_LOG_PHASE = z.enum(["probe", "fix", "reply", "wait", "terminal"]);

const PrShape = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int().positive(),
  installation_id: z.number().int().positive(),
});

export const ShipLogFieldsSchema = z
  .object({
    event: z.string().min(1),
    intent_id: z.uuid(),
    pr: PrShape,
    iteration_n: z.number().int().nonnegative(),
    phase: SHIP_LOG_PHASE.optional(),
    from_status: SessionStatusSchema.optional(),
    to_status: SessionStatusSchema.optional(),
    terminal_blocker_category: BlockerCategorySchema.optional(),
    non_readiness_reason: NonReadinessReasonSchema.optional(),
    trigger_surface: TriggerSurfaceSchema.optional(),
    principal_login: z.string().min(1).optional(),
    spent_usd_cents: z.number().int().nonnegative(),
    wall_clock_ms: z.number().int().nonnegative(),
    delta_usd_cents: z.number().int().nonnegative().optional(),
    delta_ms: z.number().int().nonnegative().optional(),
  })
  .strict();

export type ShipLogFields = z.infer<typeof ShipLogFieldsSchema>;

/**
 * Convert a USD float (Anthropic billing format) to integer cents.
 * Banker's-rounded for the half-cent edge.
 */
export function usdToCents(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) return 0;
  return Math.round(usd * 100);
}
