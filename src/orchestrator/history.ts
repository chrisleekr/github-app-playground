import type { SQL } from "bun";

import { config } from "../config";
import { getDb } from "../db";
import { logger } from "../logger";
import type { SerializableBotContext } from "../shared/daemon-types";
import { decrementDaemonActiveJobs } from "./daemon-registry";

/**
 * Execution status transitions:
 *   queued -> offered -> running -> completed | failed
 *   offered -> queued (rejection/timeout, re-queue)
 *   queued -> failed (no daemons after retries)
 */
export type ExecutionStatus = "queued" | "offered" | "running" | "completed" | "failed";

export interface CreateExecutionParams {
  deliveryId: string;
  repoOwner: string;
  repoName: string;
  entityNumber: number;
  entityType: string;
  eventName: string;
  triggerUsername: string;
  dispatchMode: string;
  /**
   * Optional dispatch-decision reason. When omitted the DB DEFAULT
   * ('static-default') applies. Callers on rejection / classifier paths pass
   * the actual DispatchReason (e.g. "infra-absent", "label", "keyword") so
   * analytics can distinguish them from the default fallback.
   */
  dispatchReason?: string;
  /**
   * Triage denorm fields per data-model.md §4. Populated only when
   * `dispatchReason === "triage"` (or "default-fallback" when triage parsed
   * but was sub-threshold). Enables FR-014 aggregate queries to read
   * confidence/cost without joining to `triage_results`.
   */
  triageConfidence?: number;
  triageCostUsd?: number;
  triageComplexity?: "trivial" | "moderate" | "complex";
  contextJson?: SerializableBotContext;
}

/**
 * Create an execution record when a webhook arrives.
 * Returns the generated UUID.
 */
export async function createExecution(params: CreateExecutionParams): Promise<string> {
  const db = getDb();
  if (db === null) throw new Error("Database not configured");

  const hasDispatchReason = params.dispatchReason !== undefined;
  const hasTriageFields =
    params.triageConfidence !== undefined ||
    params.triageCostUsd !== undefined ||
    params.triageComplexity !== undefined;

  // Guard: triage denorm columns must only accompany an explicit reason.
  // Without this, callers could accidentally persist triage_* columns
  // alongside the DB-default `static-default` reason — which would mislead
  // FR-014 aggregates into attributing triage telemetry to non-triage rows.
  if (hasTriageFields && !hasDispatchReason) {
    throw new Error("createExecution: dispatchReason is required when triage fields are provided");
  }

  // Migration 003 denormalizes dispatch onto `executions` with
  // `dispatch_target` as the canonical column for new rows; `dispatch_mode`
  // stays populated for backward compat (the migration note calls for a
  // future consolidation). Callers pass the resolved DispatchTarget via
  // `dispatchMode` — we write it to both columns.
  let rows: { id: string }[];
  if (hasTriageFields) {
    rows = await db`
      INSERT INTO executions (
        delivery_id, repo_owner, repo_name, entity_number, entity_type,
        event_name, trigger_username, dispatch_mode, dispatch_target, dispatch_reason,
        triage_confidence, triage_cost_usd, triage_complexity,
        status, context_json
      ) VALUES (
        ${params.deliveryId}, ${params.repoOwner}, ${params.repoName},
        ${params.entityNumber}, ${params.entityType}, ${params.eventName},
        ${params.triggerUsername}, ${params.dispatchMode}, ${params.dispatchMode},
        ${params.dispatchReason ?? "static-default"},
        ${params.triageConfidence ?? null}, ${params.triageCostUsd ?? null},
        ${params.triageComplexity ?? null},
        'queued', ${params.contextJson ?? null}
      )
      RETURNING id
    `;
  } else if (hasDispatchReason) {
    rows = await db`
      INSERT INTO executions (
        delivery_id, repo_owner, repo_name, entity_number, entity_type,
        event_name, trigger_username, dispatch_mode, dispatch_target, dispatch_reason,
        status, context_json
      ) VALUES (
        ${params.deliveryId}, ${params.repoOwner}, ${params.repoName},
        ${params.entityNumber}, ${params.entityType}, ${params.eventName},
        ${params.triggerUsername}, ${params.dispatchMode}, ${params.dispatchMode}, ${params.dispatchReason},
        'queued', ${params.contextJson ?? null}
      )
      RETURNING id
    `;
  } else {
    rows = await db`
      INSERT INTO executions (
        delivery_id, repo_owner, repo_name, entity_number, entity_type,
        event_name, trigger_username, dispatch_mode, dispatch_target, status, context_json
      ) VALUES (
        ${params.deliveryId}, ${params.repoOwner}, ${params.repoName},
        ${params.entityNumber}, ${params.entityType}, ${params.eventName},
        ${params.triggerUsername}, ${params.dispatchMode}, ${params.dispatchMode}, 'queued',
        ${params.contextJson ?? null}
      )
      RETURNING id
    `;
  }
  const row = rows[0];
  if (row === undefined) throw new Error("INSERT RETURNING yielded no row");
  return row.id;
}

/**
 * Update execution status to 'offered' with the assigned daemon ID.
 */
