/**
 * Typed `Bun.sql` helpers for the four `ship_*` tables introduced in
 * migration `008_ship_intents.sql`. Every mutation that touches the
 * shepherding state machine routes through here so the SQL stays in
 * one place and the application-layer Zod enums (`SessionStatus`,
 * `BlockerCategory`, `NonReadinessReason`) match the SQL CHECK
 * constraints byte-for-byte.
 *
 * Higher-level lifecycle functions live in `src/workflows/ship/intent.ts`
 * (T018) — that module wraps these helpers with state-machine guards
 * (e.g. guarded `UPDATE ... WHERE status = '<expected>'` for pause/resume).
 */

import type { SQL } from "bun";

import type { BlockerCategory, SessionStatus, SessionTerminalState } from "../../shared/ship-types";
import { requireDb } from "..";

/**
 * Format a JS string[] as a Postgres array literal so it can be passed
 * to a `text[]` column with an inline `::text[]` cast on the placeholder.
 *
 * Bun.sql does not auto-encode JS arrays for `text[]` columns (it
 * encodes them as comma-joined text — see the project memory
 * `feedback_bun_sql_array_binding.md`). Building the literal here keeps
 * the SQL site readable and the safe-binding boundary intact: the
 * literal still travels as a parameter, only the cast is in the SQL.
 */
