import { config } from "../config";
import { logger } from "../logger";
import { getInstanceId } from "./instance-id";
import { dispatchJob, markJobTerminallyFailed } from "./job-dispatcher";
import { leaseJob, releaseLeasedJob, requeueLeasedJob } from "./job-queue";

const EMPTY_POLL_MS = 200;
const INITIAL_BACKOFF_MS = 100;

let running = false;
let loopPromise: Promise<void> | null = null;
let stopRequested = false;

function sleep(ms: number, abortSignal: { aborted: boolean }): Promise<void> {
  return new Promise((resolve) => {
    if (abortSignal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    // Best-effort abort, caller sets aborted=true and we poll it on wake.
    // The setTimeout still fires; the outer loop checks `stopRequested`
    // immediately after resolve and exits.
    void timer;
  });
}

/**
 * Compute the sleep-before-rerun when a leased job was re-pushed to the
 * shared queue because no locally-connected daemon could take it. Backoff
 * scales with the job's retry count so a spin between instances that all
 * decline the job converges instead of hot-looping.
 */
function backoffFor(retryCount: number): number {
  const doubled = INITIAL_BACKOFF_MS * 2 ** Math.min(retryCount, 10);
  return Math.min(doubled, config.queueWorkerBackoffMaxMs);
}

async function iterate(instanceId: string, abortSignal: { aborted: boolean }): Promise<void> {
  const leased = await leaseJob(instanceId);
  if (leased === null) {
    await sleep(EMPTY_POLL_MS, abortSignal);
    return;
  }

  const { job, raw } = leased;

  logger.debug(
    {
      kind: job.kind,
      deliveryId: job.deliveryId,
      retryCount: job.retryCount,
      instanceId,
      workflowRunId: job.kind === "workflow-run" ? job.workflowRun.runId : undefined,
    },
    "Queue worker leased a job",
  );

  let dispatched = false;
  try {
    dispatched = await dispatchJob(job);
  } catch (err) {
    logger.error(
      {
        err: err instanceof Error ? err.message : String(err),
        deliveryId: job.deliveryId,
      },
      "dispatchJob threw, treating as miss and re-queuing",
    );
  }

  if (dispatched) {
    logger.debug(
      { deliveryId: job.deliveryId, instanceId },
      "Queue worker dispatched job, releasing lease",
    );
    await releaseLeasedJob(instanceId, raw);
    return;
  }

  // No daemon on this instance could take the job. Either another instance
  // has a capable daemon (re-push to head, let them lease it), or nobody
  // does (retry cap eventually fails the job).
  if (job.retryCount >= config.jobMaxRetries) {
    logger.warn(
      { deliveryId: job.deliveryId, retryCount: job.retryCount },
      "Job exceeded max retries with no capable daemon in the fleet, failing terminally",
    );
    await markJobTerminallyFailed(job, "No capable daemon in the fleet after maximum retries");
    await releaseLeasedJob(instanceId, raw);
    return;
  }

  const newRetryCount = await requeueLeasedJob(instanceId, raw, job);
  const delay = backoffFor(newRetryCount);
  logger.debug(
    { deliveryId: job.deliveryId, retryCount: newRetryCount, backoffMs: delay },
    "Re-queued job with no local capable daemon",
  );
  await sleep(delay, abortSignal);
}

/**
 * Start the per-orchestrator queue worker. Idempotent: calling twice does
 * nothing. The worker runs until `stopQueueWorker()` is awaited.
 */
export function startQueueWorker(): void {
  if (running) return;
  running = true;
  stopRequested = false;
  const instanceId = getInstanceId();
  const abortSignal = { aborted: false };

  logger.info({ instanceId }, "Queue worker started");

  loopPromise = (async (): Promise<void> => {
    while (!stopRequested) {
      try {
        await iterate(instanceId, abortSignal);
      } catch (err) {
        // Catastrophic errors (Valkey blip, DB outage) should NOT kill the
        // worker, sleep briefly and keep going. dispatchJob failures are
        // already caught inside `iterate` and treated as misses.
        logger.error(
          { err: err instanceof Error ? err.message : String(err), instanceId },
          "Queue worker iteration failed, sleeping before retry",
        );
        await sleep(EMPTY_POLL_MS * 5, abortSignal);
      }
    }
    abortSignal.aborted = true;
    logger.info({ instanceId }, "Queue worker stopped");
  })();
}

/**
 * Signal the worker to stop and wait for the in-flight iteration to finish.
 * Safe to call before `startQueueWorker` (no-op) and more than once.
 *
 * Leased jobs still in `queue:processing:{instanceId}` are NOT drained here,
 * they are recovered on next startup by `recoverProcessingList`, or by the
 * cross-instance reaper on any live orchestrator. Draining during shutdown
 * would race Valkey's closing connection.
 */
export async function stopQueueWorker(): Promise<void> {
  if (!running) return;
  stopRequested = true;
  const pending = loopPromise;
  loopPromise = null;
  running = false;
  if (pending !== null) await pending;
}
