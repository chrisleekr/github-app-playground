import { rmSync } from "node:fs";

import { config } from "../config";
import { logger } from "../logger";
import type { ActiveJob, DaemonCapabilities, SerializableBotContext } from "../shared/daemon-types";
import {
  createMessageEnvelope,
  type JobCancelMessage,
  type JobOfferMessage,
  type JobPayloadMessage,
} from "../shared/ws-messages";

// Active job tracking (FM-9)

const activeJobs = new Map<string, ActiveJob>();
/** Abort controllers keyed by offerId — used to prevent cancel/execute race sending duplicate job:result. */
const jobAbortControllers = new Map<string, AbortController>();

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

// Offer evaluation (T029, FR-010, R-007)

const MAX_CONCURRENT_JOBS = parseInt(process.env["DAEMON_MAX_CONCURRENT_JOBS"] ?? "3", 10);

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
    return {
      accept: false,
      reason: `insufficient memory: ${capabilities.resources.memoryFreeMb}MB < ${config.daemonMemoryFloorMb}MB minimum`,
    };
  }

  // Check disk floor
  if (capabilities.resources.diskFreeMb < config.daemonDiskFloorMb) {
    return {
      accept: false,
      reason: `insufficient disk: ${capabilities.resources.diskFreeMb}MB < ${config.daemonDiskFloorMb}MB minimum`,
    };
  }

  // Check capacity
  if (activeJobs.size >= MAX_CONCURRENT_JOBS) {
    return {
      accept: false,
      reason: `at capacity: ${activeJobs.size}/${MAX_CONCURRENT_JOBS} jobs active`,
    };
  }

  return { accept: true };
}

// ---------------------------------------------------------------------------
// Helpers extracted from executeJob to reduce complexity / statement count
// ---------------------------------------------------------------------------

/** Write orchestrator-provided env vars as a .env file in the work directory. */
async function writeEnvFile(
  workDir: string,
  envVars: Record<string, string> | undefined,
  log: { info: (obj: object, msg: string) => void },
): Promise<void> {
  if (envVars === undefined || Object.keys(envVars).length === 0) return;
  const fs = await import("node:fs");
  const path = await import("node:path");
  const envContent = Object.entries(envVars)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  fs.writeFileSync(path.join(workDir, ".env"), `${envContent}\n`);
  log.info({ keyCount: Object.keys(envVars).length }, "Wrote .env from orchestrator env vars");
}

/** Validate critical context fields at boundary. Returns false if invalid (sends error result). */
function validateJobContext(
  context: SerializableBotContext,
  offerId: string,
  send: (msg: unknown) => void,
): boolean {
  if (
    typeof context.deliveryId !== "string" ||
    typeof context.owner !== "string" ||
    typeof context.repo !== "string" ||
    typeof context.entityNumber !== "number"
  ) {
    logger.error({ offerId }, "Job payload has malformed context — missing critical fields");
    send({
      type: "job:result",
      ...createMessageEnvelope(offerId),
      payload: {
        success: false,
        deliveryId: typeof context.deliveryId === "string" ? context.deliveryId : "unknown",
        durationMs: 0,
        errorMessage: "Malformed context: missing deliveryId, owner, repo, or entityNumber",
      },
    });
    return false;
  }
  return true;
}

/** Send a synthetic success result for dry-run mode. */
function sendDryRunResult(
  offerId: string,
  deliveryId: string,
  startedAt: number,
  aborted: boolean,
  send: (msg: unknown) => void,
): void {
  if (aborted) return;
  send({
    type: "job:result",
    ...createMessageEnvelope(offerId),
    payload: {
      success: true,
      deliveryId,
      durationMs: Date.now() - startedAt,
      costUsd: 0,
      numTurns: 0,
      dryRun: true,
    },
  });
}

// Job execution (T027)

/**
 * Execute a job received via job:payload.
 * Clones repo, reconstructs BotContext, runs inline pipeline, reports result.
 *
 * @param send - Function to send messages back to the orchestrator.
 */
