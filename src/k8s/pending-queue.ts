/**
 * Valkey-backed pending queue + in-flight tracker for the isolated-job
 * dispatch target (T043, US3). Implements data-model.md §6 and research.md
 * R4: a single FIFO Redis list `dispatch:isolated-job:pending` bounded by
 * `PENDING_ISOLATED_JOB_QUEUE_MAX`, paired with a set
 * `dispatch:isolated-job:in-flight` bounded by `MAX_CONCURRENT_ISOLATED_JOBS`.
 *
 * BotContext is stored in a separate key (`bot-context:<deliveryId>`) with a
 * 1-hour TTL so list entries stay small. Values are gzipped JSON — the raw
 * BotContext can contain large PR bodies / diffs; the TTL covers the worst
 * case of a queue entry outliving a pod restart by more than the reasonable
 * recovery window.
 *
 * All operations are non-transactional; the spec explicitly accepts that an
 * event whose queue entry was never dequeued before a restart is lost (the
 * outer idempotency layer prevents duplicate processing on redelivery).
 */

import { z } from "zod";

import { logger } from "../logger";
import { TriageResponseSchema } from "../orchestrator/triage";
import { requireValkeyClient } from "../orchestrator/valkey";
import type { SerializableBotContext } from "../shared/daemon-types";
import { DispatchReasonSchema } from "../shared/dispatch-types";

/** Redis key names — centralised so tests can assert against them. */
export const PENDING_LIST_KEY = "dispatch:isolated-job:pending";
export const IN_FLIGHT_SET_KEY = "dispatch:isolated-job:in-flight";
export const BOT_CONTEXT_TTL_SECONDS = 3600;

function botContextKey(deliveryId: string): string {
  return `bot-context:${deliveryId}`;
}

/**
 * JSON schema for a pending queue entry. Mirrors
 * `PendingIsolatedJobEntrySchema` in data-model.md §6. Validated on both
 * enqueue (to reject programming errors fast) and dequeue (to reject
 * corrupted or schema-drifted entries).
 */
export const PendingIsolatedJobEntrySchema = z.object({
  deliveryId: z.string().min(1),
  enqueuedAt: z.iso.datetime(),
  botContextKey: z.string().min(1),
  triageResult: TriageResponseSchema.nullable(),
  /**
   * Carried so the drainer can rebuild a DispatchDecision without re-running
   * the classifier / triage cascade. `dispatchReason` is the original
   * router-chosen reason (label / keyword / triage / …); `maxTurns` is the
   * complexity-resolved turn budget from `resolveMaxTurnsForComplexity`.
   */
  dispatchReason: DispatchReasonSchema,
  maxTurns: z.number().int().positive(),
  source: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    issueOrPrNumber: z.number().int().positive(),
  }),
});
export type PendingIsolatedJobEntry = z.infer<typeof PendingIsolatedJobEntrySchema>;

/** Outcome of an enqueue attempt. Never throws on a full queue. */
export type EnqueueOutcome =
  | { readonly outcome: "enqueued"; readonly position: number }
  | { readonly outcome: "rejected-full"; readonly currentLength: number };

/**
 * Enqueue a pending isolated-job request. Caller is responsible for having
 * already checked `inFlightCount()` against the capacity ceiling — this
 * function only guards the queue length against
 * `PENDING_ISOLATED_JOB_QUEUE_MAX`.
 *
 * Write order matters: `SETEX` the BotContext key FIRST so a racing dequeue
 * after `RPUSH` cannot observe a list entry whose context key is missing.
 *
 * Position is 1-indexed and reflects queue length AFTER this entry lands.
 */
export async function enqueuePending(
  entry: PendingIsolatedJobEntry,
  serializedContext: SerializableBotContext,
  opts: { maxQueueLength: number },
): Promise<EnqueueOutcome> {
  const valkey = requireValkeyClient();
  const validated = PendingIsolatedJobEntrySchema.parse(entry);

  const currentLength = await llen(valkey, PENDING_LIST_KEY);
  if (currentLength >= opts.maxQueueLength) {
    return { outcome: "rejected-full", currentLength };
  }

  await storeBotContext(validated.deliveryId, serializedContext);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Valkey RPUSH returns the new list length
  const newLength: number = await valkey.send("RPUSH", [
    PENDING_LIST_KEY,
    JSON.stringify(validated),
  ]);
  return { outcome: "enqueued", position: newLength };
}

/** Outcome of a dequeue attempt. */
export type DequeueOutcome =
  | {
      readonly outcome: "dequeued";
      readonly entry: PendingIsolatedJobEntry;
      readonly context: SerializableBotContext;
    }
  | { readonly outcome: "empty" }
  | { readonly outcome: "context-missing"; readonly entry: PendingIsolatedJobEntry }
  | { readonly outcome: "corrupt"; readonly raw: string; readonly error: string };

