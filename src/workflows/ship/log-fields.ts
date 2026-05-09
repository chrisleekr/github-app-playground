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
 * Uses `Math.round` (half-away-from-zero); the half-cent edge is rare
 * enough in real billing data that the small bias is acceptable.
 */
export function usdToCents(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) return 0;
  return Math.round(usd * 100);
}

/**
 * Canonical pino `event` keys emitted by the ship-iteration-wiring code path
 * (FR-018). Centralised here so a typo in any emitter is a compile error,
 * and so the quickstart S0 pre-flight check can grep for these literals.
 */
export const SHIP_LOG_EVENTS = {
  iteration: {
    enqueued: "ship.iteration.enqueued",
    terminalCap: "ship.iteration.terminal_cap",
    terminalDeadline: "ship.iteration.terminal_deadline",
    skipInflight: "ship.iteration.skip_inflight",
  },
  tickle: {
    started: "ship.tickle.started",
    due: "ship.tickle.due",
    skipTerminal: "ship.tickle.skip_terminal",
    skipFailedChild: "ship.tickle.skip_failed_child",
  },
  scoped: {
    rebase: {
      enqueued: "ship.scoped.rebase.enqueued",
      daemonCompleted: "ship.scoped.rebase.daemon.completed",
      daemonFailed: "ship.scoped.rebase.daemon.failed",
    },
    fixThread: {
      enqueued: "ship.scoped.fix_thread.enqueued",
      daemonCompleted: "ship.scoped.fix_thread.daemon.completed",
      daemonFailed: "ship.scoped.fix_thread.daemon.failed",
    },
    openPr: {
      enqueued: "ship.scoped.open_pr.enqueued",
      daemonCompleted: "ship.scoped.open_pr.daemon.completed",
      daemonFailed: "ship.scoped.open_pr.daemon.failed",
    },
  },
} as const;
