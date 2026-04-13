import { config } from "../config";
import { logger } from "../logger";
import type { DaemonCapabilities, PendingOffer } from "../shared/daemon-types";
import { createMessageEnvelope } from "../shared/ws-messages";
import { getConnections, getDaemonInfo, isDaemonDraining } from "./connection-handler";
import { getActiveDaemons, getDaemonActiveJobs } from "./daemon-registry";
import {
  markExecutionFailed,
  markExecutionOffered,
  requeueExecution,
} from "./history";
import { type QueuedJob, requeueJob } from "./job-queue";

// ---------------------------------------------------------------------------
// In-memory pending offers (keyed by offerId)
// ---------------------------------------------------------------------------

const pendingOffers = new Map<string, PendingOffer>();

export function getPendingOffer(offerId: string): PendingOffer | undefined {
  return pendingOffers.get(offerId);
}

export function removePendingOffer(offerId: string): void {
  const offer = pendingOffers.get(offerId);
  if (offer !== undefined) {
    clearTimeout(offer.timer);
    pendingOffers.delete(offerId);
  }
}

// ---------------------------------------------------------------------------
// Tool requirement inference (R-007)
// ---------------------------------------------------------------------------

/** Baseline tools every job needs. */
const BASELINE_TOOLS = ["git", "bun", "node"];

/**
 * Infer required tools from job metadata (labels + trigger body keywords).
 */
export function inferRequiredTools(
  labels: string[],
  triggerBody: string,
): string[] {
  const tools = new Set(BASELINE_TOOLS);

  // Label-based inference (e.g., "bot:docker" -> docker)
  for (const label of labels) {
    const lower = label.toLowerCase();
    if (lower.includes("docker")) tools.add("docker");
    if (lower.includes("python")) tools.add("python3");
    if (lower.includes("aws")) tools.add("aws");
    if (lower.includes("make")) tools.add("make");
  }

  // Keyword-based inference from trigger body
  const bodyLower = triggerBody.toLowerCase();
  if (bodyLower.includes("docker") || bodyLower.includes("container")) tools.add("docker");
  if (bodyLower.includes("python")) tools.add("python3");
  if (bodyLower.includes("curl")) tools.add("curl");
  if (bodyLower.includes("makefile") || bodyLower.includes("make ")) tools.add("make");

  return [...tools];
}

// ---------------------------------------------------------------------------
// Daemon selection (R-007, FM-10)
// ---------------------------------------------------------------------------

/**
 * Check if a daemon has the required tools as functional.
 */
function hasRequiredTools(
  capabilities: DaemonCapabilities,
  requiredTools: string[],
): boolean {
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
  // Container runtime counts as "docker" or "podman"
  if (capabilities.containerRuntime?.daemonRunning === true) {
    functionalTools.add(capabilities.containerRuntime.name);
  }

  return requiredTools.every((t) => functionalTools.has(t));
}

/**
 * Select the best daemon for a job offer.
 * Strategy: capability match -> filter draining -> ephemeral preference -> least loaded.
 */
export async function selectDaemon(
  requiredTools: string[],
): Promise<string | null> {
  const activeDaemonIds = await getActiveDaemons();
  if (activeDaemonIds.length === 0) return null;

  const candidates: {
    id: string;
    activeJobs: number;
    ephemeral: boolean;
  }[] = [];

  for (const daemonId of activeDaemonIds) {
    // Skip draining daemons
    if (isDaemonDraining(daemonId)) continue;

    const info = getDaemonInfo(daemonId);
    if (info === undefined) continue;
    if (info.status !== "active") continue;

    // Capability match
    if (!hasRequiredTools(info.capabilities, requiredTools)) continue;

    // eslint-disable-next-line no-await-in-loop
    const activeJobs = await getDaemonActiveJobs(daemonId);

    candidates.push({
      id: daemonId,
      activeJobs,
      ephemeral: info.capabilities.ephemeral,
    });
  }

  if (candidates.length === 0) return null;

  // Sort: prefer non-ephemeral for complex jobs, then least loaded
  // Phase 2 without triage: all jobs are treated as complex (maxTurns > 30)
  candidates.sort((a, b) => {
    // Prefer non-ephemeral
    if (a.ephemeral !== b.ephemeral) return a.ephemeral ? 1 : -1;
    // Then least loaded
    return a.activeJobs - b.activeJobs;
  });

  return candidates[0]!.id;
}

// ---------------------------------------------------------------------------
// Offer protocol (FR-010a)
// ---------------------------------------------------------------------------

/**
 * Dispatch a job to a daemon via the offer/accept/reject protocol.
 * Returns true if the job was offered to a daemon, false if no daemon available.
 */
