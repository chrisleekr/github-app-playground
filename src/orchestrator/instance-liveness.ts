import { logger } from "../logger";
import { getInstanceId } from "./instance-id";
import { requireValkeyClient } from "./valkey";

const ALIVE_TTL_SECONDS = 60;
const REFRESH_INTERVAL_MS = 20_000;

let timer: ReturnType<typeof setInterval> | null = null;

/** Build the Valkey key for an instance's liveness flag. Exposed for the cross-instance reaper. */
export function instanceAliveKey(instanceId: string): string {
  return `orchestrator:${instanceId}:alive`;
}

async function publishAlive(instanceId: string): Promise<void> {
  const valkey = requireValkeyClient();
  await valkey.send("SET", [instanceAliveKey(instanceId), "1", "EX", String(ALIVE_TTL_SECONDS)]);
}

/**
 * Begin publishing this orchestrator's liveness key. Cross-instance reapers
 * use the absence of this key to identify dead instances whose per-instance
 * processing lists need to be drained back to the shared queue.
 *
 * Idempotent — calling twice does not start a second timer.
 */
export async function startInstanceHeartbeat(): Promise<void> {
  if (timer !== null) return;
  const id = getInstanceId();
  // Set the timer BEFORE awaiting so a concurrent call early-returns — avoids
  // both a duplicate interval and the require-atomic-updates lint flag.
  timer = setInterval(() => {
    void publishAlive(id).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), instanceId: id },
        "Failed to refresh orchestrator liveness key — reaper may treat this instance as dead",
      );
    });
  }, REFRESH_INTERVAL_MS);
  try {
    await publishAlive(id);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), instanceId: id },
      "Initial liveness publish failed — interval will retry",
    );
  }
  logger.info({ instanceId: id, ttlSeconds: ALIVE_TTL_SECONDS }, "Orchestrator heartbeat started");
}

/**
 * Stop the heartbeat and remove the liveness key so the cross-instance reaper
 * can immediately recover any orphaned processing-list items rather than
 * waiting for TTL expiry.
 */
export async function stopInstanceHeartbeat(): Promise<void> {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  try {
    const valkey = requireValkeyClient();
    await valkey.send("DEL", [instanceAliveKey(getInstanceId())]);
  } catch (err) {
    // Valkey may already be closed during late shutdown — that's fine,
    // the key will TTL out within 60s and the reaper handles it.
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "Could not delete orchestrator liveness key on shutdown",
    );
  }
}
