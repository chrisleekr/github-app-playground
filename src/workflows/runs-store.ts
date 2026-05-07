import type { SQL } from "bun";

import { requireDb } from "../db";
import type { TriggerEventType } from "../shared/dispatch-types";
import type { WorkflowName } from "./registry";

/**
 * Persistence layer for the `workflow_runs` table. All writes preserve prior
 * fields in `state` via `state || $new::jsonb` so workflow-specific fields
 * (`verdict`, `pr_number`, `currentStepIndex`, …) accumulate across updates.
 */

export type WorkflowRunStatus = "queued" | "running" | "succeeded" | "failed" | "incomplete";

export type WorkflowOwnerKind = "orchestrator" | "daemon";

export interface WorkflowRunRow {
  id: string;
  workflow_name: WorkflowName;
  target_type: "issue" | "pr";
  target_owner: string;
  target_repo: string;
  target_number: number;
  parent_run_id: string | null;
  parent_step_index: number | null;
  status: WorkflowRunStatus;
  state: Record<string, unknown>;
  tracking_comment_id: number | null;
  delivery_id: string | null;
  owner_kind: WorkflowOwnerKind | null;
  owner_id: string | null;
  trigger_comment_id: number | null;
  trigger_event_type: TriggerEventType | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Bun's Postgres driver returns BIGINT columns as strings to preserve
 * precision. GitHub issue-comment IDs fit comfortably inside JS's safe integer
 * range, so we coerce to `number` here rather than leaking the driver detail
 * up through the rest of the codebase.
 */
function normalizeRow(row: WorkflowRunRow): WorkflowRunRow {
  const tracking_comment_id = coerceBigintId(row.tracking_comment_id as unknown);
  const trigger_comment_id = coerceBigintId(row.trigger_comment_id as unknown);
  return { ...row, tracking_comment_id, trigger_comment_id };
}

function coerceBigintId(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") return Number(raw);
  return raw as number;
}

export interface InsertQueuedParams {
  workflowName: WorkflowName;
  target: {
    type: "issue" | "pr";
    owner: string;
    repo: string;
    number: number;
  };
  parentRunId?: string | null;
  parentStepIndex?: number | null;
  deliveryId?: string | null;
  initialState?: Record<string, unknown>;
  /**
   * Identifier of the process responsible for advancing this row. The
   * liveness reaper resolves the matching Valkey heartbeat key from
   * `(ownerKind, ownerId)` and fails the row if the key is missing.
   */
  ownerKind: WorkflowOwnerKind;
  ownerId: string;
  /**
   * REST id of the user comment that triggered this run. NULL for
   * label-triggered or system-spawned runs (no comment to react on).
   */
  triggerCommentId?: number | null;
  triggerEventType?: TriggerEventType | null;
}

/**
 * Insert a new `queued` row. Throws if the partial unique index rejects the
 * insert (another in-flight run for the same (workflow, target) exists).
 */
export async function insertQueued(
  params: InsertQueuedParams,
  sql: SQL = requireDb(),
): Promise<WorkflowRunRow> {
  const parentRunId = params.parentRunId ?? null;
  const parentStepIndex = params.parentStepIndex ?? null;
  const deliveryId = params.deliveryId ?? null;
  const state = params.initialState ?? {};
  const triggerCommentId = params.triggerCommentId ?? null;
  const triggerEventType = params.triggerEventType ?? null;

  const rows: WorkflowRunRow[] = await sql`
    INSERT INTO workflow_runs (
      workflow_name, target_type, target_owner, target_repo, target_number,
      parent_run_id, parent_step_index, status, state, delivery_id,
      owner_kind, owner_id, trigger_comment_id, trigger_event_type
    ) VALUES (
      ${params.workflowName}, ${params.target.type}, ${params.target.owner},
      ${params.target.repo}, ${params.target.number},
      ${parentRunId}, ${parentStepIndex}, 'queued', ${state}::jsonb, ${deliveryId},
      ${params.ownerKind}, ${params.ownerId}, ${triggerCommentId}, ${triggerEventType}
    )
    RETURNING *
  `;

  const row = rows[0];
  if (row === undefined) {
    throw new Error("insertQueued returned no row");
  }
  return normalizeRow(row);
}

/**
 * Flip a row to `running` and transfer ownership to the executing daemon so
 * the liveness reaper tracks the daemon's heartbeat (not the orchestrator's)
 * for the duration of the run. No-op if the row is already past `queued`.
 */
export async function markRunning(
  runId: string,
  daemonId: string,
  sql: SQL = requireDb(),
): Promise<void> {
  await sql`
    UPDATE workflow_runs
       SET status = 'running',
           owner_kind = 'daemon',
           owner_id = ${daemonId}
     WHERE id = ${runId}
       AND status = 'queued'
  `;
}

/**
 * Terminal success write. `state` is merged with the existing row's state
 * (RHS wins on collision) via Postgres JSONB concat operator.
 */
export async function markSucceeded(
  runId: string,
  state: Record<string, unknown>,
  sql: SQL = requireDb(),
): Promise<void> {
  await sql`
    UPDATE workflow_runs
       SET status = 'succeeded',
           state = state || ${state}::jsonb
     WHERE id = ${runId}
  `;
}

/**
 * Terminal failure write. Merges `{ reason, ...state }` into state.
 */
export async function markFailed(
  runId: string,
  reason: string,
  state: Record<string, unknown> = {},
  sql: SQL = requireDb(),
): Promise<void> {
  const merged = { ...state, failedReason: reason };
  await sql`
    UPDATE workflow_runs
       SET status = 'failed',
           state = state || ${merged}::jsonb
     WHERE id = ${runId}
  `;
}

/**
 * Terminal "agent ran cleanly but work remains" write (issue #93). Mirrors
 * `markFailed` but flips status to `'incomplete'` and records the reason
 * under `state.incompleteReason` (separate from `failedReason` so operator
 * tooling can tell a clean-run-but-blocked outcome from a true pipeline error).
 */
export async function markIncomplete(
  runId: string,
  reason: string,
  state: Record<string, unknown> = {},
  sql: SQL = requireDb(),
): Promise<void> {
  const merged = { ...state, incompleteReason: reason };
  await sql`
    UPDATE workflow_runs
       SET status = 'incomplete',
           state = state || ${merged}::jsonb
     WHERE id = ${runId}
  `;
}

/**
 * Merge arbitrary fields into `state` without changing status. Used by
 * handlers to persist progress mid-run (e.g. the tracking-comment mirror).
 */
export async function mergeState(
  runId: string,
  patch: Record<string, unknown>,
  sql: SQL = requireDb(),
): Promise<void> {
  await sql`
    UPDATE workflow_runs
       SET state = state || ${patch}::jsonb
     WHERE id = ${runId}
  `;
}

/**
 * Record the GitHub comment id for the run's tracking comment. Called once,
 * after the comment is first created on GitHub.
 */
export async function setTrackingCommentId(
  runId: string,
  commentId: number,
  sql: SQL = requireDb(),
): Promise<void> {
  await sql`
    UPDATE workflow_runs
       SET tracking_comment_id = ${commentId}
     WHERE id = ${runId}
  `;
}

/**
 * Compare-and-set variant of {@link setTrackingCommentId}. Only writes the
 * row when `tracking_comment_id IS NULL`, so two racing creators cannot both
 * stamp their own comment ids. Returns the winning comment id — our `commentId`
 * if we won, or the pre-existing value if another worker got there first.
 */
export async function tryReserveTrackingCommentId(
  runId: string,
  commentId: number,
  sql: SQL = requireDb(),
): Promise<{ won: boolean; trackingCommentId: number }> {
  const rows: { tracking_comment_id: number | string }[] = await sql`
    UPDATE workflow_runs
       SET tracking_comment_id = ${commentId}
     WHERE id = ${runId}
       AND tracking_comment_id IS NULL
    RETURNING tracking_comment_id
  `;
  if (rows[0] !== undefined) {
    return { won: true, trackingCommentId: coerceCommentId(rows[0].tracking_comment_id) };
  }
  const existing: { tracking_comment_id: number | string | null }[] = await sql`
    SELECT tracking_comment_id FROM workflow_runs WHERE id = ${runId}
  `;
  const rawExisting = existing[0]?.tracking_comment_id ?? null;
  if (rawExisting === null) {
    throw new Error(
      `tryReserveTrackingCommentId: run ${runId} has no tracking_comment_id and CAS did not update`,
    );
  }
  return { won: false, trackingCommentId: coerceCommentId(rawExisting) };
}

/**
 * Bun's Postgres driver returns BIGINT as a string to avoid precision loss.
 * GitHub comment ids fit inside JS's safe integer range, so we coerce to
 * `number` here. Mirrors the treatment in `normalizeRow`.
 */
function coerceCommentId(raw: number | string): number {
  return typeof raw === "string" ? Number(raw) : raw;
}

export async function findById(
  runId: string,
  sql: SQL = requireDb(),
): Promise<WorkflowRunRow | null> {
  const rows: WorkflowRunRow[] = await sql`
    SELECT * FROM workflow_runs WHERE id = ${runId}
  `;
  const row = rows[0];
  return row === undefined ? null : normalizeRow(row);
}

/**
 * Return the in-flight row for (workflow, target) if one exists. The partial
 * unique index guarantees at most one.
 */
export async function findInflight(
  workflowName: WorkflowName,
  target: { owner: string; repo: string; number: number },
  sql: SQL = requireDb(),
): Promise<WorkflowRunRow | null> {
  const rows: WorkflowRunRow[] = await sql`
    SELECT * FROM workflow_runs
     WHERE workflow_name = ${workflowName}
       AND target_owner = ${target.owner}
       AND target_repo = ${target.repo}
       AND target_number = ${target.number}
       AND status IN ('queued', 'running')
     LIMIT 1
  `;
  const row = rows[0];
  return row === undefined ? null : normalizeRow(row);
}

/**
 * Return the most-recent row for (workflow, target) regardless of status.
 * Used by the prior-output check (FR-004) and the `ship` resume path.
 */
export async function findLatestForTarget(
  workflowName: WorkflowName,
  target: { owner: string; repo: string; number: number },
  sql: SQL = requireDb(),
): Promise<WorkflowRunRow | null> {
  const rows: WorkflowRunRow[] = await sql`
    SELECT * FROM workflow_runs
     WHERE workflow_name = ${workflowName}
       AND target_owner = ${target.owner}
       AND target_repo = ${target.repo}
       AND target_number = ${target.number}
     ORDER BY created_at DESC
     LIMIT 1
  `;
  const row = rows[0];
  return row === undefined ? null : normalizeRow(row);
}

/**
 * Return the most-recent `succeeded` row for (workflow, target). Used by the
 * prior-output check (FR-004) — a later `failed` row must not block a dispatch
 * that has a valid prior success earlier in history.
 */
export async function findLatestSucceededForTarget(
  workflowName: WorkflowName,
  target: { owner: string; repo: string; number: number },
  sql: SQL = requireDb(),
): Promise<WorkflowRunRow | null> {
  const rows: WorkflowRunRow[] = await sql`
    SELECT * FROM workflow_runs
     WHERE workflow_name = ${workflowName}
       AND target_owner = ${target.owner}
       AND target_repo = ${target.repo}
       AND target_number = ${target.number}
       AND status = 'succeeded'
     ORDER BY created_at DESC
     LIMIT 1
  `;
  const row = rows[0];
  return row === undefined ? null : normalizeRow(row);
}

/**
 * In-flight rows owned by a specific (kind, id) — used by the disconnect
 * cleanup path to find workflow_runs that need a user-facing failure
 * notification when their owning daemon dies abruptly.
 */
export async function findInflightByOwner(
  ownerKind: WorkflowOwnerKind,
  ownerId: string,
  sql: SQL = requireDb(),
): Promise<WorkflowRunRow[]> {
  const rows = (await sql`
    SELECT * FROM workflow_runs
     WHERE owner_kind = ${ownerKind}
       AND owner_id = ${ownerId}
       AND status IN ('queued', 'running')
  `) as unknown as WorkflowRunRow[];
  return rows.map(normalizeRow);
}

/**
 * Children of a composite parent, ordered by step index. Used by the
 * orchestrator to compute the next step.
 */
export async function listChildrenByParent(
  parentRunId: string,
  sql: SQL = requireDb(),
): Promise<WorkflowRunRow[]> {
  const rows = (await sql`
    SELECT * FROM workflow_runs
     WHERE parent_run_id = ${parentRunId}
     ORDER BY parent_step_index ASC
  `) as unknown as WorkflowRunRow[];
  return rows.map(normalizeRow);
}
