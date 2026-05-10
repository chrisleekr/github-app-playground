import { logger } from "../logger";
import type { DaemonCapabilities } from "../shared/daemon-types";
import { createMessageEnvelope, type HeartbeatPingMessage } from "../shared/ws-messages";
import { discoverCapabilities, getCurrentResources } from "./tool-discovery";

let heartbeatCount = 0;

/**
 * Build heartbeat:pong with live resources; triggers full rescan per R-007.
 *
 * Rescan failures fall back to last-known capabilities with refreshed
 * resources, so a transient error cannot drop the pong and get the daemon
 * marked offline by the orchestrator.
 */
export async function buildHeartbeatPong(
  ping: HeartbeatPingMessage,
  activeJobCount: number,
  capabilities: DaemonCapabilities,
  cloneBaseDir: string,
): Promise<{ pong: unknown; updatedCapabilities: DaemonCapabilities }> {
  heartbeatCount++;

  let updatedCapabilities: DaemonCapabilities = {
    ...capabilities,
    resources: getCurrentResources(),
  };

  if (heartbeatCount % 10 === 0) {
    try {
      updatedCapabilities = await discoverCapabilities(cloneBaseDir);
    } catch (err) {
      logger.warn(
        { err },
        "Capability rescan failed during heartbeat, keeping last-known capabilities",
      );
    }
  }

  const pong = {
    type: "heartbeat:pong" as const,
    ...createMessageEnvelope(ping.id),
    payload: {
      activeJobs: activeJobCount,
      resources: updatedCapabilities.resources,
    },
  };

  return { pong, updatedCapabilities };
}
