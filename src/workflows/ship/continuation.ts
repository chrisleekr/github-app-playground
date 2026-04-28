/**
 * Continuation persistence (R5 / R7) for `bot:ship` sessions. Each
 * intent has at most one continuation row in `ship_continuations`;
 * persisting overwrites in place. Loaded `state_blob` is Zod-validated
 * (only `v: 1` is accepted today).
 */

import type { SQL } from "bun";
import { z } from "zod";

import { requireDb } from "../../db";
import {
  type ContinuationWaitFor,
  deleteContinuation as dbDeleteContinuation,
  type ShipContinuationRow,
  upsertContinuation as dbUpsertContinuation,
} from "../../db/queries/ship";

export const StateBlobV1Schema = z.object({
  v: z.literal(1),
  phase: z.enum(["probe", "fix", "reply", "wait", "terminal"]),
  last_action: z.string(),
  iteration_n: z.number().int().nonnegative(),
  // Allow forward-extension fields under `extra` without bumping the version.
  extra: z.record(z.string(), z.unknown()).optional(),
});

export type StateBlobV1 = z.infer<typeof StateBlobV1Schema>;

export interface PersistContinuationInput {
  readonly intent_id: string;
  readonly wait_for: ContinuationWaitFor[];
  readonly wake_at: Date;
  readonly state_blob: StateBlobV1;
}

export async function persistContinuation(
  input: PersistContinuationInput,
  sql: SQL = requireDb(),
): Promise<ShipContinuationRow> {
  return dbUpsertContinuation(
    {
      intent_id: input.intent_id,
      wait_for: input.wait_for,
      wake_at: input.wake_at,
      state_blob: input.state_blob,
      state_version: input.state_blob.v,
    },
    sql,
  );
}

export type ResumeResult =
  | { readonly resumed: true; readonly state: StateBlobV1; readonly wake_at: Date }
  | { readonly resumed: false; readonly reason: "not_found" | "invalid_blob" };

/**
 * Resume the persisted continuation for an intent. Validates the
 * stored `state_blob` against the v1 Zod schema; refuses unknown
 * `v` values with a typed `invalid_blob` so the caller can flag
 * the intent for human follow-up rather than continuing on
 * unverified state.
 */
export async function resumeContinuation(
  intent_id: string,
  sql: SQL = requireDb(),
): Promise<ResumeResult> {
  const rows: ShipContinuationRow[] = await sql`
    SELECT * FROM ship_continuations WHERE intent_id = ${intent_id}
  `;
  const row = rows[0];
  if (row === undefined) return { resumed: false, reason: "not_found" };
  const parsed = StateBlobV1Schema.safeParse(row.state_blob);
  if (!parsed.success) return { resumed: false, reason: "invalid_blob" };
  return { resumed: true, state: parsed.data, wake_at: row.wake_at };
}

export async function deleteContinuation(
  intent_id: string,
  sql: SQL = requireDb(),
): Promise<number> {
  return dbDeleteContinuation(intent_id, sql);
}
