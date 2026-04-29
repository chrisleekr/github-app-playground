import { rmSync } from "node:fs";

import { Octokit } from "octokit";

import { config } from "../config";
import { runPipeline } from "../core/pipeline";
import { createChildLogger, logger } from "../logger";
import type { ActiveJob, DaemonCapabilities, SerializableBotContext } from "../shared/daemon-types";
import {
  createMessageEnvelope,
  type JobCancelMessage,
  type JobOfferMessage,
  type JobPayloadMessage,
} from "../shared/ws-messages";
import { executeWorkflowRun } from "./workflow-executor";

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
      // Credential helper (${workDir}.cred.sh) is written by checkoutRepo beside
      // the workspace and contains the installation token — remove it too so a
      // SIGKILL / crash does not leak it for the app.ts stale-cred sweep window.
      try {
        rmSync(`${job.workDir}.cred.sh`, { force: true });
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

// Helpers extracted from executeJob to reduce complexity / statement count

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
 * Clones repo, reconstructs BotContext, runs the pipeline, reports result.
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

  // Scoped-* jobs route through their own deterministic/agent-driven
  // executors. They do NOT go through the legacy BotContext pipeline, so
  // dispatch BEFORE the (legacy-shaped) context validation below.
  if (payload.payload.scoped !== undefined) {
    await runScopedJob(payload, capabilities, send);
    return;
  }

  if (!validateJobContext(context, offerId, send)) return;

  // Workflow-run jobs route through a registry-driven executor instead of
  // the legacy single-shot pipeline. Everything downstream of this branch
  // assumes a traditional BotContext pipeline run.
  if (payload.payload.workflowRun !== undefined) {
    await executeWorkflowRun(payload, send);
    return;
  }

  const { installationToken, maxTurns, allowedTools, envVars, memory } = payload.payload;

  // Abort controller for cancel/execute race prevention (C1)
  const abortController = new AbortController();
  jobAbortControllers.set(offerId, abortController);

  // Track active job (FM-9). `agentPid` is intentionally left null — the
  // Claude Agent SDK does not expose the subprocess PID, but the per-job
  // AbortController plumbed into runPipeline below already gives
  // handleJobCancel a clean way to terminate the agent (and its MCP servers)
  // by aborting the SDK iterator.
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
    const enrichedCtx = context as SerializableBotContext & {
      headBranch?: string;
      baseBranch?: string;
    };
    const headBranch = enrichedCtx.headBranch ?? enrichedCtx.defaultBranch;
    const baseBranch = enrichedCtx.baseBranch ?? enrichedCtx.defaultBranch;

    const octokit = new Octokit({ auth: installationToken });

    const childLog = createChildLogger({
      deliveryId: context.deliveryId,
      owner: context.owner,
      repo: context.repo,
      entityNumber: context.entityNumber,
    });

    // Build the full BotContext. `envVars` is threaded through the context so
    // the pipeline can write `.env` into the agent workspace after its own
    // checkout. A second (outer) checkout here would leave `.env` in a
    // throwaway directory that the agent never sees.
    const fullCtx = {
      ...context,
      octokit,
      log: childLog,
      headBranch,
      baseBranch,
      daemonCapabilities: capabilities,
      ...(memory !== undefined ? { repoMemory: memory } : {}),
      ...(envVars !== undefined && Object.keys(envVars).length > 0 ? { envVars } : {}),
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

    send({
      type: "job:status",
      ...createMessageEnvelope(offerId),
      payload: { status: "executing" },
    });

    // Honor orchestrator-approved execution limits (maxTurns, tool allowlist)
    // so daemon execution matches what the orchestrator authorized.
    // `onWorkDirReady` records the pipeline's workspace on the ActiveJob so
    // handleJobCancel and registerExitCleanup can rm it (and its `.cred.sh`)
    // even if the pipeline does not finish its own cleanup.
    const result = await runPipeline(fullCtx, {
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      allowedTools,
      onWorkDirReady: (wd: string) => {
        job.workDir = wd;
      },
      signal: abortController.signal,
    });
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

// Scoped-job dispatch (US3 routing surface)

/**
 * Dispatch a `scoped-*` job:payload to the matching executor. The executor
 * implementations land in US3 (T029-T032); this surface throws a structured
 * `not implemented` error per kind so a daemon image without the executors
 * surfaces a clean halt rather than a silent drop.
 *
 * Routes via the Zod-validated `payload.scoped.jobKind` discriminator —
 * matches the `scoped-job-offer` schema at the WS boundary, so a misrouted
 * payload is impossible by construction.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- async surface preserved for US3 executors that will introduce real awaits
async function runScopedJob(
  payload: JobPayloadMessage,
  _capabilities: DaemonCapabilities,
  send: (msg: unknown) => void,
): Promise<void> {
  const scoped = payload.payload.scoped;
  if (scoped === undefined) {
    logger.error({ offerId: payload.id }, "runScopedJob called without scoped payload");
    return;
  }

  const offerId = payload.id;
  const startedAt = Date.now();
  const installationToken = payload.payload.installationToken;
  void installationToken; // consumed by per-kind executors landing in US3

  try {
    switch (scoped.jobKind) {
      case "scoped-rebase":
      case "scoped-fix-thread":
      case "scoped-explain-thread":
      case "scoped-open-pr":
        // US3 executors plug in here (T033). Until then, every scoped kind
        // reports a deterministic halt so the orchestrator-side completion
        // bridge (T033b) can post a user-visible "not yet wired" reply
        // without the daemon hanging.
        throw new Error(`scoped executor not implemented: ${scoped.jobKind}`);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error(
      {
        event: `ship.scoped.${scoped.jobKind}.daemon.failed`,
        offerId,
        deliveryId: scoped.deliveryId,
        reason,
      },
      "scoped-job execution failed",
    );
    send({
      type: "scoped-job-completion",
      ...createMessageEnvelope(offerId),
      payload: {
        offerId,
        deliveryId: scoped.deliveryId,
        jobKind: scoped.jobKind,
        status: "failed" as const,
        durationMs: Date.now() - startedAt,
        reason,
      },
    });
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
    try {
      rmSync(`${job.workDir}.cred.sh`, { force: true });
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
