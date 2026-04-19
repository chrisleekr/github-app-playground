import { config } from "../config";
import { logger } from "../logger";
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
}

const QUEUE_KEY = "queue:jobs";

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
