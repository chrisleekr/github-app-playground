import type { SQL } from "bun";

import { config } from "../config";
import { requireDb } from "../db";
import { logger } from "../logger";
import { requireValkeyClient } from "./valkey";

const SCAN_BATCH = 100;
const ORCH_KEY_PREFIX = "orchestrator:";
const ORCH_KEY_SUFFIX = ":alive";

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Heartbeat-based reaper for `workflow_runs` and the `daemons` table.
 *
 * Every in-flight `workflow_runs` row carries `(owner_kind, owner_id)`
 * pointing at the process responsible for advancing it. Liveness is read
 * from Valkey:
 *
 *   - `orchestrator` owners → key `orchestrator:{owner_id}:alive`
 *     (published by `instance-liveness.ts`, 60s TTL, refreshed every 20s)
 *   - `daemon` owners       → key `daemon:{owner_id}`
 *     (published by `daemon-registry.ts`, 90s TTL, refreshed on pong)
 *
 * If the heartbeat key is missing the owner is treated as dead and the row
 * is flipped to `'failed'` with a reaped-by reason in `state`. Pre-existing
 * rows with NULL ownership (migrated from before column 006) are left
 * alone.
 *
 * Idempotent + race-safe: each pass is a single SQL `UPDATE` per owner kind,
 * so multiple orchestrators running concurrently just see zero affected
 * rows after the first winner.
 */

async function listLiveOrchestratorIds(): Promise<string[]> {
  const valkey = requireValkeyClient();
  const ids: string[] = [];
  let cursor = "0";
  do {
    // eslint-disable-next-line no-await-in-loop, @typescript-eslint/no-unsafe-assignment -- Valkey SCAN returns [string, string[]]
    const result: [string, string[]] = await valkey.send("SCAN", [
      cursor,
      "MATCH",
      `${ORCH_KEY_PREFIX}*${ORCH_KEY_SUFFIX}`,
      "COUNT",
      String(SCAN_BATCH),
    ]);
    cursor = result[0];
    for (const key of result[1]) {
      if (!key.startsWith(ORCH_KEY_PREFIX) || !key.endsWith(ORCH_KEY_SUFFIX)) continue;
      const id = key.slice(ORCH_KEY_PREFIX.length, key.length - ORCH_KEY_SUFFIX.length);
      if (id !== "") ids.push(id);
    }
  } while (cursor !== "0");
  return ids;
}

async function listLiveDaemonIds(): Promise<string[]> {
  const valkey = requireValkeyClient();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Valkey SMEMBERS returns string[]
  const members: string[] = await valkey.send("SMEMBERS", ["active_daemons"]);
  const live: string[] = [];
  for (const id of members) {
    // eslint-disable-next-line no-await-in-loop, @typescript-eslint/no-unsafe-assignment -- Valkey EXISTS returns number
    const exists: number = await valkey.send("EXISTS", [`daemon:${id}`]);
    if (exists === 1) live.push(id);
  }
  return live;
}

interface ReapedRow {
  readonly id: string;
  readonly workflow_name: string;
  readonly owner_kind: "orchestrator" | "daemon";
  readonly owner_id: string;
}

export interface ReapResult {
  readonly workflowRunsReaped: ReapedRow[];
  readonly daemonsMarkedInactive: number;
}

/**
 * Run one reaper pass. Exported for tests and for one-shot invocations
 * (e.g. on startup, before the periodic timer kicks in).
 */
