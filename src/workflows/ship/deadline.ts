/**
 * Wall-clock deadline enforcement (T042, FR-014). Owns the
 * `--deadline` flag parser (used by literal/label/NL surfaces) and the
 * "is now past `deadline_at`" check used by the cron tickle to
 * terminate intents that have run past their wall-clock budget.
 *
 * Per Q2-round1: deadline carries over UNCHANGED on cascade base-ref
 * change — the deadline tracks human attention budget, not work
 * progress.
 */

import { config } from "../../config";
import type { ShipIntentRow } from "../../db/queries/ship";

export interface ParsedDeadline {
  readonly deadline_ms: number;
}

/**
 * Parse `--deadline <N><unit>` from upstream parsers (label-trigger
 * already does this in its own grammar; this fn is the canonical
 * validator the trigger-router uses to clamp). Returns
 * `config.maxWallClockPerShipRun` when input is undefined or invalid.
 */
export function parseDeadlineFlag(requestedMs: number | undefined): ParsedDeadline {
  const max = config.maxWallClockPerShipRun;
  if (requestedMs === undefined) return { deadline_ms: max };
  if (!Number.isFinite(requestedMs) || requestedMs <= 0) return { deadline_ms: max };
  return { deadline_ms: Math.min(requestedMs, max) };
}

export interface EnforceDeadlineResult {
  readonly exceeded: boolean;
  readonly remainingMs: number;
}

export function enforceDeadline(
  intent: Pick<ShipIntentRow, "deadline_at">,
  now: Date = new Date(),
): EnforceDeadlineResult {
  const remainingMs = intent.deadline_at.getTime() - now.getTime();
  return { exceeded: remainingMs <= 0, remainingMs };
}
