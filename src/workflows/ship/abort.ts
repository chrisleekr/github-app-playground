/**
 * Cancellation flag for `bot:abort-ship` and `bot:stop` (R11).
 * Backed by Valkey `ship:cancel:<intent_id>` with a 1-hour TTL.
 *
 * Mutating functions in `src/workflows/ship/*` MUST call `isCancelled`
 * at every safe checkpoint and bail with no side effects when set.
 */

import type { RedisClient } from "bun";

import { getValkeyClient } from "../../orchestrator/valkey";
import { CANCEL_KEY_PREFIX } from "./webhook-reactor";

export const CANCEL_TTL_SECONDS = 3600;

export async function requestAbort(
  intent_id: string,
  valkey: Pick<RedisClient, "send">,
): Promise<void> {
  await valkey.send("SET", [
    `${CANCEL_KEY_PREFIX}${intent_id}`,
    "1",
    "EX",
    String(CANCEL_TTL_SECONDS),
  ]);
}

export async function clearAbort(
  intent_id: string,
  valkey: Pick<RedisClient, "send">,
): Promise<void> {
  await valkey.send("DEL", [`${CANCEL_KEY_PREFIX}${intent_id}`]);
}

export async function isCancelled(
  intent_id: string,
  valkey: Pick<RedisClient, "send">,
): Promise<boolean> {
  const result: unknown = await valkey.send("GET", [`${CANCEL_KEY_PREFIX}${intent_id}`]);
  return result !== null && result !== undefined;
}

/**
 * Convenience for safe-checkpoint sites in mutating ship-workflow code
 * (T059): pulls the Valkey singleton and returns `true` when the intent
 * has a live cancellation flag. No-op (returns `false`) when Valkey is
 * unavailable so a missing dep doesn't strand the bot.
 *
 * Use as the first line of every mutating function:
 *   ```ts
 *   if (await checkpointCancelled(intent_id)) return;
 *   ```
 *
 * Workers do NOT clear the flag on bail: the lifecycle command that
 * set the flag is the sole owner of its lifecycle (it transitions the
 * intent to terminal and lets the 1-hour TTL expire the flag).
 */
export async function checkpointCancelled(intent_id: string): Promise<boolean> {
  const valkey = getValkeyClient();
  if (valkey === null) return false;
  return isCancelled(intent_id, valkey);
}
