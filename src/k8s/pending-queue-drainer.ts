/**
 * Background drainer for the isolated-job pending queue (T044, US3).
 *
 * Runs as a single `setInterval` inside the webhook server process. Each
 * tick: while `inFlightCount()` is under capacity AND the queue has entries,
 * pop one, reconstruct a BotContext from the stored serialized form, and
 * call `spawnIsolatedJob`. On spawn success, register the delivery in the
 * in-flight set; on spawn failure, release any slot we might have grabbed
 * and drop the entry (FR-021: no mid-run retry, and a queue re-add would
 * re-enter the same failing state).
 *
 * Idempotency: `dequeuePending` is the only consumer of the pending list,
 * and the drainer is the only caller of `dequeuePending` at runtime. The
 * `draining` guard serialises tick handlers so a slow spawn cannot overlap
 * with the next interval firing.
 */

import type { App } from "octokit";

import { config } from "../config";
// Avoid pulling in the full tracking-comment module (and therefore octokit
// typing) — the drainer only needs a single rejection comment shape.
import { createChildLogger, logger } from "../logger";
import type { SerializableBotContext } from "../shared/daemon-types";
import type { BotContext } from "../types";
import type { DispatchDecision } from "../webhook/router";
import { JobSpawnerError, spawnIsolatedJob, watchJobCompletion } from "./job-spawner";
import {
  dequeuePending,
  inFlightCount,
  type PendingIsolatedJobEntry,
  registerInFlight,
  releaseInFlight,
} from "./pending-queue";

/** Default drainer poll interval in milliseconds. */
export const DEFAULT_DRAIN_INTERVAL_MS = 5_000;

let drainerInterval: ReturnType<typeof setInterval> | undefined;
// Mutex as an in-flight promise rather than a boolean flag. Using a boolean
// across `await` points trips `@typescript-eslint/require-atomic-updates`
// and, more fundamentally, wouldn't prevent two concurrent callers from
// both observing `draining=false` simultaneously before either reassigns.
// A promise captured synchronously at the start of the tick cannot race.
let activeDrain: Promise<void> | undefined;

/**
 * Start the drainer. Idempotent — repeated calls are no-ops. Returns the
 * interval handle for test-only shutdown. `app` is the `octokit` App
 * instance; the drainer uses it to mint a fresh installation token for the
 * dequeued event's repo (the token stored at enqueue time is
 * short-lived and likely expired by the time the pool frees).
 */
export function startPendingQueueDrainer(
  app: App,
  intervalMs: number = DEFAULT_DRAIN_INTERVAL_MS,
): ReturnType<typeof setInterval> {
  if (drainerInterval !== undefined) return drainerInterval;
  drainerInterval = setInterval(() => {
    void drainPendingOnce(app);
  }, intervalMs);
  drainerInterval.unref();
  logger.info({ intervalMs }, "pending-queue drainer started");
  return drainerInterval;
}

export function stopPendingQueueDrainer(): void {
  if (drainerInterval !== undefined) {
    clearInterval(drainerInterval);
    drainerInterval = undefined;
    logger.info("pending-queue drainer stopped");
  }
}

/**
 * Exported for tests. Runs one tick of the drain loop: pop + spawn until
 * capacity is reached, the queue drains, or an unrecoverable error occurs.
 * Never throws — all errors are logged.
 */
export function drainPendingOnce(app: App): Promise<void> {
  // Synchronous fast-path: return the in-flight tick's promise so both
  // overlapping callers await the same work rather than starting a second
  // tick. The assignment of `activeDrain` is synchronous with the IIFE
  // so no `await` can interleave between check and set.
  if (activeDrain !== undefined) return activeDrain;
  const run = (async (): Promise<void> => {
    try {
      await drainLoop(app);
    } catch (err) {
      logger.error({ err }, "pending-queue drainer tick failed");
    } finally {
      activeDrain = undefined;
    }
  })();
  activeDrain = run;
  return run;
}

