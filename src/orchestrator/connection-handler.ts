import type { ServerWebSocket } from "bun";
import { App, type Octokit } from "octokit";

import { config } from "../config";
import { logger } from "../logger";
import { addReaction } from "../utils/reactions";
import { findById, findInflightByOwner, type WorkflowRunRow } from "../workflows/runs-store";
import { setState } from "../workflows/tracking-mirror";

// Read orchestrator app version at module load so we can detect daemon drift
// in handleRegister and request an update via daemon:update-required.
const ORCHESTRATOR_APP_VERSION: string = ((): string => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Bun supports require for JSON; dynamic import would be async
    const pkg = require("../../package.json") as { version: string };
    return pkg.version;
  } catch {
    return "0.0.0";
  }
})();

/** Parse a semver-ish version string into a [major, minor, patch] tuple. */
function parseVersion(v: string): [number, number, number] {
  const parts = v.split(".").map((p) => parseInt(p, 10));
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/** Return true if `daemon` is strictly older than `orchestrator`. */
function isDaemonOutdated(daemon: string, orchestrator: string): boolean {
  const [dMaj, dMin, dPatch] = parseVersion(daemon);
  const [oMaj, oMin, oPatch] = parseVersion(orchestrator);
  if (dMaj !== oMaj) return dMaj < oMaj;
  if (dMin !== oMin) return dMin < oMin;
  return dPatch < oPatch;
}
import type { DaemonInfo, HeartbeatState } from "../shared/daemon-types";
import {
  createMessageEnvelope,
  type DaemonMessage,
  WS_CLOSE_CODES,
  WS_ERROR_CODES,
} from "../shared/ws-messages";
import { decrementActiveCount, incrementActiveCount } from "./concurrency";
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
import {
  getPendingOffer,
  handleJobAccept,
  handleJobReject,
  removePendingOffer,
} from "./job-dispatcher";
import { sendError, type WsConnectionData } from "./ws-server";

// In-memory state (per orchestrator process)

const connections = new Map<string, ServerWebSocket<WsConnectionData>>();
const daemonInfoMap = new Map<string, DaemonInfo>();
const heartbeatTimers = new Map<string, HeartbeatState>();

/** Daemon IDs that sent daemon:draining — excluded from dispatch. */
const drainingDaemons = new Set<string>();

/** Cached Octokit App singleton for minting installation tokens. */
let cachedApp: InstanceType<typeof App> | null = null;
function getOrCreateApp(): InstanceType<typeof App> {
  if (cachedApp !== null) return cachedApp;
  if (config.appId === undefined || config.privateKey === undefined) {
    throw new Error("getOrCreateApp requires GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY");
  }
  cachedApp = new App({ appId: config.appId, privateKey: config.privateKey });
  return cachedApp;
}

// Exports for other orchestrator modules

export function getConnections(): Map<string, ServerWebSocket<WsConnectionData>> {
  return connections;
}

export function getDaemonInfo(daemonId: string): DaemonInfo | undefined {
  return daemonInfoMap.get(daemonId);
}

export function isDaemonDraining(daemonId: string): boolean {
  return drainingDaemons.has(daemonId);
}

// WebSocket event handlers (called from ws-server.ts)

export function handleWsOpen(_ws: ServerWebSocket<WsConnectionData>): void {
  // No-op until daemon:register is received
}

/** FM-1 cleanup on WebSocket close. */
export function handleWsClose(
  ws: ServerWebSocket<WsConnectionData>,
  _code: number,
  _reason: string,
): void {
  const daemonId = ws.data.daemonId;
  if (daemonId === undefined) return;

  const hb = heartbeatTimers.get(daemonId);
  if (hb !== undefined) {
    clearInterval(hb.intervalTimer);
    if (hb.pongTimer !== null) clearTimeout(hb.pongTimer);
    heartbeatTimers.delete(daemonId);
  }

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
        logger.error(
          { err, deliveryId: orphan.deliveryId },
          "Failed to mark orphaned execution as failed",
        );
      }
    }

    if (orphans.length > 0) {
      logger.warn(
        { daemonId, orphanCount: orphans.length },
        "Cleaned up orphaned executions after daemon disconnect",
      );
    }

    // User-facing notification: any in-flight workflow_runs owned by this
    // daemon will be flipped to 'failed' by the liveness reaper. We update
    // the user's tracking comment + react on the trigger comment now so the
    // user sees the failure immediately instead of staring at a stale
    // "starting…" comment.
    await notifyOrphanedWorkflowRuns(daemonId);
  } catch (err) {
    logger.error({ err, daemonId }, "Failed to cleanup after daemon disconnect");
  }
}

