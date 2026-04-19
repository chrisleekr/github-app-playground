/**
 * Ephemeral-daemon scaling decisions.
 *
 * Given the current fleet signals (queue length, free slots in the
 * persistent pool) and the triage verdict (`heavy`), decide whether the
 * orchestrator should spawn an ephemeral daemon Pod to absorb the job.
 *
 * Rate-limited by a cooldown window so a burst of events doesn't spawn
 * an equivalent burst of Pods — during cooldown, heavy/overflow signals
 * fall back to persistent-daemon routing and the job simply waits.
 */

import { config } from "../config";

export type EphemeralSpawnVerdict =
  | { readonly spawn: true; readonly trigger: "triage-heavy" | "queue-overflow" }
  | { readonly spawn: false; readonly skipReason: "cooldown" | "no-signal" };

export interface EphemeralSpawnInput {
  readonly heavy: boolean;
  readonly queueLength: number;
  readonly persistentFreeSlots: number;
  readonly now: number;
}

/**
 * Last-spawn timestamp (ms since epoch). Module-level so decisions
 * across webhook handlers share one cooldown window. Pure-function
 * callers update this via `markSpawn(now)` only when a spawn actually
 * succeeded — a *decision* to spawn that then fails at K8s time does
 * not burn the cooldown.
 */
let lastSpawnAtMs = 0;

export function decideEphemeralSpawn(input: EphemeralSpawnInput): EphemeralSpawnVerdict {
  const { heavy, queueLength, persistentFreeSlots, now } = input;
  const threshold = config.ephemeralDaemonSpawnQueueThreshold;
  const cooldownMs = config.ephemeralDaemonSpawnCooldownMs;

  // An overflow signal fires only when the persistent pool is saturated —
  // queue depth alone is not enough when daemons are still idle.
  const overflow = queueLength >= threshold && persistentFreeSlots <= 0;
  const hasSignal = heavy || overflow;

  if (!hasSignal) {
    return { spawn: false, skipReason: "no-signal" };
  }

  if (now - lastSpawnAtMs < cooldownMs) {
    return { spawn: false, skipReason: "cooldown" };
  }

  // Heavy wins over overflow when both fire — heavy is a per-request
  // signal, overflow is a fleet-level signal, and the reason is more
  // useful for telemetry when both are true.
  return {
    spawn: true,
    trigger: heavy ? "triage-heavy" : "queue-overflow",
  };
}

/**
 * Record that an ephemeral daemon was successfully spawned. Call this
 * only after the K8s API call succeeds, so a transient spawn failure
 * does not block the next legitimate attempt.
 */
export function markSpawn(now: number): void {
  lastSpawnAtMs = now;
}

/** Test-only: reset the module-level cooldown state between test cases. */
export function _resetEphemeralScalerForTests(): void {
  lastSpawnAtMs = 0;
}