/**
 * Pop the head of the pending queue. Returns the parsed entry plus its
 * BotContext. Callers transition the request to running by invoking
 * `registerInFlight(deliveryId)` after successful spawn.
 *
 * `corrupt` indicates a schema-invalid list entry — the entry is consumed
 * (not requeued) so a poison message cannot block the pool forever; the
 * caller is expected to log and move on.
 */
export async function dequeuePending(): Promise<DequeueOutcome> {
  const valkey = requireValkeyClient();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Valkey LPOP returns string | null
  const raw: string | null = await valkey.send("LPOP", [PENDING_LIST_KEY]);
  if (raw === null) return { outcome: "empty" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { outcome: "corrupt", raw, error: err instanceof Error ? err.message : String(err) };
  }
  const result = PendingIsolatedJobEntrySchema.safeParse(parsed);
  if (!result.success) {
    return { outcome: "corrupt", raw, error: result.error.message };
  }
  const entry = result.data;

  const context = await loadBotContext(entry.deliveryId);
  if (context === null) {
    // TTL expired or bot-context was never written; caller should skip
    // this entry without re-queuing — the upstream idempotency layer will
    // not re-trigger it, and keeping it would block the pool.
    return { outcome: "context-missing", entry };
  }
  return { outcome: "dequeued", entry, context };
}

/**
 * Returns the 1-indexed position of `deliveryId` in the pending queue,
 * or null when the entry is not found. Used by the tracking-comment
 * renderer to show "position N of M". O(N) in queue length — queue max
 * is 20 by default so this is cheap.
 */
export async function getPosition(deliveryId: string): Promise<number | null> {
  const valkey = requireValkeyClient();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Valkey LRANGE returns string[]
  const entries: string[] = await valkey.send("LRANGE", [PENDING_LIST_KEY, "0", "-1"]);
  for (let i = 0; i < entries.length; i++) {
    const raw = entries[i];
    if (raw === undefined) continue;
    try {
      const parsed = JSON.parse(raw) as { deliveryId?: unknown };
      if (parsed.deliveryId === deliveryId) return i + 1;
    } catch {
      // Skip unparsable entries — dequeuePending will collect them later.
    }
  }
  return null;
}

/** Current queue length. Cheap — single `LLEN`. */
export async function pendingLength(): Promise<number> {
  const valkey = requireValkeyClient();
  return await llen(valkey, PENDING_LIST_KEY);
}

/** Current in-flight count. Single `SCARD`. */
export async function inFlightCount(): Promise<number> {
  const valkey = requireValkeyClient();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Valkey SCARD returns number
  const count: number = await valkey.send("SCARD", [IN_FLIGHT_SET_KEY]);
  return count;
}

/**
 * Mark a delivery as in-flight (post-spawn). Idempotent via `SADD`.
 * Returns the new cardinality so the router can log "pool at N/M".
 */
export async function registerInFlight(deliveryId: string): Promise<number> {
  const valkey = requireValkeyClient();
  await valkey.send("SADD", [IN_FLIGHT_SET_KEY, deliveryId]);
  return await inFlightCount();
}

/**
 * Release an in-flight slot (on success, failure, OR timeout). Idempotent
 * via `SREM`. Also deletes the BotContext key — keeping it past completion
 * would leak memory and risk stale re-reads from a misbehaving operator
 * script.
 */
export async function releaseInFlight(deliveryId: string): Promise<void> {
  const valkey = requireValkeyClient();
  await valkey.send("SREM", [IN_FLIGHT_SET_KEY, deliveryId]);
  await deleteBotContext(deliveryId);
}

/** Persist the BotContext blob with the standard 1h TTL. */
export async function storeBotContext(
  deliveryId: string,
  context: SerializableBotContext,
): Promise<void> {
  const valkey = requireValkeyClient();
  const payload = JSON.stringify(context);
  await valkey.send("SETEX", [botContextKey(deliveryId), String(BOT_CONTEXT_TTL_SECONDS), payload]);
}

export async function loadBotContext(deliveryId: string): Promise<SerializableBotContext | null> {
  const valkey = requireValkeyClient();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Valkey GET returns string | null
  const payload: string | null = await valkey.send("GET", [botContextKey(deliveryId)]);
  if (payload === null) return null;
  try {
    return JSON.parse(payload) as SerializableBotContext;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), deliveryId },
      "Failed to parse stored bot-context; treating as missing",
    );
    return null;
  }
}

export async function deleteBotContext(deliveryId: string): Promise<void> {
  const valkey = requireValkeyClient();
  await valkey.send("DEL", [botContextKey(deliveryId)]);
}

async function llen(
  valkey: { send: (cmd: string, args: string[]) => Promise<unknown> },
  key: string,
): Promise<number> {
  const result = (await valkey.send("LLEN", [key])) as number;
  return result;
}