/**
 * Update the user-facing tracking comment + add a `confused` reaction on the
 * originating comment for every in-flight workflow_run owned by the dying
 * daemon. Walks the parent chain so a child step's failure shows up on the
 * top-level run's surface (the surface the user is actually watching) rather
 * than on a per-child comment they may not have noticed.
 *
 * Best-effort throughout — a missing GitHub App config or a comment-update
 * failure must never bubble up and prevent the rest of cleanup from running.
 */
async function notifyOrphanedWorkflowRuns(daemonId: string): Promise<void> {
  let inflight: WorkflowRunRow[];
  try {
    inflight = await findInflightByOwner("daemon", daemonId);
  } catch (err) {
    logger.error({ err, daemonId }, "Failed to query in-flight workflow_runs for orphan cleanup");
    return;
  }

  if (inflight.length === 0) return;

  // Dedupe by ancestor so a single ship cascade (ship → plan → implement)
  // only updates one comment + one reaction even if multiple of its rows
  // were owned by this daemon at the moment of disconnect.
  const ancestorIds = new Set<string>();
  for (const row of inflight) {
    // eslint-disable-next-line no-await-in-loop
    const ancestor = await findTopAncestor(row);
    if (ancestor === null) continue;
    if (ancestorIds.has(ancestor.id)) continue;
    ancestorIds.add(ancestor.id);

    try {
      // eslint-disable-next-line no-await-in-loop
      await postOrphanNotification(ancestor);
    } catch (err) {
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          ancestorRunId: ancestor.id,
          daemonId,
        },
        "Orphan notification (comment/reaction) failed",
      );
    }
  }
}

/**
 * Walk parent_run_id up to the topmost row. Returns the input row if it has
 * no parent, or null if the parent chain is broken (orphaned mid-walk) or
 * exceeds the safety cap. Returning the cap-iteration row would be a silent
 * bug: it still has a non-null parent_run_id, so we'd update the wrong
 * (mid-chain) tracking comment.
 */
async function findTopAncestor(row: WorkflowRunRow): Promise<WorkflowRunRow | null> {
  let current: WorkflowRunRow | null = row;
  // Bound at 8 levels of nesting — defensive cap for a chain that should
  // realistically never exceed depth 2 (ship → step). A null parent ends
  // the walk naturally.
  for (let i = 0; i < 8; i++) {
    if (current === null) return null;
    if (current.parent_run_id === null) return current;
    // eslint-disable-next-line no-await-in-loop
    current = await findById(current.parent_run_id);
  }
  logger.warn(
    { startRunId: row.id, lastSeenRunId: current?.id ?? null },
    "findTopAncestor: parent chain exceeded 8 levels — skipping orphan notification to avoid touching the wrong comment",
  );
  return null;
}

async function postOrphanNotification(ancestor: WorkflowRunRow): Promise<void> {
  if (config.appId === undefined || config.privateKey === undefined) {
    logger.debug(
      { ancestorRunId: ancestor.id },
      "Skipping orphan notification — GitHub App credentials not configured",
    );
    return;
  }

  const app = getOrCreateApp();
  const { data: installation } = await app.octokit.rest.apps.getRepoInstallation({
    owner: ancestor.target_owner,
    repo: ancestor.target_repo,
  });
  const octokit = await app.getInstallationOctokit(installation.id);

  const humanMessage = [
    `❌ **Daemon disconnected during execution** — likely an OOM kill on the workflow pod.`,
    ``,
    `The in-flight step has been marked failed. Its workflow_run row will be flipped`,
    `to \`failed\` by the liveness reaper. To resume, re-trigger the workflow:`,
    ``,
    `- For \`ship\`: re-apply the \`bot:ship\` label, or comment again. Resume picks up`,
    `  from the failed step and reuses prior succeeded steps.`,
    `- For standalone workflows: re-comment with the same trigger.`,
  ].join("\n");

  // Re-uses tracking-mirror.setState so the cascade refresh and `_lastHumanMessage`
  // bookkeeping stay consistent — and so the parent's composite body picks up the
  // failure narrative on the next render.
  const installationOctokit = octokit as unknown as Octokit;
  await setState(
    { octokit: installationOctokit, logger },
    {
      runId: ancestor.id,
      patch: { phase: "orphaned" },
      humanMessage,
    },
  );

  if (ancestor.trigger_comment_id !== null && ancestor.trigger_event_type !== null) {
    await addReaction({
      octokit: installationOctokit,
      logger,
      owner: ancestor.target_owner,
      repo: ancestor.target_repo,
      commentId: ancestor.trigger_comment_id,
      eventType: ancestor.trigger_event_type,
      content: "confused",
    });
  }
}

