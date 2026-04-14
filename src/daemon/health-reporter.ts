import type { DaemonCapabilities } from "../shared/daemon-types";
import { createMessageEnvelope, type HeartbeatPingMessage } from "../shared/ws-messages";
import { discoverCapabilities, getCurrentResources } from "./tool-discovery";

let heartbeatCount = 0;

/**
 * Build heartbeat:pong with live resources; triggers full rescan per R-007.
 */
export async function buildHeartbeatPong(
  ping: HeartbeatPingMessage,
  activeJobCount: number,
  capabilities: DaemonCapabilities,
  cloneBaseDir: string,
): Promise<{ pong: unknown; updatedCapabilities: DaemonCapabilities }> {
  heartbeatCount++;

  let updatedCapabilities = capabilities;

  if (heartbeatCount % 10 === 0) {
    updatedCapabilities = await discoverCapabilities(cloneBaseDir);
  } else {
    updatedCapabilities = {
      ...capabilities,
      resources: getCurrentResources(),
    };
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
