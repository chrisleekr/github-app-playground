import type { SQL } from "bun";

import { config } from "../config";
import { getDb } from "../db";
import { logger } from "../logger";
import type { SerializableBotContext } from "../shared/daemon-types";

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
  contextJson?: SerializableBotContext;
}

/**
 * Create an execution record when a webhook arrives.
 * Returns the generated UUID.
 */
export async function createExecution(params: CreateExecutionParams): Promise<string> {
  const db = getDb();
  if (db === null) throw new Error("Database not configured");

  const rows: { id: string }[] = await db`
    INSERT INTO executions (
      delivery_id, repo_owner, repo_name, entity_number, entity_type,
      event_name, trigger_username, dispatch_mode, status, context_json
    ) VALUES (
      ${params.deliveryId}, ${params.repoOwner}, ${params.repoName},
      ${params.entityNumber}, ${params.entityType}, ${params.eventName},
      ${params.triggerUsername}, ${params.dispatchMode}, 'queued',
      ${params.contextJson !== undefined ? params.contextJson : null}
    )
    RETURNING id
  `;
  return rows[0]!.id;
}

/**
 * Update execution status to 'offered' with the assigned daemon ID.
 */
export async function markExecutionOffered(
  deliveryId: string,
  daemonId: string,
): Promise<void> {
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
export async function markExecutionFailed(
  deliveryId: string,
  errorMessage: string,
): Promise<void> {
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
  if (rows.length === 0) return null;
  return {
    status: rows[0]!.status,
    daemonId: rows[0]!.daemon_id,
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

  const staleRows: { id: string; delivery_id: string; daemon_id: string | null; status: string }[] = await db`
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
    logger.warn({ deliveryId: row.delivery_id, daemonId: row.daemon_id, previousStatus: row.status }, "Recovered stale execution on startup");
  }

  logger.warn({ count: staleRows.length }, "Recovered stale executions on startup");
}
