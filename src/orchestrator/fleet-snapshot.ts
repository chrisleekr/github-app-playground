/**
 * Periodic fleet-state gauge (issue #174).
 *
 * The orchestrator reads queue depth, daemon counts, and free/busy slots on
 * demand (only when a webhook arrives, inside `decideDispatch`), then discards
 * them. If no webhook arrives for a while, an operator has zero log-visible
 * signal on whether the queue is backing up or the persistent pool is
 * saturated. This timer samples those gauges on a fixed cadence and emits one
 * structured `fleet.snapshot` line so backlog/saturation are always graphable.
 *
 * Lifecycle mirrors `instance-liveness.ts`: idempotent start, explicit stop.
 */
import { z } from "zod";

import { logger } from "../logger";
import {
  getActiveDaemons,
  getDaemonActiveJobs,
  getPersistentPoolFreeSlots,
} from "./daemon-registry";
import { getQueueLength } from "./job-queue";

const DEFAULT_INTERVAL_MS = 30_000;
const MIN_INTERVAL_MS = 10_000;
const MAX_INTERVAL_MS = 300_000;

export const FLEET_SNAPSHOT_EVENT = "fleet.snapshot";

/** `.strict()` shape for the gauge line so the emitter cannot drift. */
export const FleetSnapshotLogSchema = z
  .object({
    event: z.literal(FLEET_SNAPSHOT_EVENT),
    queue_depth: z.number().int().nonnegative(),
    active_daemons_total: z.number().int().nonnegative(),
    busy_slots_total: z.number().int().nonnegative(),
    persistent_free_slots: z.number().int().nonnegative(),
  })
  .strict();

export type FleetSnapshotLog = z.infer<typeof FleetSnapshotLogSchema>;

/**
 * The Valkey read helpers the sampler needs. Injectable so the test can pass
 * stubs without process-wide `mock.module` (which would pollute sibling
 * orchestrator tests that use the real modules).
 */
export interface FleetReaders {
  getQueueLength: () => Promise<number>;
  getActiveDaemons: () => Promise<string[]>;
  getDaemonActiveJobs: (daemonId: string) => Promise<number>;
  getPersistentPoolFreeSlots: () => Promise<number>;
}

const defaultReaders: FleetReaders = {
  getQueueLength,
  getActiveDaemons,
  getDaemonActiveJobs,
  getPersistentPoolFreeSlots,
};

let timer: ReturnType<typeof setInterval> | null = null;

function clampInterval(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_INTERVAL_MS;
  return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, ms));
}

/**
 * Read the current fleet gauges and emit one `fleet.snapshot` info line.
 * Reuses the same read-on-demand helpers the dispatcher uses. `getQueueLength`
 * and `getPersistentPoolFreeSlots` swallow Valkey errors and return 0;
 * `getActiveDaemons` / `getDaemonActiveJobs` throw on a Valkey blip, but the
 * whole sample is wrapped in try/catch so any transient error logs a warn and
 * skips the tick instead of throwing or killing the timer.
 */
export async function sampleFleet(readers: FleetReaders = defaultReaders): Promise<void> {
  try {
    const [queueDepth, daemons, persistentFreeSlots] = await Promise.all([
      readers.getQueueLength(),
      readers.getActiveDaemons(),
      readers.getPersistentPoolFreeSlots(),
    ]);
    const busyPerDaemon = await Promise.all(daemons.map((id) => readers.getDaemonActiveJobs(id)));
    const busySlotsTotal = busyPerDaemon.reduce((sum, n) => sum + n, 0);

    const fields: FleetSnapshotLog = {
      event: FLEET_SNAPSHOT_EVENT,
      queue_depth: queueDepth,
      active_daemons_total: daemons.length,
      busy_slots_total: busySlotsTotal,
      persistent_free_slots: persistentFreeSlots,
    };
    logger.info(fields, "Fleet snapshot");
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Fleet snapshot sample failed",
    );
  }
}

/**
 * Start the periodic fleet snapshot. Idempotent. A configured interval of 0
 * disables the snapshot (inline-mode local dev); non-zero values are clamped
 * to [10s, 300s]. Fires one sample immediately so a freshly-booted orchestrator
 * emits a baseline without waiting a full interval.
 */
export function startFleetSnapshot(intervalMs: number): void {
  if (timer !== null) return;
  if (intervalMs === 0) {
    logger.info("Fleet snapshot disabled (FLEET_SNAPSHOT_INTERVAL_MS=0)");
    return;
  }
  const clamped = clampInterval(intervalMs);
  timer = setInterval(() => {
    void sampleFleet();
  }, clamped);
  void sampleFleet();
  logger.info({ intervalMs: clamped }, "Fleet snapshot started");
}

/** Stop the periodic fleet snapshot. Idempotent. */
export function stopFleetSnapshot(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