export async function markExecutionOffered(deliveryId: string, daemonId: string): Promise<void> {
  const db = getDb();
  if (db === null) return;

  await db`
    UPDATE executions
    SET status = 'offered', daemon_id = ${daemonId}
    WHERE delivery_id = ${deliveryId} AND status = 'queued'
  `;
}

/**
 * Update execution status to 'running' and record start time.
 */
export async function markExecutionRunning(deliveryId: string): Promise<void> {
  const db = getDb();
  if (db === null) return;

  await db`
    UPDATE executions
    SET status = 'running', started_at = now()
    WHERE delivery_id = ${deliveryId} AND status = 'offered'
  `;
}

/**
 * Update execution status to 'completed' with result metrics.
 */
export async function markExecutionCompleted(
  deliveryId: string,
  result: { costUsd?: number; durationMs?: number; numTurns?: number },
): Promise<void> {
  const db = getDb();
  if (db === null) return;

  await db`
    UPDATE executions
    SET status = 'completed', completed_at = now(),
        cost_usd = ${result.costUsd ?? null},
        duration_ms = ${result.durationMs ?? null},
        num_turns = ${result.numTurns ?? null}
    WHERE delivery_id = ${deliveryId} AND status = 'running'
  `;
}

/**
 * Update execution status to 'failed' with an error message.
 */
export async function markExecutionFailed(deliveryId: string, errorMessage: string): Promise<void> {
  const db = getDb();
  if (db === null) return;

  await db`
    UPDATE executions
    SET status = 'failed', completed_at = now(), error_message = ${errorMessage}
    WHERE delivery_id = ${deliveryId} AND status IN ('queued', 'offered', 'running')
  `;
}

/**
 * Re-queue an execution (offered -> queued) after rejection or timeout.
 */
export async function requeueExecution(deliveryId: string): Promise<void> {
  const db = getDb();
  if (db === null) return;

  await db`
    UPDATE executions
    SET status = 'queued', daemon_id = NULL
    WHERE delivery_id = ${deliveryId} AND status = 'offered'
  `;
}

/**
 * Get execution status and daemon_id for FM-6 late result guard.
 */
export async function getExecutionState(
  deliveryId: string,
): Promise<{ status: string; daemonId: string | null } | null> {
  const db = getDb();
  if (db === null) return null;

  const rows: { status: string; daemon_id: string | null }[] = await db`
    SELECT status, daemon_id FROM executions WHERE delivery_id = ${deliveryId}
  `;
  const row = rows[0];
  if (row === undefined) return null;
  return {
    status: row.status,
    daemonId: row.daemon_id,
  };
}

/**
 * Get orphaned executions for a daemon (FM-1 cleanup).
 * Returns delivery IDs of executions stuck in 'offered' or 'running' state.
 */
export async function getOrphanedExecutions(
  daemonId: string,
): Promise<{ deliveryId: string; status: string }[]> {
  const db = getDb();
  if (db === null) return [];

  const rows: { delivery_id: string; status: string }[] = await db`
    SELECT delivery_id, status FROM executions
    WHERE daemon_id = ${daemonId} AND status IN ('offered', 'running')
  `;
  return rows.map((r) => ({
    deliveryId: r.delivery_id,
    status: r.status,
  }));
}

/**
 * Startup recovery: scan for stale executions and mark them failed (FM-4).
 * Runs after db.migrate() but before startWebSocketServer().
 *
 * Two query conditions handle NULL started_at for 'offered' records:
 * - running: started_at < threshold
 * - offered: created_at < threshold (started_at is NULL)
 */
export async function recoverStaleExecutions(db: SQL): Promise<void> {
  const thresholdMs = config.staleExecutionThresholdMs;

  const staleRows: { id: string; delivery_id: string; daemon_id: string | null; status: string }[] =
    await db`
    SELECT id, delivery_id, daemon_id, status
    FROM executions
    WHERE (status = 'running' AND started_at < now() - make_interval(secs => ${thresholdMs / 1000}))
       OR (status = 'offered' AND created_at < now() - make_interval(secs => ${thresholdMs / 1000}))
  `;

  if (staleRows.length === 0) return;

  for (const row of staleRows) {
    // eslint-disable-next-line no-await-in-loop
    await db`
      UPDATE executions
      SET status = 'failed', error_message = 'server restarted — execution state unknown', completed_at = now()
      WHERE id = ${row.id} AND status IN ('offered', 'running')
    `;

    // Decrement the daemon's Valkey active_jobs counter if it still exists (M11)
    if (row.daemon_id !== null) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await decrementDaemonActiveJobs(row.daemon_id);
      } catch (err) {
        logger.debug(
          { err, daemonId: row.daemon_id },
          "Failed to decrement active_jobs for stale execution (daemon may be deregistered)",
        );
      }
    }

    logger.warn(
      { deliveryId: row.delivery_id, daemonId: row.daemon_id, previousStatus: row.status },
      "Recovered stale execution on startup",
    );
  }

  logger.warn({ count: staleRows.length }, "Recovered stale executions on startup");
}
