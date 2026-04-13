import { getDb } from "../db";
import { logger } from "../logger";
import type { DaemonCapabilities, DaemonInfo } from "../shared/daemon-types";
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

  // Valkey: store daemon liveness with TTL
  const valkeyPayload = JSON.stringify(capabilities);
  await valkey.send("SETEX", [`daemon:${daemonId}`, String(DAEMON_TTL_SECONDS), valkeyPayload]);
  await valkey.send("SET", [`daemon:${daemonId}:active_jobs`, "0"]);

  // Postgres: upsert daemon record (extract resources from capabilities)
  const db = getDb();
  if (db !== null) {
    const { resources, ...capabilitiesWithoutResources } = capabilities;
    await db`
      INSERT INTO daemons (id, hostname, platform, os_version, capabilities, resources, status, first_seen_at, last_seen_at)
      VALUES (
        ${daemonId},
        ${hostname},
        ${platform},
        ${osVersion},
        ${JSON.stringify(capabilitiesWithoutResources)},
        ${JSON.stringify(resources)},
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
 * Returns daemon IDs (strips the "daemon:" prefix).
 */
export async function getActiveDaemons(): Promise<string[]> {
  const valkey = requireValkeyClient();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Valkey KEYS returns string[]
  const keys: string[] = await valkey.send("KEYS", ["daemon:*"]);
  return keys
    .filter((k) => !k.includes(":active_jobs"))
    .map((k) => k.replace("daemon:", ""));
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
 * Decrement the active job count for a daemon in Valkey.
 */
export async function decrementDaemonActiveJobs(daemonId: string): Promise<void> {
  const valkey = requireValkeyClient();
  await valkey.send("DECR", [`daemon:${daemonId}:active_jobs`]);
}