/** Route validated daemon messages to type-specific handlers. */
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
      handleJobMessage(ws, msg);
      break;
    case "scoped-job-completion":
      void handleScopedJobCompletion(ws, msg);
      break;
  }
}

// daemon:register handler (FM-8 reconnection logic)

async function handleRegister(
  ws: ServerWebSocket<WsConnectionData>,
  msg: Extract<DaemonMessage, { type: "daemon:register" }>,
): Promise<void> {
  const { daemonId } = msg.payload;

  // FM-8: Check for existing connection with same daemon ID
  const existing = connections.get(daemonId);
  if (existing !== undefined) {
    logger.info({ daemonId }, "Daemon reconnected — closing old connection (FM-8)");
    // Clear daemonId BEFORE close so handleWsClose's cleanup is a no-op,
    // preventing a race where deregisterDaemon runs after registerDaemon.
    existing.data.daemonId = undefined;
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
        await markExecutionFailed(
          orphan.deliveryId,
          "daemon reconnected — previous session orphaned",
        );
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

  ws.data.daemonId = daemonId;
  connections.set(daemonId, ws);

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
    {
      daemonId,
      platform: msg.payload.platform,
      protocolVersion: msg.payload.protocolVersion,
      appVersion: msg.payload.appVersion,
      orchestratorVersion: ORCHESTRATOR_APP_VERSION,
    },
    "Daemon registered",
  );

  // App-version drift: outdated daemons receive daemon:update-required so they
  // can apply the configured update strategy (exit / pull / notify). Newer
  // daemons are tolerated (e.g. mid-rollout) but logged for visibility.
  const daemonAppVersion = msg.payload.appVersion;
  if (daemonAppVersion !== ORCHESTRATOR_APP_VERSION) {
    if (isDaemonOutdated(daemonAppVersion, ORCHESTRATOR_APP_VERSION)) {
      logger.warn(
        { daemonId, daemonAppVersion, orchestratorVersion: ORCHESTRATOR_APP_VERSION },
        "Daemon appVersion is older than orchestrator — sending daemon:update-required",
      );
      ws.sendText(
        JSON.stringify({
          type: "daemon:update-required",
          ...createMessageEnvelope(),
          payload: {
            targetVersion: ORCHESTRATOR_APP_VERSION,
            reason: `Orchestrator is on ${ORCHESTRATOR_APP_VERSION}; daemon is on ${daemonAppVersion}`,
            urgent: false,
          },
        }),
      );
    } else {
      logger.info(
        { daemonId, daemonAppVersion, orchestratorVersion: ORCHESTRATOR_APP_VERSION },
        "Daemon appVersion is ahead of orchestrator — tolerating during rollout",
      );
    }
  }
}

// Heartbeat loop (FM-2)