function pgTextArrayLiteral(values: readonly string[]): string {
  const escaped = values.map((v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  return `{${escaped.join(",")}}`;
}

// ─── Row types ────────────────────────────────────────────────────────────────

export interface ShipIntentRow {
  readonly id: string;
  readonly installation_id: number;
  readonly owner: string;
  readonly repo: string;
  readonly pr_number: number;
  readonly target_base_sha: string;
  readonly target_head_sha: string;
  readonly status: SessionStatus;
  readonly deadline_at: Date;
  readonly spent_usd: string;
  readonly created_by_user: string;
  readonly tracking_comment_id: number | null;
  readonly tracking_comment_marker: string;
  readonly terminal_blocker_category: BlockerCategory | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly terminated_at: Date | null;
}

export type ShipIterationKind = "probe" | "resolve" | "review" | "branch-refresh";

export type NonReadinessReason =
  | "failing_checks"
  | "open_threads"
  | "changes_requested"
  | "behind_base"
  | "mergeable_pending"
  | "pending_checks"
  | "human_took_over"
  | "review_barrier_deferred";

export interface ShipIterationRow {
  readonly id: string;
  readonly intent_id: string;
  readonly iteration_n: number;
  readonly kind: ShipIterationKind;
  readonly started_at: Date;
  readonly finished_at: Date | null;
  readonly verdict_json: unknown;
  readonly non_readiness_reason: NonReadinessReason | null;
  readonly cost_usd: string;
  readonly runs_store_id: string | null;
}

export type ContinuationWaitFor = "ci" | "coderabbit" | "review" | "mergeable" | "rebase";

export interface ShipContinuationRow {
  readonly intent_id: string;
  readonly wait_for: ContinuationWaitFor[];
  readonly wake_at: Date;
  readonly state_blob: unknown;
  readonly state_version: number;
  readonly updated_at: Date;
}

export interface ShipFixAttemptRow {
  readonly intent_id: string;
  readonly signature: string;
  readonly tier: 1 | 2;
  readonly attempts: number;
  readonly first_seen_at: Date;
  readonly last_seen_at: Date;
}

// ─── Insert / fetch helpers ───────────────────────────────────────────────────

export interface InsertIntentInput {
  readonly installation_id: number;
  readonly owner: string;
  readonly repo: string;
  readonly pr_number: number;
  readonly target_base_sha: string;
  readonly target_head_sha: string;
  readonly deadline_at: Date;
  readonly created_by_user: string;
  readonly tracking_comment_marker: string;
}

/**
 * Insert a new `ship_intents` row in `'active'` status. May reject with a
 * unique-constraint violation on `ship_intents_one_active_per_pr` when an
 * in-flight session already exists for the same `(owner, repo, pr_number)` —
 * callers (FR-007a) must surface the maintainer-facing "already in progress"
 * reply rather than retrying.
 */
export async function insertIntent(
  input: InsertIntentInput,
  sql: SQL = requireDb(),
): Promise<ShipIntentRow> {
  const rows: ShipIntentRow[] = await sql`
    INSERT INTO ship_intents (
      installation_id, owner, repo, pr_number,
      target_base_sha, target_head_sha,
      status, deadline_at,
      created_by_user, tracking_comment_marker
    )
    VALUES (
      ${input.installation_id}, ${input.owner}, ${input.repo}, ${input.pr_number},
      ${input.target_base_sha}, ${input.target_head_sha},
      'active', ${input.deadline_at},
      ${input.created_by_user}, ${input.tracking_comment_marker}
    )
    RETURNING *
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new Error("insertIntent: INSERT ... RETURNING produced no rows");
  }
  return row;
}

/**
 * Return the single in-flight intent (status `'active'` OR `'paused'`)
 * for the given PR, or `null` if none exists. The partial unique index
 * `ship_intents_one_active_per_pr` guarantees at most one row.
 */
export async function findActiveIntent(
  owner: string,
  repo: string,
  pr_number: number,
  sql: SQL = requireDb(),
): Promise<ShipIntentRow | null> {
  const rows: ShipIntentRow[] = await sql`
    SELECT * FROM ship_intents
    WHERE owner = ${owner}
      AND repo = ${repo}
      AND pr_number = ${pr_number}
      AND status IN ('active', 'paused')
  `;
  return rows[0] ?? null;
}

/**
 * Fetch a single intent by id, or `null` if not found.
 */
export async function getIntentById(
  id: string,
  sql: SQL = requireDb(),
): Promise<ShipIntentRow | null> {
  const rows: ShipIntentRow[] = await sql`
    SELECT * FROM ship_intents WHERE id = ${id}
  `;
  return rows[0] ?? null;
}

/**
 * Move an intent into a terminal state. Sets `terminated_at = now()`,
 * bumps `updated_at`, and writes the optional `terminal_blocker_category`.
 * Returns the updated row, or `null` if the intent did not exist or was
 * already terminal (no row updated).
 */
export async function transitionIntent(
  id: string,
  terminalState: SessionTerminalState,
  blockerCategory: BlockerCategory | null,
  sql: SQL = requireDb(),
): Promise<ShipIntentRow | null> {
  const rows: ShipIntentRow[] = await sql`
    UPDATE ship_intents
       SET status = ${terminalState},
           terminal_blocker_category = ${blockerCategory},
           terminated_at = now(),
           updated_at = now()
     WHERE id = ${id}
       AND status IN ('active', 'paused')
    RETURNING *
  `;
  return rows[0] ?? null;
}

// ─── Iterations ───────────────────────────────────────────────────────────────

export interface AppendIterationInput {
  readonly intent_id: string;
  readonly iteration_n: number;
  readonly kind: ShipIterationKind;
  readonly verdict_json?: unknown;
  readonly non_readiness_reason?: NonReadinessReason | null;
  readonly cost_usd?: number;
  readonly runs_store_id?: string | null;
  readonly finished_at?: Date | null;
}

/**
 * Insert one row into `ship_iterations`. Caller decides `iteration_n`
 * (1-based per intent); the UNIQUE `(intent_id, iteration_n)` constraint
 * surfaces a duplicate as a Postgres error.
 *
 * For `kind === 'probe'`, callers pass `verdict_json` (full GraphQL
 * snapshot per FR-024 / R9) and `non_readiness_reason`. For other kinds
 * the verdict columns must be omitted — the
 * `ship_iterations_verdict_only_on_probe_check` CHECK enforces this.
 */
export async function appendIteration(
  input: AppendIterationInput,
  sql: SQL = requireDb(),
): Promise<ShipIterationRow> {
  const rows: ShipIterationRow[] = await sql`
    INSERT INTO ship_iterations (
      intent_id, iteration_n, kind,
      verdict_json, non_readiness_reason,
      cost_usd, runs_store_id, finished_at
    )
    VALUES (
      ${input.intent_id}, ${input.iteration_n}, ${input.kind},
      ${input.verdict_json ?? null},
      ${input.non_readiness_reason ?? null},
      ${input.cost_usd ?? 0}, ${input.runs_store_id ?? null}, ${input.finished_at ?? null}
    )
    RETURNING *
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new Error("appendIteration: INSERT ... RETURNING produced no rows");
  }
  return row;
}

// ─── Continuations ────────────────────────────────────────────────────────────

export interface UpsertContinuationInput {
  readonly intent_id: string;
  readonly wait_for: ContinuationWaitFor[];
  readonly wake_at: Date;
  readonly state_blob: unknown;
  readonly state_version: number;
}

/**
 * Insert or replace the per-intent continuation row. `ship_continuations`
 * has at most one row per intent (PK on `intent_id`); ON CONFLICT updates
 * everything except the PK and bumps `updated_at`.
 */
export async function upsertContinuation(
  input: UpsertContinuationInput,
  sql: SQL = requireDb(),
): Promise<ShipContinuationRow> {
  const waitForLiteral = pgTextArrayLiteral(input.wait_for);
  const rows: ShipContinuationRow[] = await sql`
    INSERT INTO ship_continuations (
      intent_id, wait_for, wake_at, state_blob, state_version, updated_at
    )
    VALUES (
      ${input.intent_id}, ${waitForLiteral}::text[], ${input.wake_at},
      ${input.state_blob}, ${input.state_version}, now()
    )
    ON CONFLICT (intent_id) DO UPDATE SET
      wait_for = EXCLUDED.wait_for,
      wake_at = EXCLUDED.wake_at,
      state_blob = EXCLUDED.state_blob,
      state_version = EXCLUDED.state_version,
      updated_at = now()
    RETURNING *
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new Error("upsertContinuation: INSERT ... RETURNING produced no rows");
  }
  return row;
}

/**
 * Return continuations whose `wake_at <= ${now}`. The query joins
 * `ship_intents` purely as a filter (so terminated intents whose
 * continuation rows linger never appear) — the SELECT projects only
 * `c.*`, so callers needing the installation/owner/repo/pr_number tuple
 * must look it up separately via `getActiveIntent` / `findIntentsForPr`.
 */
export async function findDueContinuations(
  now: Date,
  sql: SQL = requireDb(),
): Promise<ShipContinuationRow[]> {
  const rows: ShipContinuationRow[] = await sql`
    SELECT c.*
    FROM ship_continuations c
    JOIN ship_intents i ON i.id = c.intent_id
    WHERE c.wake_at <= ${now}
      AND i.status IN ('active', 'paused')
    ORDER BY c.wake_at ASC
  `;
  return rows;
}

/**
 * Delete the continuation row for an intent. Idempotent — returns the
 * number of rows deleted (0 or 1).
 */
export async function deleteContinuation(
  intent_id: string,
  sql: SQL = requireDb(),
): Promise<number> {
  const rows: { id: string }[] = await sql`
    DELETE FROM ship_continuations
    WHERE intent_id = ${intent_id}
    RETURNING intent_id AS id
  `;
  return rows.length;
}

// ─── Fix-attempts ledger ──────────────────────────────────────────────────────

/**
 * Increment the per-(intent, signature) attempt counter, inserting a new
 * row at `attempts = 1` on first observation. The PK is `(intent_id,
 * signature)`, so ON CONFLICT atomically bumps the existing row's count
 * and `last_seen_at`.
 *
 * Returns the post-increment row so callers (e.g. FR-013 cap check) can
 * read `attempts` without a follow-up query.
 */
export async function incrementFixAttempt(
  intent_id: string,
  signature: string,
  tier: 1 | 2,
  sql: SQL = requireDb(),
): Promise<ShipFixAttemptRow> {
  const rows: ShipFixAttemptRow[] = await sql`
    INSERT INTO ship_fix_attempts (intent_id, signature, tier, attempts)
    VALUES (${intent_id}, ${signature}, ${tier}, 1)
    ON CONFLICT (intent_id, signature) DO UPDATE SET
      attempts = ship_fix_attempts.attempts + 1,
      last_seen_at = now()
    RETURNING *
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new Error("incrementFixAttempt: INSERT ... RETURNING produced no rows");
  }
  return row;
}

/**
 * Read the current attempt counter for a (intent, signature). Returns
 * `null` when no attempt has been recorded yet — distinct from `0`.
 */
export async function getFixAttempt(
  intent_id: string,
  signature: string,
  sql: SQL = requireDb(),
): Promise<ShipFixAttemptRow | null> {
  const rows: ShipFixAttemptRow[] = await sql`
    SELECT * FROM ship_fix_attempts
    WHERE intent_id = ${intent_id} AND signature = ${signature}
  `;
  return rows[0] ?? null;
}
