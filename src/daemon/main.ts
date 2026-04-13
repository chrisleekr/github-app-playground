import { hostname, platform } from "node:os";

import { config } from "../config";
import { logger } from "../logger";
import type { DaemonCapabilities } from "../shared/daemon-types";
import { createMessageEnvelope, type ServerMessage } from "../shared/ws-messages";
import { buildHeartbeatPong } from "./health-reporter";
import {
  evaluateOffer,
  executeJob,
  getActiveJobCount,
  getActiveJobs,
  handleJobCancel,
  registerExitCleanup,
} from "./job-executor";
import { discoverCapabilities, getCurrentResources } from "./tool-discovery";
import { DaemonWsClient } from "./ws-client";

// ---------------------------------------------------------------------------
// Daemon ID generation
// ---------------------------------------------------------------------------

const daemonId = `daemon-${hostname()}-${process.pid}`;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let capabilities: DaemonCapabilities;
let wsClient: DaemonWsClient;
let draining = false;
let spotCheckInterval: Timer | null = null;

// ---------------------------------------------------------------------------
// Platform-aware drain timeout (T040, FM-10)
// ---------------------------------------------------------------------------

async function detectPlatformTerminationDeadline(): Promise<number> {
  // AWS Spot: 2-minute warning
  try {
    const resp = await fetch("http://169.254.169.254/latest/meta-data/instance-life-cycle", {
      signal: AbortSignal.timeout(500),
    });
    if (resp.ok && (await resp.text()) === "spot") return 120_000;
  } catch {
    /* not on AWS */
  }

  // GCP Preemptible: 30-second warning
  try {
    const resp = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/scheduling/preemptible",
      { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(500) },
    );
    if (resp.ok && (await resp.text()) === "TRUE") return 30_000;
  } catch {
    /* not on GCP */
  }

  return Infinity; // Not on ephemeral infrastructure
}

// ---------------------------------------------------------------------------
// Graceful shutdown (T039, FM-5)
// ---------------------------------------------------------------------------

let effectiveDrainTimeout: number;

function initiateGracefulShutdown(reason: string): void {
  if (draining) return;
  draining = true;

  logger.info({ reason, activeJobs: getActiveJobCount() }, "Initiating graceful shutdown");

  // Send daemon:draining
  wsClient.send({
    type: "daemon:draining",
    ...createMessageEnvelope(),
    payload: {
      activeJobs: getActiveJobCount(),
      reason,
    },
  });

  // Wait for active jobs to complete or drain timeout
  const drainStart = Date.now();

  const checkInterval = setInterval(() => {
    if (getActiveJobCount() === 0) {
      clearInterval(checkInterval);
      logger.info("All active jobs completed — shutting down");
      wsClient.close(1000, "graceful shutdown");
      process.exit(0);
    }

    if (Date.now() - drainStart > effectiveDrainTimeout) {
      clearInterval(checkInterval);
      logger.warn(
        { activeJobs: getActiveJobCount() },
        "Drain timeout expired with active jobs — forcing shutdown",
      );
      wsClient.close(1000, "graceful shutdown (timeout)");
      process.exit(1);
    }
  }, 1000);
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

function handleMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case "daemon:registered":
      logger.info(
        {
          heartbeatIntervalMs: msg.payload.heartbeatIntervalMs,
          offerTimeoutMs: msg.payload.offerTimeoutMs,
        },
        "Registered with orchestrator",
      );
      break;

    case "heartbeat:ping": {
      const currentCapabilities = capabilities;
      void (async () => {
        const { pong, updatedCapabilities } = await buildHeartbeatPong(
          msg,
          getActiveJobs(),
          currentCapabilities,
          config.cloneBaseDir,
        );
        capabilities = updatedCapabilities;
        wsClient.send(pong);
      })();
      break;
    }

    case "job:offer": {
      if (draining) {
        wsClient.send({
          type: "job:reject",
          ...createMessageEnvelope(msg.id),
          payload: { reason: "daemon is draining" },
        });
        return;
      }

      // Update resources for fresh evaluation
      capabilities = { ...capabilities, resources: getCurrentResources() };
      const evaluation = evaluateOffer(msg, capabilities);

      if (evaluation.accept) {
        wsClient.send({
          type: "job:accept",
          ...createMessageEnvelope(msg.id),
          payload: {},
        });
      } else {
        wsClient.send({
          type: "job:reject",
          ...createMessageEnvelope(msg.id),
          payload: { reason: evaluation.reason ?? "unknown" },
        });
      }
      break;
    }

    case "job:payload":
      void executeJob(msg, capabilities, (m) => { wsClient.send(m); });
      break;

    case "job:cancel":
      handleJobCancel(msg, (m) => { wsClient.send(m); });
      break;

    case "daemon:update-required":
      handleUpdateRequired(msg);
      break;

    case "error":
      logger.error(
        { code: msg.payload.code, message: msg.payload.message },
        "Error from orchestrator",
      );
      break;
  }
}

