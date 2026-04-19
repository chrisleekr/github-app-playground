import { getDb } from "../db";
import { logger } from "../logger";
import {
  type DaemonCapabilities,
  daemonCapabilitiesSchema,
  type DaemonInfo,
} from "../shared/daemon-types";
import type { DaemonRegisterMessage } from "../shared/ws-messages";
import { requireValkeyClient } from "./valkey";

const DAEMON_TTL_SECONDS = 90;

/**
 * Register or re-register a daemon in both Valkey (ephemeral liveness)
 * and Postgres (durable record).
 *
 * Valkey: SETEX daemon:{id} with 90s TTL, SET daemon:{id}:active_jobs to 0.
 * Postgres: Upsert daemons table with capabilities and resources.
 *
 * Per data-model.md: capabilities.resources is extracted to the `resources`
 * column; the rest goes to `capabilities`.
 */
export async function registerDaemon(msg: DaemonRegisterMessage): Promise<DaemonInfo> {
  const { daemonId, hostname, platform, osVersion, capabilities, protocolVersion, appVersion } =
    msg.payload;

  const valkey = requireValkeyClient();

  // Valkey: store daemon liveness with TTL + add to active set for O(1) lookup
  const valkeyPayload = JSON.stringify(capabilities);
  await valkey.send("SETEX", [`daemon:${daemonId}`, String(DAEMON_TTL_SECONDS), valkeyPayload]);
  await valkey.send("SET", [`daemon:${daemonId}:active_jobs`, "0"]);
  await valkey.send("SADD", ["active_daemons", daemonId]);

  // Postgres upsert — resources column separated per data-model.md
  const db = getDb();
  if (db !== null) {
    const { resources, ...capabilitiesWithoutResources } = capabilities;
    // Pass objects directly — Bun.sql handles JSONB serialization (no JSON.stringify).
    await db`
      INSERT INTO daemons (id, hostname, platform, os_version, capabilities, resources, status, first_seen_at, last_seen_at)
      VALUES (
        ${daemonId},
        ${hostname},
        ${platform},
        ${osVersion},
        ${capabilitiesWithoutResources},
        ${resources},
        'active',
        now(),
        now()
      )
      ON CONFLICT (id) DO UPDATE SET
        hostname = EXCLUDED.hostname,
        platform = EXCLUDED.platform,
        os_version = EXCLUDED.os_version,
        capabilities = EXCLUDED.capabilities,
        resources = EXCLUDED.resources,
        status = 'active',
        last_seen_at = now()
    `;
  }

  const now = Date.now();
  return {
    id: daemonId,
    hostname,
    platform,
    osVersion,
    capabilities,
    status: "active",
    protocolVersion,
    appVersion,
    activeJobs: 0,
    lastSeenAt: now,
    firstSeenAt: now,
  };
}

/**
 * Deregister a daemon — remove from Valkey, set Postgres status to inactive.
 */
export async function deregisterDaemon(daemonId: string): Promise<void> {
  const valkey = requireValkeyClient();

  await valkey.send("DEL", [`daemon:${daemonId}`]);
  await valkey.send("DEL", [`daemon:${daemonId}:active_jobs`]);
  await valkey.send("SREM", ["active_daemons", daemonId]);

  const db = getDb();
  if (db !== null) {
    await db`
      UPDATE daemons SET status = 'inactive', last_seen_at = now()
      WHERE id = ${daemonId}
    `;
  }

  logger.info({ daemonId }, "Daemon deregistered");
}

/**
 * Refresh daemon TTL in Valkey after heartbeat pong.
 */
export async function refreshDaemonTtl(
  daemonId: string,
  capabilities: DaemonCapabilities,
): Promise<void> {
  const valkey = requireValkeyClient();
  const valkeyPayload = JSON.stringify(capabilities);
  await valkey.send("SETEX", [`daemon:${daemonId}`, String(DAEMON_TTL_SECONDS), valkeyPayload]);

  const db = getDb();
  if (db !== null) {
    await db`UPDATE daemons SET last_seen_at = now() WHERE id = ${daemonId}`;
  }
}

/**
 * Get all active daemon IDs from Valkey.
 * Uses SMEMBERS on the `active_daemons` set — O(N) in set size, not keyspace.
 * Prunes stale entries whose liveness key has expired (TTL miss without explicit SREM).
 */
