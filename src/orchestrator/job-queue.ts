import { config } from "../config";
import { logger } from "../logger";
import type { WorkflowRunRef } from "../shared/workflow-types";
import { requireValkeyClient } from "./valkey";

/**
 * Job queue item — minimal metadata for routing decisions.
 * Full context is read from Postgres executions.context_json when dispatching.
 */
export interface QueuedJob {
  deliveryId: string;
  repoOwner: string;
  repoName: string;
  entityNumber: number;
  isPR: boolean;
  eventName: string;
  /** Trigger metadata — carried through queue so dispatch uses correct context
   * regardless of which webhook handler dequeues the job (Issue #4 race fix). */
  triggerUsername: string;
  labels: string[];
  triggerBodyPreview: string;
  enqueuedAt: number;
  retryCount: number;
  /** Present for workflow-run jobs. Daemon branches on this field's presence
   * to route through the workflow handler path instead of the legacy pipeline. */
  workflowRun?: WorkflowRunRef;
}

const QUEUE_KEY = "queue:jobs";
const PROCESSING_KEY_PREFIX = "queue:processing:";

/** Build the per-instance processing-list key. Exposed for the cross-instance reaper. */
export function processingListKey(instanceId: string): string {
  return `${PROCESSING_KEY_PREFIX}${instanceId}`;
}

/** Pattern to SCAN every orchestrator's processing list (used by the reaper). */
export const PROCESSING_KEY_PATTERN = `${PROCESSING_KEY_PREFIX}*`;

/**
 * Enqueue a job for daemon dispatch.
 * Uses LPUSH (newest at head) — BRPOP dequeues from tail (FIFO).
 */
export async function enqueueJob(job: QueuedJob): Promise<void> {
  const valkey = requireValkeyClient();
  await valkey.send("LPUSH", [QUEUE_KEY, JSON.stringify(job)]);
  logger.info({ deliveryId: job.deliveryId, retryCount: job.retryCount }, "Job enqueued");
}

/**
 * Return the current queue depth. Used by the ephemeral-daemon scaler
 * to detect persistent-pool backpressure. Non-blocking; returns 0 on
 * any Valkey read error so a transient blip falls through to
 * persistent-daemon routing instead of trapping a job.
 */
export async function getQueueLength(): Promise<number> {
  try {
    // `requireValkeyClient()` itself throws when the client isn't ready, so
    // acquire inside the try block — otherwise the "return 0 on any read
    // error" contract silently loses to the client acquisition throw.
    const valkey = requireValkeyClient();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Valkey LLEN returns number
    const len: number = await valkey.send("LLEN", [QUEUE_KEY]);
    return typeof len === "number" && Number.isFinite(len) ? len : 0;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to read queue length — treating as 0",
    );
    return 0;
  }
}

/**
 * Non-blocking dequeue for use in webhook handlers.
 * Uses RPOP — returns immediately with null if the queue is empty.
 */
export async function tryDequeueJob(): Promise<QueuedJob | null> {
  const valkey = requireValkeyClient();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Valkey RPOP returns string | null
  const result: string | null = await valkey.send("RPOP", [QUEUE_KEY]);

  if (result === null) return null;

  try {
    return JSON.parse(result) as QueuedJob;
  } catch {
    logger.error("Failed to parse dequeued job");
    return null;
  }
}

/**
 * Blocking dequeue for background dispatch loops.
 * Uses BRPOP with a 5-second timeout to avoid busy-waiting.
 * Returns null if the queue is empty after timeout.
 */
export async function dequeueJob(): Promise<QueuedJob | null> {
  const valkey = requireValkeyClient();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Valkey BRPOP returns [key, value] | null
  const result: [string, string] | null = await valkey.send("BRPOP", [QUEUE_KEY, "5"]);

  if (result === null) return null;

  try {
    return JSON.parse(result[1]) as QueuedJob;
  } catch {
    logger.error("Failed to parse dequeued job");
    return null;
  }
}

/**
 * Re-enqueue a job after rejection or timeout, respecting retry limits.
 * Returns true if re-queued, false if max retries exceeded.
 */
export async function requeueJob(job: QueuedJob): Promise<boolean> {
  if (job.retryCount >= config.jobMaxRetries) {
    logger.warn(
      { deliveryId: job.deliveryId, retryCount: job.retryCount },
      "Job exceeded max retries — will not re-queue",
    );
    return false;
  }

  const updated: QueuedJob = {
    ...job,
    retryCount: job.retryCount + 1,
    enqueuedAt: Date.now(),
  };
  await enqueueJob(updated);
  return true;
}

