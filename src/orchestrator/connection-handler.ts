import type { ServerWebSocket } from "bun";

import { config } from "../config";
import { logger } from "../logger";
import type { DaemonInfo, HeartbeatState } from "../shared/daemon-types";
import {
  createMessageEnvelope,
  type DaemonMessage,
  WS_CLOSE_CODES,
  WS_ERROR_CODES,
} from "../shared/ws-messages";
import {
  decrementDaemonActiveJobs,
  deregisterDaemon,
  incrementDaemonActiveJobs,
  refreshDaemonTtl,
  registerDaemon,
} from "./daemon-registry";
import {
  getExecutionState,
  getOrphanedExecutions,
  markExecutionCompleted,
  markExecutionFailed,
  markExecutionRunning,
} from "./history";
import { getPendingOffer,handleJobAccept, handleJobReject, removePendingOffer } from "./job-dispatcher";
import { sendError, type WsConnectionData } from "./ws-server";

// ---------------------------------------------------------------------------
// In-memory state (per orchestrator process)
// ---------------------------------------------------------------------------

/** Active WebSocket connections keyed by daemon ID. */
const connections = new Map<string, ServerWebSocket<WsConnectionData>>();

/** Daemon info keyed by daemon ID. */
const daemonInfoMap = new Map<string, DaemonInfo>();

/** Per-daemon heartbeat timers. */
const heartbeatTimers = new Map<string, HeartbeatState>();

/** Daemon IDs that sent daemon:draining — excluded from dispatch. */
const drainingDaemons = new Set<string>();

// ---------------------------------------------------------------------------
// Exports for other orchestrator modules
// ---------------------------------------------------------------------------

export function getConnections(): Map<string, ServerWebSocket<WsConnectionData>> {
  return connections;
}

export function getDaemonInfo(daemonId: string): DaemonInfo | undefined {
  return daemonInfoMap.get(daemonId);
}

export function isDaemonDraining(daemonId: string): boolean {
  return drainingDaemons.has(daemonId);
}

// ---------------------------------------------------------------------------
// WebSocket event handlers (called from ws-server.ts)
// ---------------------------------------------------------------------------

/** Called when a new WebSocket connection opens. */
export function handleWsOpen(_ws: ServerWebSocket<WsConnectionData>): void {
  // No-op until daemon:register is received
}

/** Called when a WebSocket connection closes (FM-1 cleanup). */
export function handleWsClose(
  ws: ServerWebSocket<WsConnectionData>,
  _code: number,
  _reason: string,
): void {
  const daemonId = ws.data.daemonId;
  if (daemonId === undefined) return;

  // Clear heartbeat timers
  const hb = heartbeatTimers.get(daemonId);
  if (hb !== undefined) {
    clearInterval(hb.intervalTimer);
    if (hb.pongTimer !== null) clearTimeout(hb.pongTimer);
    heartbeatTimers.delete(daemonId);
  }

  // Remove from in-memory state
  connections.delete(daemonId);
  daemonInfoMap.delete(daemonId);
  drainingDaemons.delete(daemonId);

  // Async cleanup: deregister from Valkey/Postgres, handle orphaned executions
  void cleanupAfterDisconnect(daemonId);
}

/**
 * Async cleanup after daemon disconnect (FM-1).
 * Deregisters daemon and marks orphaned executions as failed.
 */
async function cleanupAfterDisconnect(daemonId: string): Promise<void> {
  try {
    await deregisterDaemon(daemonId);

    // Scan for orphaned executions
    const orphans = await getOrphanedExecutions(daemonId);
    for (const orphan of orphans) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await markExecutionFailed(orphan.deliveryId, "daemon disconnected during execution");
      } catch (err) {
        logger.error({ err, deliveryId: orphan.deliveryId }, "Failed to mark orphaned execution as failed");
      }
    }

    if (orphans.length > 0) {
      logger.warn({ daemonId, orphanCount: orphans.length }, "Cleaned up orphaned executions after daemon disconnect");
    }
  } catch (err) {
    logger.error({ err, daemonId }, "Failed to cleanup after daemon disconnect");
  }
}

