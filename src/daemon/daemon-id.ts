import { hostname } from "node:os";

let cached: string | undefined;

/**
 * Stable identifier for this daemon process. Matches the format used by
 * `src/daemon/main.ts` so the value the daemon registers with the
 * orchestrator (and publishes its Valkey heartbeat under) is the same value
 * `workflow-executor` writes to `workflow_runs.owner_id`.
 *
 * The liveness reaper resolves the heartbeat key as `daemon:{owner_id}`.
 */
export function getDaemonId(): string {
  if (cached !== undefined) return cached;
  cached = `daemon-${hostname()}-${String(process.pid)}`;
  return cached;
}

/** Test-only: clear the cached value so a fresh hostname/pid is read. */
export function resetDaemonIdForTests(): void {
  cached = undefined;
}