// --- Reliable-queue lease helpers (HA queue worker) -------------------------
//
// A single Bun RedisClient is shared process-wide, so blocking commands like
// BLMOVE would starve every other Valkey caller (heartbeats, registration,
// counters). The worker therefore polls with a non-blocking LMOVE and sleeps
// between empty polls — see `queue-worker.ts`.

/**
 * Atomic lease: pop the oldest job from `queue:jobs` and append it to this
 * instance's processing list. Returns the parsed job and the raw JSON string
 * (the latter is needed verbatim for `LREM`/`LMOVE` element matching).
 *
 * Returns null when the queue is empty.
 */
export async function leaseJob(
  instanceId: string,
): Promise<{ job: QueuedJob; raw: string } | null> {
  const valkey = requireValkeyClient();
  const dest = processingListKey(instanceId);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Valkey LMOVE returns string | null
  const raw: string | null = await valkey.send("LMOVE", [QUEUE_KEY, dest, "RIGHT", "LEFT"]);
  if (raw === null) return null;
  try {
    const job = JSON.parse(raw) as QueuedJob;
    return { job, raw };
  } catch {
    // Poison pill — drop it from the processing list so it doesn't block
    // recovery, then bubble null so the worker logs and continues.
    logger.error({ raw: raw.slice(0, 200) }, "Failed to parse leased job — dropping poison pill");
    await valkey.send("LREM", [dest, "1", raw]);
    return null;
  }
}

/**
 * Release a successfully-dispatched job from this instance's processing list.
 * Idempotent — `LREM` is a no-op when the element is already gone.
 */
export async function releaseLeasedJob(instanceId: string, raw: string): Promise<void> {
  const valkey = requireValkeyClient();
  await valkey.send("LREM", [processingListKey(instanceId), "1", raw]);
}

// Atomic re-queue: remove the leased element from the processing list and
// push the updated payload back to the head of the shared queue. Inlining
// this as one EVAL avoids a duplicate-on-crash window between LREM and LPUSH.
const REQUEUE_LUA = `
  redis.call('LREM', KEYS[1], 1, ARGV[1])
  redis.call('LPUSH', KEYS[2], ARGV[2])
  return 1
`;

/**
 * Re-queue a leased job back to `queue:jobs` (head, so another instance picks
 * it up next), bumping `retryCount` and `enqueuedAt`. Returns the new
 * `retryCount` so the caller can apply backoff or give up.
 */
export async function requeueLeasedJob(
  instanceId: string,
  raw: string,
  job: QueuedJob,
): Promise<number> {
  const valkey = requireValkeyClient();
  const updated: QueuedJob = {
    ...job,
    retryCount: job.retryCount + 1,
    enqueuedAt: Date.now(),
  };
  await valkey.send("EVAL", [
    REQUEUE_LUA,
    "2",
    processingListKey(instanceId),
    QUEUE_KEY,
    raw,
    JSON.stringify(updated),
  ]);
  return updated.retryCount;
}

/**
 * Drain a (possibly-orphaned) processing list back into `queue:jobs`. Called
 * on this instance's own list at startup, and on dead-instance lists by the
 * cross-instance reaper.
 *
 * Pushes items to the HEAD of the shared queue so they are re-leased before
 * any newer arrivals — preserving the rough FIFO intent of the original queue.
 *
 * Returns the number of items recovered.
 */
export async function recoverProcessingList(instanceId: string): Promise<number> {
  const valkey = requireValkeyClient();
  const src = processingListKey(instanceId);
  let count = 0;
  // Bounded by the list length — LMOVE returns null when the source is empty.
  // The 10_000 cap is paranoia: a runaway Valkey state should not loop forever.
  for (let i = 0; i < 10_000; i++) {
    // eslint-disable-next-line no-await-in-loop, @typescript-eslint/no-unsafe-assignment -- Valkey LMOVE returns string | null
    const moved: string | null = await valkey.send("LMOVE", [src, QUEUE_KEY, "LEFT", "LEFT"]);
    if (moved === null) break;
    count++;
  }
  if (count > 0) {
    logger.info({ instanceId, recovered: count }, "Recovered processing-list jobs to queue:jobs");
  }
  return count;
}