function startHeartbeatLoop(ws: ServerWebSocket<WsConnectionData>, daemonId: string): void {
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

function sendHeartbeatPing(ws: ServerWebSocket<WsConnectionData>, daemonId: string): void {
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

  if (state.pongTimer !== null) {
    clearTimeout(state.pongTimer);
    state.pongTimer = null;
  }
  state.awaitingPong = false;
  state.missedPongs = 0;

  const info = daemonInfoMap.get(daemonId);
  if (info !== undefined) {
    info.capabilities.resources = msg.payload.resources;
    info.activeJobs = msg.payload.activeJobs;
    info.lastSeenAt = Date.now();
    void refreshDaemonTtl(daemonId, info.capabilities).catch((err: unknown) => {
      logger.error({ err, daemonId }, "Failed to refresh daemon TTL");
    });
  }
}

// daemon:draining handler

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

// daemon:update-acknowledged handler

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

// Job message handling (T032-T033)

/**
 * Server-side bridge for `scoped-job-completion` (T033b). The daemon
 * executor reports the structured outcome here; the orchestrator releases
 * the pending offer + capacity slot and emits a telemetry log line. The
 * user-facing Octokit reply is posted by the daemon executor itself
 * (using the installation token it already holds), so this handler
 * does not need to format another comment — doing so would double-post.
 *
 * Validation: payload arrives via the Zod discriminated union from
 * `serverMessageSchema` / `daemonMessageSchema` parse, so unknown
 * `jobKind` values are rejected at the WS boundary before reaching this
 * function.
 */
async function handleScopedJobCompletion(
  ws: ServerWebSocket<WsConnectionData>,
  msg: Extract<DaemonMessage, { type: "scoped-job-completion" }>,
): Promise<void> {
  const daemonId = ws.data.daemonId;
  const offerId = msg.payload.offerId;
  const { jobKind, status, deliveryId } = msg.payload;

  // Release the pending offer if still tracked. The offer may already be
  // gone if the daemon's earlier `job:accept` handler removed it (the
  // legacy non-scoped flow does), so this is best-effort.
  const offer = getPendingOffer(offerId);
  if (offer !== undefined) {
    removePendingOffer(offerId);
  }

  if (status === "succeeded") {
    logger.info(
      {
        event: `ship.scoped.${jobKind.replace("scoped-", "").replaceAll("-", "_")}.daemon.completed`,
        daemonId,
        offerId,
        deliveryId,
        jobKind,
      },
      "scoped-job daemon reported success",
    );
    await markExecutionFinalized(deliveryId, true);
    return;
  }

  // halted / failed paths: surface the reason as a structured log line so
  // operators can see why an executor halted without tailing the daemon
  // pod's stderr. Tracking-comment / thread-reply was already posted by
  // the daemon executor with the installation token.
  logger.warn(
    {
      event: `ship.scoped.${jobKind.replace("scoped-", "").replaceAll("-", "_")}.daemon.failed`,
      daemonId,
      offerId,
      deliveryId,
      jobKind,
      status,
      reason: msg.payload.reason ?? null,
    },
    "scoped-job daemon reported non-success",
  );
  await markExecutionFinalized(deliveryId, status === "halted");
}

/**
 * Drop a delivery from the in-memory offer map cleanly. Wraps the
 * existing `markExecutionFailed` / no-op for success so the scoped
 * completion path stays single-responsibility.
 */
async function markExecutionFinalized(deliveryId: string, success: boolean): Promise<void> {
  if (!success) {
    try {
      await markExecutionFailed(deliveryId, "scoped-job daemon halted/failed");
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), deliveryId },
        "markExecutionFailed for scoped completion failed (non-fatal)",
      );
    }
  }
}

