/**
 * Fix-attempts ledger (T039, FR-013). Counts how many times the bot has
 * attempted to fix a particular failure signature within a single
 * intent. Backed by the `ship_fix_attempts` table from migration 008
 * via the typed helpers in `src/db/queries/ship.ts`.
 *
 * Two-tier semantics from `signature.ts` (T038):
 *   tier 1 — known format; expect ≤2 attempts to fix
 *   tier 2 — opaque failure; expect ≤1 attempt before halting
 *
 * Cap is `config.fixAttemptsPerSignatureCap` (default 3). Once the
 * cap fires for any signature within an intent, the ship handler
 * (T046) terminates the intent with `BlockerCategory='flake-cap'`.
 */

import type { SQL } from "bun";

import { config } from "../../config";
import { requireDb } from "../../db";
import { getFixAttempt, incrementFixAttempt } from "../../db/queries/ship";

export interface RecordAttemptInput {
  readonly intent_id: string;
  readonly signature: string;
  readonly tier: 1 | 2;
}

export interface AttemptRow {
  readonly attempts: number;
  readonly tier: 1 | 2;
}

export async function recordAttempt(
  input: RecordAttemptInput,
  sql: SQL = requireDb(),
): Promise<AttemptRow> {
  const row = await incrementFixAttempt(input.intent_id, input.signature, input.tier, sql);
  return { attempts: row.attempts, tier: row.tier };
}

export async function getAttempts(
  intent_id: string,
  signature: string,
  sql: SQL = requireDb(),
): Promise<AttemptRow | null> {
  const row = await getFixAttempt(intent_id, signature, sql);
  if (row === null) return null;
  return { attempts: row.attempts, tier: row.tier };
}

/**
 * True when the next fix attempt against `signature` would push the
 * counter past the configured cap. The handler MUST consult this
 * BEFORE invoking the agent (so the cap-firing iteration spends nothing
 * beyond the probe).
 */
export async function isCapped(
  intent_id: string,
  signature: string,
  sql: SQL = requireDb(),
): Promise<boolean> {
  const row = await getFixAttempt(intent_id, signature, sql);
  if (row === null) return false;
  return row.attempts >= config.fixAttemptsPerSignatureCap;
}