/** Main message dispatch — called from ws-server.ts after validation. */
export function handleDaemonMessage(
  ws: ServerWebSocket<WsConnectionData>,
  msg: DaemonMessage,
): void {
  switch (msg.type) {
    case "daemon:register":
      void handleRegister(ws, msg);
      break;
    case "heartbeat:pong":
      handleHeartbeatPong(ws, msg);
      break;
    case "daemon:draining":
      handleDraining(ws, msg);
      break;
    case "daemon:update-acknowledged":
      handleUpdateAcknowledged(ws, msg);
      break;
    case "job:accept":
    case "job:reject":
    case "job:status":
    case "job:result":
      // Dispatched to job-dispatcher in Phase 4/5
      handleJobMessage(ws, msg);
      break;
  }
}

// ---------------------------------------------------------------------------
// daemon:register handler (FM-8 reconnection logic)
// ---------------------------------------------------------------------------

async function handleRegister(
  ws: ServerWebSocket<WsConnectionData>,
  msg: Extract<DaemonMessage, { type: "daemon:register" }>,
): Promise<void> {
  const { daemonId } = msg.payload;

  // FM-8: Check for existing connection with same daemon ID
  const existing = connections.get(daemonId);
  if (existing !== undefined) {
    logger.info({ daemonId }, "Daemon reconnected — closing old connection (FM-8)");
    existing.close(WS_CLOSE_CODES.SUPERSEDED.code, WS_CLOSE_CODES.SUPERSEDED.reason);

    // Clean up old connection state
    const oldHb = heartbeatTimers.get(daemonId);
    if (oldHb !== undefined) {
      clearInterval(oldHb.intervalTimer);
      if (oldHb.pongTimer !== null) clearTimeout(oldHb.pongTimer);
      heartbeatTimers.delete(daemonId);
    }
    connections.delete(daemonId);
    drainingDaemons.delete(daemonId);

    // Clean orphaned executions from previous session
    const orphans = await getOrphanedExecutions(daemonId);
    for (const orphan of orphans) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await markExecutionFailed(orphan.deliveryId, "daemon reconnected — previous session orphaned");
      } catch (err) {
        logger.error({ err, deliveryId: orphan.deliveryId }, "Failed to mark orphaned execution");
      }
    }
  }

  // Version compatibility check (T042, Phase 7 — basic check here)
  // Major protocol version mismatch -> reject
  const ourMajor = "1";
  const theirMajor = msg.payload.protocolVersion.split(".")[0];
  if (theirMajor !== ourMajor) {
    ws.close(
      WS_CLOSE_CODES.INCOMPATIBLE_PROTOCOL.code,
      WS_CLOSE_CODES.INCOMPATIBLE_PROTOCOL.reason,
    );
    return;
  }

  // Register in Valkey + Postgres
  try {
    const info = await registerDaemon(msg);
    daemonInfoMap.set(daemonId, info);
  } catch (err) {
    logger.error({ err, daemonId }, "Failed to register daemon");
    sendError(ws, msg.id, WS_ERROR_CODES.INTERNAL_ERROR, "Registration failed");
    return;
  }

  // Store connection
  ws.data.daemonId = daemonId;
  connections.set(daemonId, ws);

  // Send daemon:registered response
  ws.sendText(
    JSON.stringify({
      type: "daemon:registered",
      ...createMessageEnvelope(),
      payload: {
        heartbeatIntervalMs: config.heartbeatIntervalMs,
        offerTimeoutMs: config.offerTimeoutMs,
        maxRetries: config.jobMaxRetries,
      },
    }),
  );

  // Start heartbeat loop (FM-2)
  startHeartbeatLoop(ws, daemonId);

  logger.info(
    { daemonId, platform: msg.payload.platform, protocolVersion: msg.payload.protocolVersion },
    "Daemon registered",
  );
}

// ---------------------------------------------------------------------------
// Heartbeat loop (FM-2)
// ---------------------------------------------------------------------------

function startHeartbeatLoop(
  ws: ServerWebSocket<WsConnectionData>,
  daemonId: string,
): void {
  const state: HeartbeatState = {
    intervalTimer: setInterval(() => {
      sendHeartbeatPing(ws, daemonId);
    }, config.heartbeatIntervalMs),
    pongTimer: null,
    awaitingPong: false,
    missedPongs: 0,
  };

  heartbeatTimers.set(daemonId, state);
}