export async function reapOnce(sql: SQL = requireDb()): Promise<ReapResult> {
  const [orchIds, daemonIds] = await Promise.all([listLiveOrchestratorIds(), listLiveDaemonIds()]);

  const reapedOrch: ReapedRow[] =
    orchIds.length === 0
      ? await sql`
          UPDATE workflow_runs
             SET status = 'failed',
                 state = state || jsonb_build_object(
                   'failedReason', 'owner orchestrator:' || owner_id || ' is no longer alive',
                   'reapedAt', now()
                 )
           WHERE status IN ('queued', 'running')
             AND owner_kind = 'orchestrator'
          RETURNING id, workflow_name, owner_kind, owner_id
        `
      : await sql`
          UPDATE workflow_runs
             SET status = 'failed',
                 state = state || jsonb_build_object(
                   'failedReason', 'owner orchestrator:' || owner_id || ' is no longer alive',
                   'reapedAt', now()
                 )
           WHERE status IN ('queued', 'running')
             AND owner_kind = 'orchestrator'
             AND owner_id NOT IN ${sql(orchIds)}
          RETURNING id, workflow_name, owner_kind, owner_id
        `;

  const reapedDaemon: ReapedRow[] =
    daemonIds.length === 0
      ? await sql`
          UPDATE workflow_runs
             SET status = 'failed',
                 state = state || jsonb_build_object(
                   'failedReason', 'owner daemon:' || owner_id || ' is no longer alive',
                   'reapedAt', now()
                 )
           WHERE status IN ('queued', 'running')
             AND owner_kind = 'daemon'
          RETURNING id, workflow_name, owner_kind, owner_id
        `
      : await sql`
          UPDATE workflow_runs
             SET status = 'failed',
                 state = state || jsonb_build_object(
                   'failedReason', 'owner daemon:' || owner_id || ' is no longer alive',
                   'reapedAt', now()
                 )
           WHERE status IN ('queued', 'running')
             AND owner_kind = 'daemon'
             AND owner_id NOT IN ${sql(daemonIds)}
          RETURNING id, workflow_name, owner_kind, owner_id
        `;

  // Daemons-table sweep: any daemons row still 'active' whose Valkey
  // heartbeat is missing flips to 'inactive'. Replaces the prior
  // time-threshold `reapStaleDaemons` (5-minute blind window).
  const daemonRowsReaped: { id: string }[] =
    daemonIds.length === 0
      ? await sql`
          UPDATE daemons
             SET status = 'inactive'
           WHERE status = 'active'
          RETURNING id
        `
      : await sql`
          UPDATE daemons
             SET status = 'inactive'
           WHERE status = 'active'
             AND id NOT IN ${sql(daemonIds)}
          RETURNING id
        `;

  const workflowRunsReaped = [...reapedOrch, ...reapedDaemon];
  if (workflowRunsReaped.length > 0 || daemonRowsReaped.length > 0) {
    logger.info(
      {
        workflowRunsReaped: workflowRunsReaped.length,
        daemonsMarkedInactive: daemonRowsReaped.length,
        liveOrchestratorCount: orchIds.length,
        liveDaemonCount: daemonIds.length,
        reapedRunIds: workflowRunsReaped.map((r) => r.id),
      },
      "Liveness reaper flipped abandoned rows",
    );
  } else {
    logger.debug(
      {
        liveOrchestratorCount: orchIds.length,
        liveDaemonCount: daemonIds.length,
      },
      "Liveness reaper pass, nothing to reap",
    );
  }

  return { workflowRunsReaped, daemonsMarkedInactive: daemonRowsReaped.length };
}

/**
 * Start the periodic reaper. Idempotent: calling twice does nothing.
 *
 * Cadence comes from `config.livenessReaperIntervalMs`. Min sane value is
 * the orchestrator heartbeat refresh interval (20s); below that, a
 * heartbeat momentarily not yet republished could trigger a false reap.
 */
export function startLivenessReaper(): void {
  if (timer !== null) return;
  const intervalMs = config.livenessReaperIntervalMs;
  timer = setInterval(() => {
    void reapOnce().catch((err: unknown) => {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "Liveness reaper pass threw, will retry on next tick",
      );
    });
  }, intervalMs);
  logger.info({ intervalMs }, "Liveness reaper started");
}

/** Stop the periodic reaper. Safe to call before start (no-op). */
export function stopLivenessReaper(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
  logger.info("Liveness reaper stopped");
}
