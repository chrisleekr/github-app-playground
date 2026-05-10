/**
 * Schema for the JSONB `state` blob that ship-driven iterations write into
 * `workflow_runs.state` so the orchestrator's completion cascade can
 * early-wake the originating ship intent (research.md Q1; the column is
 * named `state` in `005_workflow_runs.sql`, the spec calls it "context_json"
 * generically because it carries per-run context).
 *
 * This module owns the `shipIntentId` convention end-to-end:
 *   - producers (iteration handler) call `serializeShipWorkflowContext` before
 *     inserting a `workflow_runs` row;
 *   - the orchestrator cascade calls `extractShipIntentId` on every completed
 *     run's `context_json` and ZADDs `ship:tickle` when present.
 *
 * Validating at both ends with the same schema keeps the contract honest and
 * survives any future field additions to `context_json`.
 */

import { z } from "zod";

/**
 * Shape of the `context_json` blob written by the ship iteration handler.
 * Additive: existing rows without `shipIntentId` parse cleanly because the
 * field is optional at the schema layer: the cascade simply skips them.
 */
export const ShipIntentContextSchema = z
  .object({
    shipIntentId: z.uuid(),
  })
  .partial();

export type ShipIntentContext = z.infer<typeof ShipIntentContextSchema>;

/**
 * Build the `context_json` blob for a ship-iteration `workflow_runs` row.
 * Call site: `src/workflows/ship/iteration.ts` before `INSERT INTO workflow_runs`.
 */
export function serializeShipWorkflowContext(intentId: string): ShipIntentContext {
  return ShipIntentContextSchema.parse({ shipIntentId: intentId });
}

/**
 * Best-effort lookup of `shipIntentId` from a freshly-completed
 * `workflow_runs.state` blob. Returns `undefined` when the field is absent
 * or malformed so the cascade can no-op cleanly without throwing on legacy
 * rows.
 */
export function extractShipIntentId(state: unknown): string | undefined {
  const parsed = ShipIntentContextSchema.safeParse(state);
  if (!parsed.success) return undefined;
  return parsed.data.shipIntentId;
}
