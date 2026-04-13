import type { ActiveJob, DaemonCapabilities } from "../shared/daemon-types";
import { createMessageEnvelope, type HeartbeatPingMessage } from "../shared/ws-messages";
import { discoverCapabilities,getCurrentResources } from "./tool-discovery";

/** Counter for periodic full capability rescan (every 10th heartbeat). */
let heartbeatCount = 0;

/**
 * Build a heartbeat:pong response with real-time resource data.
 * Every 10th heartbeat triggers a full capability rescan (R-007).
 */
export async function buildHeartbeatPong(
  ping: HeartbeatPingMessage,
  activeJobs: ActiveJob[],
  capabilities: DaemonCapabilities,
  cloneBaseDir: string,
): Promise<{ pong: unknown; updatedCapabilities: DaemonCapabilities }> {
  heartbeatCount++;

  let updatedCapabilities = capabilities;

  // Full capability rescan every 10th heartbeat
  if (heartbeatCount % 10 === 0) {
    updatedCapabilities = await discoverCapabilities(cloneBaseDir);
  } else {
    // Just update resource snapshot
    updatedCapabilities = {
      ...capabilities,
      resources: getCurrentResources(),
    };
  }

  const pong = {
    type: "heartbeat:pong" as const,
    ...createMessageEnvelope(ping.id),
    payload: {
      activeJobs: activeJobs.length,
      resources: updatedCapabilities.resources,
    },
  };

  return { pong, updatedCapabilities };
}