export async function getActiveDaemons(): Promise<string[]> {
  const valkey = requireValkeyClient();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Valkey SMEMBERS returns string[]
  const members: string[] = await valkey.send("SMEMBERS", ["active_daemons"]);

  const alive: string[] = [];
  for (const id of members) {
    // eslint-disable-next-line no-await-in-loop, @typescript-eslint/no-unsafe-assignment -- Valkey EXISTS returns number
    const exists: number = await valkey.send("EXISTS", [`daemon:${id}`]);
    if (exists === 1) {
      alive.push(id);
    } else {
      // Stale entry — liveness key expired without explicit deregister. Clean up.
      // eslint-disable-next-line no-await-in-loop
      await valkey.send("SREM", ["active_daemons", id]);
      logger.debug({ daemonId: id }, "Pruned stale daemon from active_daemons set");
    }
  }
  return alive;
}

/**
 * Get the active job count for a daemon from Valkey.
 */
export async function getDaemonActiveJobs(daemonId: string): Promise<number> {
  const valkey = requireValkeyClient();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Valkey GET returns string | null
  const count: string | null = await valkey.send("GET", [`daemon:${daemonId}:active_jobs`]);
  return count !== null ? parseInt(count, 10) : 0;
}

/**
 * Increment the active job count for a daemon in Valkey.
 */
export async function incrementDaemonActiveJobs(daemonId: string): Promise<void> {
  const valkey = requireValkeyClient();
  await valkey.send("INCR", [`daemon:${daemonId}:active_jobs`]);
}

/**
 * Atomically decrement the active job count for a daemon in Valkey.
 * Uses a Lua script for atomic check-and-decrement to prevent TOCTOU races
 * where concurrent handleResult calls could double-decrement past zero.
 */
const DECR_IF_POSITIVE_LUA = `
  local current = tonumber(redis.call('GET', KEYS[1]) or '0')
  if current > 0 then
    return redis.call('DECR', KEYS[1])
  else
    return -1
  end
`;

/**
 * Sum the spare capacity across the persistent daemon pool — i.e.
 * `maxConcurrentJobs - activeJobs` for every active non-ephemeral daemon.
 * Used by the ephemeral-daemon scaler to decide whether an overflow spawn
 * is actually justified.
 *
 * Read path:
 *  - `active_daemons` set enumerates live daemons.
 *  - Per daemon, the capabilities JSON at `daemon:{id}` identifies ephemeral
 *    status + its local concurrency cap.
 *  - `daemon:{id}:active_jobs` carries the current in-flight count.
 *
 * Silently treats parse/read failures as 0 contribution — a mis-shaped
 * Valkey value must not starve the scaler.
 */
export async function getPersistentPoolFreeSlots(): Promise<number> {
  const valkey = requireValkeyClient();
  const ids = await getActiveDaemons();
  let free = 0;
  for (const id of ids) {
    try {
      // eslint-disable-next-line no-await-in-loop, @typescript-eslint/no-unsafe-assignment -- Valkey GET returns string | null
      const capsRaw: string | null = await valkey.send("GET", [`daemon:${id}`]);
      if (capsRaw === null) continue;
      const parsed = daemonCapabilitiesSchema.safeParse(JSON.parse(capsRaw));
      if (!parsed.success) continue;
      if (parsed.data.ephemeral) continue;

      // eslint-disable-next-line no-await-in-loop
      const active = await getDaemonActiveJobs(id);
      const slots = parsed.data.maxConcurrentJobs - active;
      if (slots > 0) free += slots;
    } catch (err) {
      logger.debug(
        { err: err instanceof Error ? err.message : String(err), daemonId: id },
        "Failed to read daemon capacity — skipping",
      );
    }
  }
  return free;
}

export async function decrementDaemonActiveJobs(daemonId: string): Promise<void> {
  const valkey = requireValkeyClient();
  const key = `daemon:${daemonId}:active_jobs`;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Valkey EVAL returns number
  const result: number = await valkey.send("EVAL", [DECR_IF_POSITIVE_LUA, "1", key]);
  if (result === -1) {
    logger.warn({ daemonId }, "Skipped DECR — active_jobs already at zero or below");
  }
}