function handleJobMessage(ws: ServerWebSocket<WsConnectionData>, msg: DaemonMessage): void {
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

  // C2: Immediately claim the offer and clear its timeout to prevent a race
  // where the timeout fires during async work below and re-queues the job.
  removePendingOffer(offerId);

  // Capacity slot is owned here: take one when the daemon claims, release
  // in handleResult or in the error paths below. Every accept path must
  // therefore decrement on failure to keep the counter balanced.
  incrementActiveCount();
  await incrementDaemonActiveJobs(daemonId);
  await markExecutionRunning(offer.deliveryId);

  const { getDb } = await import("../db");
  const db = getDb();
  if (db === null) {
    logger.error({ offerId, daemonId }, "Database not available for context lookup");
    await markExecutionFailed(offer.deliveryId, "Database unavailable");
    await decrementDaemonActiveJobs(daemonId);
    decrementActiveCount();
    return;
  }

  const rows: { context_json: Record<string, unknown> | null }[] = await db`
    SELECT context_json FROM executions WHERE delivery_id = ${offer.deliveryId}
  `;
  const contextJson = rows[0]?.context_json ?? null;
  logger.debug(
    {
      offerId,
      daemonId,
      deliveryId: offer.deliveryId,
      rowCount: rows.length,
      hasContextJson: contextJson !== null,
      contextKeys: contextJson !== null ? Object.keys(contextJson) : [],
    },
    "Accept: executions row lookup",
  );
  if (contextJson === null) {
    logger.error(
      {
        offerId,
        daemonId,
        deliveryId: offer.deliveryId,
        rowCount: rows.length,
        hint:
          rows.length === 0
            ? "no executions row for this deliveryId — producer did not call createExecution"
            : "executions row exists but context_json is NULL — row was written without context",
      },
      "No execution context found",
    );
    await markExecutionFailed(offer.deliveryId, "Execution context not found");
    await decrementDaemonActiveJobs(daemonId);
    decrementActiveCount();
    return;
  }
  const owner = typeof contextJson["owner"] === "string" ? contextJson["owner"] : "";
  const repo = typeof contextJson["repo"] === "string" ? contextJson["repo"] : "";

  try {
    // Mint installation token via cached App singleton (avoid per-request App instantiation)
    const app = getOrCreateApp();
    const { data: installation } = await app.octokit.rest.apps.getRepoInstallation({
      owner,
      repo,
    });
    const octokit = await app.getInstallationOctokit(installation.id);
    const { token } = (await octokit.auth({ type: "installation" })) as { token: string };

    // No turn cap by default: workflows must run end-to-end without losing
    // progress to a mid-run cap. `AGENT_MAX_TURNS` and `DEFAULT_MAXTURNS`
    // remain as opt-in escape hatches for ops; when both are unset we pass
    // `undefined` to the SDK and the agent decides when it's done.
    const maxTurns = config.agentMaxTurns ?? config.defaultMaxTurns;
    const { resolveAllowedTools } = await import("../core/prompt-builder");

    // Reconstruct a minimal BotContext-shaped object for resolveAllowedTools.
    // Only isPR and labels are read by the function.
    const ctxForTools = {
      isPR: contextJson["isPR"] === true,
      labels: Array.isArray(contextJson["labels"]) ? (contextJson["labels"] as string[]) : [],
    };

    // Look up daemon capabilities so repo_memory + daemon-specific tools are allowed
    const daemonInfo = getDaemonInfo(daemonId);

    // Load persistent repo knowledge for this owner/repo
    const { getRepoEnvVars, getRepoMemory } = await import("./repo-knowledge");
    const envVars = await getRepoEnvVars(owner, repo);
    const memory = await getRepoMemory(owner, repo);

    handleJobAccept({
      offerId,
      daemonId,
      deliveryId: offer.deliveryId,
      installationToken: token,
      contextJson,
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      allowedTools: resolveAllowedTools(
        ctxForTools as Parameters<typeof resolveAllowedTools>[0],
        daemonInfo?.capabilities,
      ),
      envVars,
      memory,
      ...(offer.workflowRun !== undefined ? { workflowRun: offer.workflowRun } : {}),
    });
  } catch (err) {
    logger.error({ err, offerId, daemonId }, "Failed to mint installation token for job");
    await markExecutionFailed(offer.deliveryId, "Failed to mint installation token");
    await decrementDaemonActiveJobs(daemonId);
    decrementActiveCount();
  }
}

async function handleReject(msg: Extract<DaemonMessage, { type: "job:reject" }>): Promise<void> {
  await handleJobReject(msg.id, msg.payload.reason);
}

function handleStatus(daemonId: string, msg: Extract<DaemonMessage, { type: "job:status" }>): void {
  logger.info(
    { daemonId, offerId: msg.id, status: msg.payload.status, message: msg.payload.message },
    "Job status update from daemon",
  );
}

/**
 * Resolve the deliveryId for a job result using a 3-tier strategy:
 * 1. Pending offer map (primary)
 * 2. Daemon-provided payload field (fallback)
 * 3. Database query for the daemon's running execution (last resort)
 */