function sendHeartbeatPing(
  ws: ServerWebSocket<WsConnectionData>,
  daemonId: string,
): void {
  const state = heartbeatTimers.get(daemonId);
  if (state === undefined) return;

  if (state.awaitingPong) {
    // Already waiting for a pong — this means we missed one
    state.missedPongs++;
    logger.warn({ daemonId, missedPongs: state.missedPongs }, "Heartbeat pong not received");
  }

  state.awaitingPong = true;

  ws.sendText(
    JSON.stringify({
      type: "heartbeat:ping",
      ...createMessageEnvelope(),
      payload: {},
    }),
  );

  // Start pong timeout
  if (state.pongTimer !== null) clearTimeout(state.pongTimer);
  state.pongTimer = setTimeout(() => {
    logger.warn({ daemonId }, "Heartbeat timeout — closing connection (FM-2)");
    ws.close(WS_CLOSE_CODES.HEARTBEAT_TIMEOUT.code, WS_CLOSE_CODES.HEARTBEAT_TIMEOUT.reason);
  }, config.heartbeatTimeoutMs);
}

function handleHeartbeatPong(
  ws: ServerWebSocket<WsConnectionData>,
  msg: Extract<DaemonMessage, { type: "heartbeat:pong" }>,
): void {
  const daemonId = ws.data.daemonId;
  if (daemonId === undefined) return;

  const state = heartbeatTimers.get(daemonId);
  if (state === undefined) return;

  // Clear pong timeout
  if (state.pongTimer !== null) {
    clearTimeout(state.pongTimer);
    state.pongTimer = null;
  }
  state.awaitingPong = false;
  state.missedPongs = 0;

  // Refresh Valkey TTL
  const info = daemonInfoMap.get(daemonId);
  if (info !== undefined) {
    // Update resource snapshot from pong payload
    info.capabilities.resources = msg.payload.resources;
    info.activeJobs = msg.payload.activeJobs;
    info.lastSeenAt = Date.now();
    void refreshDaemonTtl(daemonId, info.capabilities);
  }
}

// ---------------------------------------------------------------------------
// daemon:draining handler
// ---------------------------------------------------------------------------

function handleDraining(
  ws: ServerWebSocket<WsConnectionData>,
  msg: Extract<DaemonMessage, { type: "daemon:draining" }>,
): void {
  const daemonId = ws.data.daemonId;
  if (daemonId === undefined) return;

  drainingDaemons.add(daemonId);
  const info = daemonInfoMap.get(daemonId);
  if (info !== undefined) {
    info.status = "draining";
  }

  logger.info(
    { daemonId, activeJobs: msg.payload.activeJobs, reason: msg.payload.reason },
    "Daemon draining — removed from dispatch eligibility",
  );
}

// ---------------------------------------------------------------------------
// daemon:update-acknowledged handler
// ---------------------------------------------------------------------------

function handleUpdateAcknowledged(
  ws: ServerWebSocket<WsConnectionData>,
  msg: Extract<DaemonMessage, { type: "daemon:update-acknowledged" }>,
): void {
  const daemonId = ws.data.daemonId;
  if (daemonId === undefined) return;

  const info = daemonInfoMap.get(daemonId);
  if (info !== undefined) {
    info.status = "updating";
  }

  logger.info(
    { daemonId, strategy: msg.payload.strategy, delayMs: msg.payload.delayMs },
    "Daemon acknowledged update",
  );
}

// ---------------------------------------------------------------------------
// Job message handling (T032-T033)
// ---------------------------------------------------------------------------

function handleJobMessage(
  ws: ServerWebSocket<WsConnectionData>,
  msg: DaemonMessage,
): void {
  const daemonId = ws.data.daemonId;
  if (daemonId === undefined) {
    sendError(ws, msg.id, WS_ERROR_CODES.INTERNAL_ERROR, "Daemon not registered");
    return;
  }

  switch (msg.type) {
    case "job:accept":
      void handleAccept(daemonId, msg);
      break;
    case "job:reject":
      void handleReject(msg);
      break;
    case "job:status":
      handleStatus(daemonId, msg);
      break;
    case "job:result":
      void handleResult(daemonId, msg);
      break;
    default:
      break;
  }
}

