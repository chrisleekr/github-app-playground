import { rmSync } from "node:fs";

import { config } from "../config";
import { logger } from "../logger";
import type { ActiveJob, DaemonCapabilities, SerializableBotContext } from "../shared/daemon-types";
import { createMessageEnvelope, type JobCancelMessage, type JobOfferMessage, type JobPayloadMessage } from "../shared/ws-messages";

// ---------------------------------------------------------------------------
// Active job tracking (FM-9)
// ---------------------------------------------------------------------------

const activeJobs = new Map<string, ActiveJob>();

export function getActiveJobs(): ActiveJob[] {
  return [...activeJobs.values()];
}

export function getActiveJobCount(): number {
  return activeJobs.size;
}

/**
 * Register a process.on('exit') handler for sync cleanup of all tracked
 * work directories. This catches SIGKILL indirectly (node runs exit handlers
 * for process.exit() calls) and provides a last-resort cleanup path (FM-9).
 */
export function registerExitCleanup(): void {
  process.on("exit", () => {
    for (const job of activeJobs.values()) {
      try {
        rmSync(job.workDir, { recursive: true, force: true });
      } catch {
        // Best effort on exit
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Offer evaluation (T029, FR-010, R-007)
// ---------------------------------------------------------------------------

const MAX_CONCURRENT_JOBS = 3;

/**
 * Evaluate whether this daemon should accept a job offer.
 * Checks tool requirements, memory floor, disk floor, and capacity.
 */
export function evaluateOffer(
  offer: JobOfferMessage,
  capabilities: DaemonCapabilities,
): { accept: boolean; reason?: string } {
  // Check required tools
  const functionalTools = new Set<string>();
  for (const tool of capabilities.cliTools) {
    if (tool.functional) functionalTools.add(tool.name);
  }
  for (const tool of capabilities.packageManagers) {
    if (tool.functional) functionalTools.add(tool.name);
  }
  for (const tool of capabilities.shells) {
    if (tool.functional) functionalTools.add(tool.name);
  }
  if (capabilities.containerRuntime?.daemonRunning === true) {
    functionalTools.add(capabilities.containerRuntime.name);
  }

  for (const required of offer.payload.requiredTools) {
    if (!functionalTools.has(required)) {
      return { accept: false, reason: `missing tool: ${required}` };
    }
  }

  // Check memory floor
  if (capabilities.resources.memoryFreeMb < config.daemonMemoryFloorMb) {
    return { accept: false, reason: `insufficient memory: ${capabilities.resources.memoryFreeMb}MB < ${config.daemonMemoryFloorMb}MB minimum` };
  }

  // Check disk floor
  if (capabilities.resources.diskFreeMb < config.daemonDiskFloorMb) {
    return { accept: false, reason: `insufficient disk: ${capabilities.resources.diskFreeMb}MB < ${config.daemonDiskFloorMb}MB minimum` };
  }

  // Check capacity
  if (activeJobs.size >= MAX_CONCURRENT_JOBS) {
    return { accept: false, reason: `at capacity: ${activeJobs.size}/${MAX_CONCURRENT_JOBS} jobs active` };
  }

  return { accept: true };
}

// ---------------------------------------------------------------------------
// Job execution (T027)
// ---------------------------------------------------------------------------

/**
 * Execute a job received via job:payload.
 * Clones repo, reconstructs BotContext, runs inline pipeline, reports result.
 *
 * @param send - Function to send messages back to the orchestrator.
 */
export async function executeJob(
  payload: JobPayloadMessage,
  _capabilities: DaemonCapabilities,
  send: (msg: unknown) => void,
): Promise<void> {
  const offerId = payload.id;
  const context = payload.payload.context as unknown as SerializableBotContext;
  const { installationToken, maxTurns: _maxTurns, allowedTools: _allowedTools } = payload.payload;

  // Track active job (FM-9)
  const job: ActiveJob = {
    offerId,
    deliveryId: context.deliveryId,
    workDir: "", // Set after clone
    agentPid: null,
    startedAt: Date.now(),
  };
  activeJobs.set(offerId, job);

  // Send status: cloning
  send({
    type: "job:status",
    ...createMessageEnvelope(offerId),
    payload: { status: "cloning" },
  });

  try {
    // Dynamic import to avoid circular deps and keep daemon-side imports clean
    const { checkoutRepo } = await import("../core/checkout");
    const { runInlinePipeline } = await import("../core/inline-pipeline");
    const { createChildLogger } = await import("../logger");

    // Clone repo
    const enrichedCtx = context as SerializableBotContext & {
      headBranch: string;
      baseBranch: string;
    };
    const headBranch = enrichedCtx.headBranch ?? enrichedCtx.defaultBranch;
    const baseBranch = enrichedCtx.baseBranch ?? enrichedCtx.defaultBranch;

    // Create a minimal octokit-like auth object for clone
    const { Octokit } = await import("octokit");
    const octokit = new Octokit({ auth: installationToken });

    const childLog = createChildLogger({
      deliveryId: context.deliveryId,
      owner: context.owner,
      repo: context.repo,
      entityNumber: context.entityNumber,
    });

    // Reconstruct full BotContext
    const fullCtx = {
      ...context,
      octokit,
      log: childLog,
      headBranch,
      baseBranch,
    };

    const { workDir, cleanup } = await checkoutRepo(fullCtx, installationToken);
    job.workDir = workDir;

    // Send status: executing
    send({
      type: "job:status",
      ...createMessageEnvelope(offerId),
      payload: { status: "executing" },
    });

    try {
      // Run the inline pipeline (reuse existing execution path)
      await runInlinePipeline(fullCtx);

      // Send success result
      const durationMs = Date.now() - job.startedAt;
      send({
        type: "job:result",
        ...createMessageEnvelope(offerId),
        payload: {
          success: true,
          durationMs,
        },
      });
    } finally {
      try {
        await cleanup();
      } catch (cleanupErr) {
        logger.error({ err: cleanupErr }, "Failed to cleanup work directory");
      }
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error({ err, offerId, deliveryId: context.deliveryId }, "Job execution failed");

    send({
      type: "job:result",
      ...createMessageEnvelope(offerId),
      payload: {
        success: false,
        durationMs: Date.now() - job.startedAt,
        errorMessage: err.message,
      },
    });
  } finally {
    activeJobs.delete(offerId);
  }
}

// ---------------------------------------------------------------------------
// Job cancellation (T031)
// ---------------------------------------------------------------------------

/**
 * Handle a job:cancel message — kill agent subprocess, cleanup, report failure.
 */
export function handleJobCancel(
  cancel: JobCancelMessage,
  send: (msg: unknown) => void,
): void {
  const offerId = cancel.id;
  const job = activeJobs.get(offerId);

  if (job === undefined) {
    logger.warn({ offerId }, "Cancel received for unknown job");
    return;
  }

  logger.info({ offerId, deliveryId: job.deliveryId, reason: cancel.payload.reason }, "Job cancelled");

  // Kill agent subprocess if running
  if (job.agentPid !== null) {
    try {
      process.kill(job.agentPid, "SIGTERM");
    } catch {
      // Process may have already exited
    }
  }

  // Cleanup work directory
  if (job.workDir !== "") {
    try {
      rmSync(job.workDir, { recursive: true, force: true });
    } catch {
      // Best effort
    }
  }

  activeJobs.delete(offerId);

  // Report failure
  send({
    type: "job:result",
    ...createMessageEnvelope(offerId),
    payload: {
      success: false,
      durationMs: Date.now() - job.startedAt,
      errorMessage: `Cancelled: ${cancel.payload.reason}`,
    },
  });
}
