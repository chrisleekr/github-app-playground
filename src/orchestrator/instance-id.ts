import { hostname } from "node:os";

let cached: string | undefined;

/**
 * Stable identifier for this orchestrator process within the fleet.
 *
 * In Kubernetes the container's `hostname()` is the pod name (set by the
 * kubelet), which is unique across the fleet for the pod's lifetime. That's
 * what we want for namespacing the per-instance Valkey processing list and
 * the orchestrator liveness key.
 *
 * In non-production (local dev, tests) `pid` is appended so two `bun run start`
 * processes on the same host don't collide on those keys.
 */
export function getInstanceId(): string {
  if (cached !== undefined) return cached;
  const base = hostname();
  cached = process.env.NODE_ENV === "production" ? base : `${base}-${String(process.pid)}`;
  return cached;
}

/** Test-only: clear the cached value so a fresh hostname/pid is read. */
export function resetInstanceIdForTests(): void {
  cached = undefined;
}
