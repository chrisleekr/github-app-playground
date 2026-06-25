/**
 * Ephemeral-daemon scaling decisions.
 *
 * Given the current fleet signals (queue length, free slots in the
 * persistent pool) and the triage verdict (`heavy`), decide whether the
 * orchestrator should spawn an ephemeral daemon Pod to absorb the job.
 *
 * Rate-limited by a cooldown window so a burst of events doesn't spawn
 * an equivalent burst of Pods: during cooldown, heavy/overflow signals
 * fall back to persistent-daemon routing and the job simply waits.
 */

import { config } from "../config";
import type { Logger } from "../logger";
import { K8S_SPAWN_LOG_EVENTS } from "./k8s-spawn-log-fields";

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
 * succeeded: a *decision* to spawn that then fails at K8s time does
 * not burn the cooldown.
 */
let lastSpawnAtMs = 0;

/**
 * Optional observability handle for `decideEphemeralSpawn`. When supplied, a
 * skip verdict emits one `k8s.spawn.decision_skipped` line correlated to the
 * webhook delivery. Omitted in pure-logic unit tests.
 */
export interface EphemeralSpawnObservability {
  readonly log: Logger;
  readonly deliveryId: string;
}

export function decideEphemeralSpawn(
  input: EphemeralSpawnInput,
  obs?: EphemeralSpawnObservability,
): EphemeralSpawnVerdict {
  const { heavy, queueLength, persistentFreeSlots, now } = input;
  const threshold = config.ephemeralDaemonSpawnQueueThreshold;
  const cooldownMs = config.ephemeralDaemonSpawnCooldownMs;

  // An overflow signal fires only when the persistent pool is saturated,
  // queue depth alone is not enough when daemons are still idle.
  const overflow = queueLength >= threshold && persistentFreeSlots <= 0;
  const hasSignal = heavy || overflow;

  if (!hasSignal) {
    // Debug: fires on every webhook, so it stays off the default info stream.
    emitDecisionSkipped(obs, "no-signal", input);
    return { spawn: false, skipReason: "no-signal" };
  }

  if (now - lastSpawnAtMs < cooldownMs) {
    // Info: fires only under heavy/overflow traffic, the thundering-herd guard.
    emitDecisionSkipped(obs, "cooldown", input);
    return { spawn: false, skipReason: "cooldown" };
  }

  // Heavy wins over overflow when both fire, heavy is a per-request
  // signal, overflow is a fleet-level signal, and the reason is more
  // useful for telemetry when both are true.
  return {
    spawn: true,
    trigger: heavy ? "triage-heavy" : "queue-overflow",
  };
}

/**
 * Emit one `k8s.spawn.decision_skipped` line carrying the decision-time signals.
 * `no-signal` at debug (every webhook), `cooldown` at info (heavy traffic only).
 */
function emitDecisionSkipped(
  obs: EphemeralSpawnObservability | undefined,
  reason: "no-signal" | "cooldown",
  input: EphemeralSpawnInput,
): void {
  if (obs === undefined) return;
  const fields = {
    event: K8S_SPAWN_LOG_EVENTS.decisionSkipped,
    delivery_id: obs.deliveryId,
    reason,
    heavy: input.heavy,
    queue_length: input.queueLength,
    persistent_free_slots: input.persistentFreeSlots,
  };
  if (reason === "no-signal") {
    obs.log.debug(fields, "Ephemeral daemon spawn skipped");
  } else {
    obs.log.info(fields, "Ephemeral daemon spawn skipped");
  }
}

/**
 * Record that an ephemeral daemon was successfully spawned. Call this
 * only after the K8s API call succeeds, so a transient spawn failure
 * does not block the next legitimate attempt.
 */
export function markSpawn(now: number): void {
  lastSpawnAtMs = now;
}

/**
 * Release a cooldown reservation *only* if it still matches the caller's
 * attempt timestamp. If a newer reservation has already overtaken it (e.g.
 * a later spawn won the race while this one's K8s call was still in
 * flight), leave the newer timestamp in place. An unconditional reset
 * would reopen the thundering-herd window the cooldown is meant to close.
 */
export function rollbackSpawn(expectedTimestampMs: number): void {
  if (lastSpawnAtMs === expectedTimestampMs) {
    lastSpawnAtMs = 0;
  }
}

/** Test-only: reset the module-level cooldown state between test cases. */
export function _resetEphemeralScalerForTests(): void {
  lastSpawnAtMs = 0;
}