export async function executeJob(
  payload: JobPayloadMessage,
  capabilities: DaemonCapabilities,
  send: (msg: unknown) => void,
): Promise<void> {
  const offerId = payload.id;
  const context = payload.payload.context as unknown as SerializableBotContext;

  if (!validateJobContext(context, offerId, send)) return;

  const {
    installationToken,
    maxTurns: _maxTurns,
    allowedTools: _allowedTools,
    envVars,
    memory,
  } = payload.payload;

  // Abort controller for cancel/execute race prevention (C1)
  const abortController = new AbortController();
  jobAbortControllers.set(offerId, abortController);

  // Track active job (FM-9)
  // TODO: agentPid is never populated because runInlinePipeline does not expose
  // the Claude Agent SDK subprocess PID. Until the SDK provides a process handle,
  // job cancellation (handleJobCancel) cannot kill the running agent subprocess.
  const job: ActiveJob = {
    offerId,
    deliveryId: context.deliveryId,
    workDir: "", // Set after clone
    agentPid: null,
    startedAt: Date.now(),
  };
  activeJobs.set(offerId, job);

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

    const enrichedCtx = context as SerializableBotContext & {
      headBranch?: string;
      baseBranch?: string;
    };
    const headBranch = enrichedCtx.headBranch ?? enrichedCtx.defaultBranch;
    const baseBranch = enrichedCtx.baseBranch ?? enrichedCtx.defaultBranch;

    const { Octokit } = await import("octokit");
    const octokit = new Octokit({ auth: installationToken });

    const childLog = createChildLogger({
      deliveryId: context.deliveryId,
      owner: context.owner,
      repo: context.repo,
      entityNumber: context.entityNumber,
    });

    const fullCtx = {
      ...context,
      octokit,
      log: childLog,
      headBranch,
      baseBranch,
      daemonCapabilities: capabilities,
      ...(memory !== undefined ? { repoMemory: memory } : {}),
    };

    if (context.dryRun === true) {
      childLog.info("Dry-run mode — skipping checkout and pipeline execution");
      sendDryRunResult(
        offerId,
        context.deliveryId,
        job.startedAt,
        abortController.signal.aborted,
        send,
      );
      return;
    }

    const { workDir, cleanup } = await checkoutRepo(fullCtx, installationToken);
    job.workDir = workDir;

    await writeEnvFile(workDir, envVars, childLog);

    send({
      type: "job:status",
      ...createMessageEnvelope(offerId),
      payload: { status: "executing" },
    });

    try {
      const result = await runInlinePipeline(fullCtx);
      const learnings = result.daemonActions?.learnings ?? [];
      const deletions = result.daemonActions?.deletions ?? [];

      childLog.info(
        {
          learningsCount: learnings.length,
          deletionsCount: deletions.length,
          learnings,
          deletions,
        },
        "Daemon actions collected from execution",
      );

      // Only send result if not cancelled (prevents duplicate job:result)
      if (!abortController.signal.aborted) {
        send({
          type: "job:result",
          ...createMessageEnvelope(offerId),
          payload: {
            success: result.success,
            deliveryId: context.deliveryId,
            durationMs: Date.now() - job.startedAt,
            costUsd: result.costUsd,
            numTurns: result.numTurns,
            ...(result.success ? {} : { errorMessage: "Pipeline completed with failure" }),
            ...(learnings.length > 0 ? { learnings } : {}),
            ...(deletions.length > 0 ? { deletions } : {}),
          },
        });
      }
    } finally {
      try {
        await cleanup();
      } catch (cleanupErr) {
        logger.error({ err: cleanupErr }, "Failed to cleanup work directory");
      }
    }
  } catch (error) {
    // Only send error result if not cancelled (prevents duplicate job:result)
    if (!abortController.signal.aborted) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error({ err, offerId, deliveryId: context.deliveryId }, "Job execution failed");

      send({
        type: "job:result",
        ...createMessageEnvelope(offerId),
        payload: {
          success: false,
          deliveryId: context.deliveryId,
          durationMs: Date.now() - job.startedAt,
          errorMessage: err.message,
        },
      });
    }
  } finally {
    activeJobs.delete(offerId);
    jobAbortControllers.delete(offerId);
  }
}

// Job cancellation (T031)

/**
 * Handle a job:cancel message — kill agent subprocess, cleanup, report failure.
 */
export function handleJobCancel(cancel: JobCancelMessage, send: (msg: unknown) => void): void {
  const offerId = cancel.id;
  const job = activeJobs.get(offerId);

  if (job === undefined) {
    logger.warn({ offerId }, "Cancel received for unknown job");
    return;
  }

  logger.info(
    { offerId, deliveryId: job.deliveryId, reason: cancel.payload.reason },
    "Job cancelled",
  );

  // Signal abort to prevent executeJob from sending a duplicate job:result (C1)
  const abortController = jobAbortControllers.get(offerId);
  if (abortController !== undefined) {
    abortController.abort();
    jobAbortControllers.delete(offerId);
  }

  if (job.agentPid !== null) {
    try {
      process.kill(job.agentPid, "SIGTERM");
    } catch {
      // Process may have already exited
    }
  }

  if (job.workDir !== "") {
    try {
      rmSync(job.workDir, { recursive: true, force: true });
    } catch {
      // Best effort
    }
  }

  activeJobs.delete(offerId);

  // Report failure — only the cancel path sends job:result for cancelled jobs
  send({
    type: "job:result",
    ...createMessageEnvelope(offerId),
    payload: {
      success: false,
      deliveryId: job.deliveryId,
      durationMs: Date.now() - job.startedAt,
      errorMessage: `Cancelled: ${cancel.payload.reason}`,
    },
  });
}