export async function dispatchJob(
  job: QueuedJob,
  triggerUsername: string,
  labels: string[],
  triggerBodyPreview: string,
): Promise<boolean> {
  const requiredTools = inferRequiredTools(labels, triggerBodyPreview);
  const daemonId = await selectDaemon(requiredTools);

  if (daemonId === null) {
    return false; // Caller handles FM-3 fallback
  }

  const connections = getConnections();
  const ws = connections.get(daemonId);
  if (ws === undefined) {
    logger.warn({ daemonId }, "Selected daemon has no active connection");
    return false;
  }

  const offerId = crypto.randomUUID();

  // Update execution record
  await markExecutionOffered(job.deliveryId, daemonId);

  // Send job:offer
  ws.sendText(
    JSON.stringify({
      type: "job:offer",
      ...createMessageEnvelope(offerId),
      payload: {
        deliveryId: job.deliveryId,
        repoOwner: job.repoOwner,
        repoName: job.repoName,
        entityNumber: job.entityNumber,
        isPR: job.isPR,
        eventName: job.eventName,
        triggerUsername,
        labels,
        triggerBodyPreview,
        requiredTools,
      },
    }),
  );

  // Track pending offer with timeout
  const timer = setTimeout(() => {
    void handleOfferTimeout(offerId, job);
  }, config.offerTimeoutMs);

  pendingOffers.set(offerId, {
    offerId,
    deliveryId: job.deliveryId,
    daemonId,
    timer,
    offeredAt: Date.now(),
    retryCount: job.retryCount,
  });

  logger.info(
    { deliveryId: job.deliveryId, daemonId, offerId },
    "Job offered to daemon",
  );

  return true;
}

/**
 * Handle offer timeout — daemon didn't respond within offerTimeoutMs.
 * Re-queue or fail the job.
 */
async function handleOfferTimeout(offerId: string, job: QueuedJob): Promise<void> {
  const offer = pendingOffers.get(offerId);
  if (offer === undefined) return; // Already handled

  pendingOffers.delete(offerId);

  logger.warn(
    { deliveryId: job.deliveryId, daemonId: offer.daemonId, offerId },
    "Job offer timed out",
  );

  // Re-queue the execution
  await requeueExecution(job.deliveryId);

  // Re-enqueue with incremented retry count
  const requeued = await requeueJob(job);
  if (!requeued) {
    await markExecutionFailed(
      job.deliveryId,
      "All daemons rejected or timed out after maximum retries",
    );
  }
}

/**
 * Handle a job:accept message from a daemon.
 * Sends the full job:payload with context and installation token.
 */
export function handleJobAccept(
  offerId: string,
  daemonId: string,
  installationToken: string,
  contextJson: Record<string, unknown>,
  maxTurns: number,
  allowedTools: string[],
): void {
  const offer = pendingOffers.get(offerId);
  if (offer === undefined) {
    logger.warn({ offerId, daemonId }, "Accept for unknown/expired offer");
    return;
  }

  // Clear timeout
  clearTimeout(offer.timer);
  pendingOffers.delete(offerId);

  const connections = getConnections();
  const ws = connections.get(daemonId);
  if (ws === undefined) {
    logger.error({ daemonId, offerId }, "Daemon disconnected before payload delivery");
    return;
  }

  // Send job:payload
  ws.sendText(
    JSON.stringify({
      type: "job:payload",
      ...createMessageEnvelope(offerId),
      payload: {
        context: contextJson,
        installationToken,
        maxTurns,
        allowedTools,
      },
    }),
  );

  logger.info({ deliveryId: offer.deliveryId, daemonId, offerId }, "Job payload sent to daemon");
}

/**
 * Handle a job:reject message from a daemon.
 * Re-queue the job for another daemon.
 */
export async function handleJobReject(
  offerId: string,
  reason: string,
): Promise<void> {
  const offer = pendingOffers.get(offerId);
  if (offer === undefined) {
    logger.warn({ offerId }, "Reject for unknown/expired offer");
    return;
  }

  clearTimeout(offer.timer);
  pendingOffers.delete(offerId);

  logger.info({ deliveryId: offer.deliveryId, daemonId: offer.daemonId, reason }, "Job rejected by daemon");

  // Re-queue the execution back to 'queued'
  await requeueExecution(offer.deliveryId);

  // Re-enqueue the job
  const job: QueuedJob = {
    deliveryId: offer.deliveryId,
    repoOwner: "", // Will be re-read from execution context on next dispatch
    repoName: "",
    entityNumber: 0,
    isPR: false,
    eventName: "",
    enqueuedAt: Date.now(),
    retryCount: offer.retryCount + 1,
  };

  const requeued = await requeueJob(job);
  if (!requeued) {
    await markExecutionFailed(
      offer.deliveryId,
      `All daemons rejected after maximum retries. Last reason: ${reason}`,
    );
  }
}