// ---------------------------------------------------------------------------
// Update handler (T044, R-016)
// ---------------------------------------------------------------------------

function handleUpdateRequired(
  msg: Extract<ServerMessage, { type: "daemon:update-required" }>,
): void {
  const strategy = config.daemonUpdateStrategy;
  const baseDelay = config.daemonUpdateDelayMs;
  // Jitter: random 0-30s to prevent thundering herd
  const jitter = Math.round(Math.random() * 30_000);
  const delayMs = baseDelay + jitter;

  logger.warn(
    {
      targetVersion: msg.payload.targetVersion,
      reason: msg.payload.reason,
      urgent: msg.payload.urgent,
      strategy,
      delayMs,
    },
    "Update required by orchestrator",
  );

  // Send acknowledgement
  wsClient.send({
    type: "daemon:update-acknowledged",
    ...createMessageEnvelope(msg.id),
    payload: { strategy, delayMs },
  });

  // Schedule drain after delay
  setTimeout(() => {
    initiateGracefulShutdown(`auto-update to ${msg.payload.targetVersion}`);
  }, msg.payload.urgent ? 0 : delayMs);
}

// ---------------------------------------------------------------------------
// Spot termination notice polling (T041, FM-10)
// ---------------------------------------------------------------------------

function startSpotTerminationPolling(): void {
  if (!capabilities.ephemeral || platform() !== "linux") return;

  spotCheckInterval = setInterval(() => {
    void (async () => {
      try {
        const resp = await fetch(
          "http://169.254.169.254/latest/meta-data/spot/instance-action",
          { signal: AbortSignal.timeout(1000) },
        );
        if (resp.ok) {
          logger.warn("Spot termination notice detected — initiating graceful drain");
          if (spotCheckInterval !== null) {
            clearInterval(spotCheckInterval);
            spotCheckInterval = null;
          }
          initiateGracefulShutdown("spot termination notice");
        }
      } catch {
        // 404 = no termination pending, network error = ignore
      }
    })();
  }, 5_000);
  // Don't keep process alive just for spot polling
  spotCheckInterval.unref();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  logger.info({ daemonId }, "Daemon starting");

  // Register exit cleanup handler (FM-9)
  registerExitCleanup();

  // Discover capabilities
  capabilities = await discoverCapabilities(config.cloneBaseDir);
  logger.info(
    {
      platform: capabilities.platform,
      cliTools: capabilities.cliTools.filter((t) => t.functional).map((t) => t.name),
      ephemeral: capabilities.ephemeral,
    },
    "Capabilities discovered",
  );

  // Compute effective drain timeout (T040)
  const platformDeadline = await detectPlatformTerminationDeadline();
  effectiveDrainTimeout = Math.min(
    config.daemonDrainTimeoutMs,
    platformDeadline === Infinity ? config.daemonDrainTimeoutMs : platformDeadline - 10_000,
  );
  logger.info({ effectiveDrainTimeout, platformDeadline }, "Drain timeout configured");

  // Validate orchestrator URL
  const orchestratorUrl = config.orchestratorUrl;
  if (orchestratorUrl === undefined) {
    logger.error("ORCHESTRATOR_URL is required for daemon mode");
    process.exit(1);
  }

  const authToken = config.daemonAuthToken;
  if (authToken === undefined) {
    logger.error("DAEMON_AUTH_TOKEN is required for daemon mode");
    process.exit(1);
  }

  // Connect to orchestrator
  wsClient = new DaemonWsClient({
    orchestratorUrl,
    authToken,
    daemonId,
    capabilities,
    onMessage: handleMessage,
    onConnected: () => {
      logger.info("Connected to orchestrator");
    },
    onDisconnected: () => {
      logger.info("Disconnected from orchestrator");
    },
  });

  wsClient.connect();

  // Start spot termination polling if on ephemeral infrastructure
  startSpotTerminationPolling();

  // Signal handlers (FM-5)
  process.on("SIGTERM", () => {
    initiateGracefulShutdown("SIGTERM received");
  });
  process.on("SIGINT", () => {
    initiateGracefulShutdown("SIGINT received");
  });
}

void main().catch((err: unknown) => {
  logger.error({ err }, "Daemon startup failed");
  process.exit(1);
});
