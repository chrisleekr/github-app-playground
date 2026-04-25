import { logger } from "../logger";
import { instanceAliveKey } from "./instance-liveness";
import { PROCESSING_KEY_PATTERN, processingListKey, recoverProcessingList } from "./job-queue";
import { requireValkeyClient } from "./valkey";

const SCAN_BATCH = 100;

/** Strip `daemon:` prefix and `:active_jobs` suffix to recover the daemon id. */
function activeJobsKeyToDaemonId(key: string): string | null {
  if (!key.startsWith("daemon:") || !key.endsWith(":active_jobs")) return null;
  return key.slice("daemon:".length, key.length - ":active_jobs".length);
}

/** Strip `queue:processing:` prefix to recover the owning instance id. */
function processingKeyToInstanceId(key: string): string | null {
  const prefix = "queue:processing:";
  if (!key.startsWith(prefix)) return null;
  return key.slice(prefix.length);
}

/**
 * Iterate every key matching `pattern` via cursor-based SCAN. Non-blocking on
 * the Valkey side — won't stall heartbeats or other concurrent traffic.
 */
async function* scanKeys(pattern: string): AsyncGenerator<string> {
  const valkey = requireValkeyClient();
  let cursor = "0";
  do {
    // eslint-disable-next-line no-await-in-loop, @typescript-eslint/no-unsafe-assignment -- Valkey SCAN returns [string, string[]]
    const result: [string, string[]] = await valkey.send("SCAN", [
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      String(SCAN_BATCH),
    ]);
    cursor = result[0];
    for (const key of result[1]) yield key;
  } while (cursor !== "0");
}

/**
 * Remove `daemon:{id}:active_jobs` keys whose corresponding liveness key
 * `daemon:{id}` no longer exists. Recovers from orchestrator crashes that
 * happened before TTLs were added to the counter key.
 */
async function reapOrphanActiveJobsKeys(): Promise<number> {
  const valkey = requireValkeyClient();
  let removed = 0;
  for await (const key of scanKeys("daemon:*:active_jobs")) {
    const id = activeJobsKeyToDaemonId(key);
    if (id === null) continue;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Valkey EXISTS returns number
    const liveness: number = await valkey.send("EXISTS", [`daemon:${id}`]);
    if (liveness === 0) {
      await valkey.send("DEL", [key]);
      removed++;
    }
  }
  return removed;
}

/**
 * Eager pruning of `active_daemons` SET members whose liveness key has
 * expired. `getActiveDaemons` already does this lazily on every dispatch;
 * this just shrinks the set at startup so logs and metrics aren't noisy.
 */
async function reapOrphanActiveDaemonsSet(): Promise<number> {
  const valkey = requireValkeyClient();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Valkey SMEMBERS returns string[]
  const members: string[] = await valkey.send("SMEMBERS", ["active_daemons"]);
  let removed = 0;
  for (const id of members) {
    // eslint-disable-next-line no-await-in-loop, @typescript-eslint/no-unsafe-assignment -- Valkey EXISTS returns number
    const exists: number = await valkey.send("EXISTS", [`daemon:${id}`]);
    if (exists === 0) {
      // eslint-disable-next-line no-await-in-loop
      await valkey.send("SREM", ["active_daemons", id]);
      removed++;
    }
  }
  return removed;
}

/**
 * Find processing lists owned by orchestrator instances that no longer
 * publish their `orchestrator:{id}:alive` heartbeat key, and drain them
 * back to the shared queue so a live instance picks the work up.
 *
 * Self-owned lists are skipped here — `recoverProcessingList(self)` is
 * called separately during startup to handle same-instance restart.
 */
export async function reapOrphanProcessingLists(selfInstanceId: string): Promise<number> {
  const valkey = requireValkeyClient();
  let recovered = 0;
  for await (const key of scanKeys(PROCESSING_KEY_PATTERN)) {
    const id = processingKeyToInstanceId(key);
    if (id === null || id === selfInstanceId) continue;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Valkey EXISTS returns number
    const alive: number = await valkey.send("EXISTS", [instanceAliveKey(id)]);
    if (alive === 1) continue; // Owner is alive — leave it alone.
    const drained = await recoverProcessingList(id);
    recovered += drained;
    // The list is now empty; clean up the empty key for tidiness.
    if (drained > 0) {
      await valkey.send("DEL", [processingListKey(id)]);
    }
  }
  return recovered;
}

/**
 * One-shot Valkey orphan sweep, run on every orchestrator startup. Idempotent
 * and safe to run concurrently across the fleet — every step uses
 * single-command atomics or is read-then-conditionally-delete on independent
 * keys.
 */
export async function sweepValkeyOrphans(selfInstanceId: string): Promise<void> {
  const startedAt = Date.now();
  const [activeJobsRemoved, setMembersRemoved, processingListsRecovered] = [
    await reapOrphanActiveJobsKeys(),
    await reapOrphanActiveDaemonsSet(),
    await reapOrphanProcessingLists(selfInstanceId),
  ];
  logger.info(
    {
      activeJobsRemoved,
      setMembersRemoved,
      processingListsRecovered,
      elapsedMs: Date.now() - startedAt,
      selfInstanceId,
    },
    "Valkey orphan sweep complete",
  );
}