async function drainLoop(app: App): Promise<void> {
  // Bounded by queue length + capacity; `maxIterations` is a defence against
  // a pathological Valkey that keeps returning dequeued entries with the
  // same delivery id after the spawn path fails to register in-flight.
  const maxIterations = Math.max(config.pendingIsolatedJobQueueMax, 20);
  for (let i = 0; i < maxIterations; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- drainer is sequential by design
    const inFlight = await inFlightCount();
    if (inFlight >= config.maxConcurrentIsolatedJobs) return;

    // eslint-disable-next-line no-await-in-loop -- drainer is sequential by design
    const result = await dequeuePending();
    if (result.outcome === "empty") return;
    if (result.outcome === "context-missing") {
      logger.warn(
        { deliveryId: result.entry.deliveryId },
        "dropped queued isolated-job — bot-context TTL expired before drain",
      );
      continue;
    }
    if (result.outcome === "corrupt") {
      logger.error(
        { rawPreview: result.raw.slice(0, 200), error: result.error },
        "dropped corrupt pending-queue entry",
      );
      continue;
    }

    // `dequeued` — reconstruct a BotContext and spawn.
    let ctx: BotContext;
    try {
      // eslint-disable-next-line no-await-in-loop -- drainer is sequential by design
      ctx = await reconstructBotContext(app, result.entry, result.context);
    } catch (err) {
      logger.error(
        { err, deliveryId: result.entry.deliveryId },
        "failed to reconstruct BotContext for queued isolated-job — dropping",
      );
      continue;
    }

    const decision: DispatchDecision = {
      target: "isolated-job",
      reason: result.entry.dispatchReason,
      maxTurns: result.entry.maxTurns,
      ...(result.entry.triageResult !== null && {
        complexity: result.entry.triageResult.complexity,
      }),
    };

    try {
      // eslint-disable-next-line no-await-in-loop -- drainer is sequential by design
      await spawnIsolatedJob(ctx, decision);
      // eslint-disable-next-line no-await-in-loop -- drainer is sequential by design
      await registerInFlight(ctx.deliveryId);
      // Fire-and-forget completion watcher — same invariants as the
      // direct-spawn path (T046/T047/T048). Drainer must NOT await it;
      // the drain loop needs to move to the next entry.
      void watchJobCompletion(ctx.deliveryId).catch((err: unknown) => {
        ctx.log.error(
          { err, deliveryId: ctx.deliveryId },
          "watchJobCompletion threw unexpectedly in drainer — in-flight slot may leak",
        );
      });
      ctx.log.info({ deliveryId: ctx.deliveryId }, "drained queued isolated-job — Job spawned");
    } catch (err) {
      // FR-021: no retry on mid-run failure. Just release any slot and log.
      //
      // Copilot PR #21 review: a queued request whose drain trips
      // `infra-absent` (K8s went away between enqueue and drain) used to
      // be silently dropped. Surface it to the requester with the same
      // rejection comment the router would have posted on a direct-spawn
      // infra-absent, so the user isn't left with a dangling "⏳ Queued"
      // with no resolution.
      const kind = err instanceof JobSpawnerError ? err.kind : "unknown";
      ctx.log.error(
        { err, deliveryId: ctx.deliveryId, kind },
        "drainer spawn failed — dropping entry (FR-021 no retry)",
      );
      if (err instanceof JobSpawnerError && err.kind === "infra-absent") {
        // eslint-disable-next-line no-await-in-loop -- drainer is sequential by design
        await postInfraAbsentDrainRejection(ctx);
      }
      // eslint-disable-next-line no-await-in-loop -- drainer is sequential by design
      await releaseInFlight(ctx.deliveryId);
    }
  }
}

/**
 * Rebuild a `BotContext` from the stored `SerializableBotContext`. The
 * stored form lacks an `octokit` instance (class) and `log` (pino Logger
 * with streams); this helper mints a fresh installation octokit from the
 * App JWT and a child logger keyed on the original delivery id.
 */
async function reconstructBotContext(
  app: App,
  entry: PendingIsolatedJobEntry,
  context: SerializableBotContext,
): Promise<BotContext> {
  const install = await app.octokit.rest.apps.getRepoInstallation({
    owner: entry.source.owner,
    repo: entry.source.repo,
  });
  const octokit = await app.getInstallationOctokit(install.data.id);
  const log = createChildLogger({
    deliveryId: context.deliveryId,
    owner: context.owner,
    repo: context.repo,
    entityNumber: context.entityNumber,
  });
  return {
    ...context,
    octokit: octokit as unknown as BotContext["octokit"],
    log,
  };
}

/**
 * Post a rejection comment to the issue/PR when the drainer trips an
 * `infra-absent` on a previously-queued request. Mirrors the wording used
 * by `recordInfraAbsentRejection` in the router's direct-spawn path so a
 * user sees the same explanation regardless of whether they hit the
 * capacity gate first.
 */
async function postInfraAbsentDrainRejection(ctx: BotContext): Promise<void> {
  try {
    await ctx.octokit.rest.issues.createComment({
      owner: ctx.owner,
      repo: ctx.repo,
      issue_number: ctx.entityNumber,
      body:
        `**${config.triggerPhrase}** cannot complete this queued request: the isolated-job target ` +
        `requires Kubernetes infrastructure that is no longer reachable. The platform will not ` +
        `silently downgrade to a different target — please re-trigger once infrastructure is ` +
        `restored, or without the \`bot:job\` label / docker keyword if shared-runner is acceptable.`,
    });
  } catch (commentError) {
    ctx.log.error({ err: commentError }, "Failed to post drainer infra-absent rejection comment");
  }
}