async function resolveDeliveryId(
  offerId: string,
  daemonId: string,
  payloadDeliveryId: string | undefined,
): Promise<string | undefined> {
  const offer = getPendingOffer(offerId);
  const deliveryId = offer?.deliveryId ?? payloadDeliveryId;
  if (deliveryId !== undefined) return deliveryId;

  logger.debug({ offerId, daemonId }, "Result for offer not in pending map — querying DB");
  const { getDb } = await import("../db");
  const db = getDb();
  if (db === null) return undefined;

  const rows: { delivery_id: string }[] = await db`
    SELECT delivery_id FROM executions
    WHERE daemon_id = ${daemonId} AND status IN ('offered', 'running')
    ORDER BY started_at DESC NULLS LAST LIMIT 1
  `;
  const row = rows[0];
  if (row === undefined) return undefined;

  logger.info(
    { offerId, daemonId, deliveryId: row.delivery_id },
    "Resolved deliveryId from DB fallback",
  );
  return row.delivery_id;
}

/**
 * Persist learnings and deletions from a daemon execution to repo_memory.
 * Extracted to reduce nesting depth in handleResult.
 */
async function persistRepoKnowledge(
  deliveryId: string,
  learnings: { category: string; content: string }[] | undefined,
  deletions: string[] | undefined,
): Promise<void> {
  try {
    const { saveRepoLearnings, deleteRepoMemories } = await import("./repo-knowledge");
    const { requireDb } = await import("../db");
    const knowledgeDb = requireDb();
    const execRows: { repo_owner: string; repo_name: string }[] = await knowledgeDb`
      SELECT repo_owner, repo_name FROM executions WHERE delivery_id = ${deliveryId}
    `;
    const exec = execRows[0];
    if (exec === undefined) return;

    if (learnings !== undefined && learnings.length > 0) {
      const saved = await saveRepoLearnings(exec.repo_owner, exec.repo_name, learnings);
      if (saved > 0) {
        logger.info({ deliveryId, saved }, "Persisted repo learnings from execution");
      }
    }
    if (deletions !== undefined && deletions.length > 0) {
      const deleted = await deleteRepoMemories(deletions);
      if (deleted > 0) {
        logger.info({ deliveryId, deleted }, "Deleted outdated repo memories per daemon request");
      }
    }
  } catch (err) {
    logger.error({ err, deliveryId }, "Failed to persist repo knowledge");
  }
}

/** Persist execution outcome to the database. */
async function finalizeExecution(
  deliveryId: string,
  payload: {
    success: boolean;
    costUsd?: number | undefined;
    durationMs?: number | undefined;
    numTurns?: number | undefined;
    errorMessage?: string | undefined;
  },
): Promise<void> {
  if (payload.success) {
    const result: { costUsd?: number; durationMs?: number; numTurns?: number } = {};
    if (payload.costUsd !== undefined) result.costUsd = payload.costUsd;
    if (payload.durationMs !== undefined) result.durationMs = payload.durationMs;
    if (payload.numTurns !== undefined) result.numTurns = payload.numTurns;
    await markExecutionCompleted(deliveryId, result);
  } else {
    await markExecutionFailed(deliveryId, payload.errorMessage ?? "Execution failed on daemon");
  }
}

/**
 * Handle job:result — FM-6 late result guard + finalize execution.
 */
async function handleResult(
  daemonId: string,
  msg: Extract<DaemonMessage, { type: "job:result" }>,
): Promise<void> {
  const offerId = msg.id;
  const actualDeliveryId = await resolveDeliveryId(offerId, daemonId, msg.payload.deliveryId);

  // Decrement active jobs (daemon-side Valkey counter + webhook concurrency counter)
  await decrementDaemonActiveJobs(daemonId);
  decrementActiveCount();

  removePendingOffer(offerId);

  if (actualDeliveryId === undefined) return;

  // FM-6: Late result guard — check if execution is already finalized
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
  await finalizeExecution(actualDeliveryId, msg.payload);

  // Persist learnings and process deletions from daemon execution
  const learnings = msg.payload.learnings;
  const deletions = msg.payload.deletions;

  if (
    (learnings !== undefined && learnings.length > 0) ||
    (deletions !== undefined && deletions.length > 0)
  ) {
    await persistRepoKnowledge(actualDeliveryId, learnings, deletions);
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