async function handleAccept(
  daemonId: string,
  msg: Extract<DaemonMessage, { type: "job:accept" }>,
): Promise<void> {
  const offerId = msg.id;
  const offer = getPendingOffer(offerId);
  if (offer === undefined) {
    logger.warn({ offerId, daemonId }, "Accept for unknown/expired offer");
    return;
  }

  // Increment active jobs in Valkey
  await incrementDaemonActiveJobs(daemonId);

  // Update execution status
  await markExecutionRunning(offer.deliveryId);

  // Get context from Postgres and send payload
  // For now, delegate to job-dispatcher which handles the full flow
  const { getDb } = await import("../db");
  const db = getDb();
  if (db !== null) {
    const rows: { context_json: Record<string, unknown> | null }[] = await db`
      SELECT context_json FROM executions WHERE delivery_id = ${offer.deliveryId}
    `;
    const firstRow = rows[0];
    if (rows.length > 0 && firstRow !== undefined && firstRow.context_json !== null) {
      const contextJson = firstRow.context_json;

      // Mint installation token
      // The octokit app auth creates short-lived tokens
      const { App } = await import("octokit");
      const { config } = await import("../config");
      const app = new App({
        appId: config.appId,
        privateKey: config.privateKey,
      });
      const owner = typeof contextJson["owner"] === "string" ? contextJson["owner"] : "";
      const repo = typeof contextJson["repo"] === "string" ? contextJson["repo"] : "";

      try {
        const { data: installation } = await app.octokit.rest.apps.getRepoInstallation({
          owner,
          repo,
        });
        const octokit = await app.getInstallationOctokit(installation.id);
        const { token } = (await octokit.auth({ type: "installation" })) as { token: string };

        const maxTurns = config.maxTurnsPerComplexity.complex;
        const { resolveAllowedTools } = await import("../core/prompt-builder");

        handleJobAccept(
          offerId,
          daemonId,
          token,
          contextJson,
          maxTurns,
          resolveAllowedTools(contextJson as never),
        );
      } catch (err) {
        logger.error({ err, offerId, daemonId }, "Failed to mint installation token for job");
        await markExecutionFailed(offer.deliveryId, "Failed to mint installation token");
        removePendingOffer(offerId);
      }
    }
  }
}

async function handleReject(
  msg: Extract<DaemonMessage, { type: "job:reject" }>,
): Promise<void> {
  await handleJobReject(msg.id, msg.payload.reason);
}

function handleStatus(
  daemonId: string,
  msg: Extract<DaemonMessage, { type: "job:status" }>,
): void {
  logger.info(
    { daemonId, offerId: msg.id, status: msg.payload.status, message: msg.payload.message },
    "Job status update from daemon",
  );
}

/**
 * Handle job:result — FM-6 late result guard + finalize execution.
 */
async function handleResult(
  daemonId: string,
  msg: Extract<DaemonMessage, { type: "job:result" }>,
): Promise<void> {
  const offerId = msg.id;
  const offer = getPendingOffer(offerId);
  const deliveryId = offer?.deliveryId;

  // Try to find the delivery ID from the pending offer or from execution records
  const actualDeliveryId = deliveryId;
  if (actualDeliveryId === undefined) {
    // Look up via offerId in execution records or just use daemon tracking
    logger.debug({ offerId, daemonId }, "Result for offer not in pending map — checking DB");
  }

  // Decrement active jobs
  await decrementDaemonActiveJobs(daemonId);

  // Remove pending offer if it still exists
  removePendingOffer(offerId);

  // FM-6: Late result guard — check if execution is already finalized
  if (actualDeliveryId !== undefined) {
    const state = await getExecutionState(actualDeliveryId);
    if (state !== null) {
      if (state.status === "completed" || state.status === "failed") {
        logger.info(
          { deliveryId: actualDeliveryId, daemonId, currentStatus: state.status },
          "Late result received for already-finalized execution (FM-6) — discarding",
        );
        return;
      }

      if (state.daemonId !== null && state.daemonId !== daemonId) {
        logger.info(
          { deliveryId: actualDeliveryId, daemonId, assignedDaemonId: state.daemonId },
          "Result from non-assigned daemon (FM-6) — discarding",
        );
        return;
      }
    }

    // Finalize execution
    if (msg.payload.success) {
      const result: { costUsd?: number; durationMs?: number; numTurns?: number } = {};
      if (msg.payload.costUsd !== undefined) result.costUsd = msg.payload.costUsd;
      if (msg.payload.durationMs !== undefined) result.durationMs = msg.payload.durationMs;
      if (msg.payload.numTurns !== undefined) result.numTurns = msg.payload.numTurns;
      await markExecutionCompleted(actualDeliveryId, result);
    } else {
      await markExecutionFailed(
        actualDeliveryId,
        msg.payload.errorMessage ?? "Execution failed on daemon",
      );
    }

    logger.info(
      {
        deliveryId: actualDeliveryId,
        daemonId,
        success: msg.payload.success,
        durationMs: msg.payload.durationMs,
        costUsd: msg.payload.costUsd,
      },
      "Job result received and recorded",
    );
  }
}
