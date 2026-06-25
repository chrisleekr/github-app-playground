/**
 * Canonical pino log-field schema for the scheduler scan lifecycle (issue #217).
 *
 * Mirrors `src/core/log-fields.ts`: a `.strict()` Zod shape pins the structured
 * `scheduler.scan.*` event family so the emit sites in `scanOnce` / `guardedScan`
 * cannot drift on a field name (e.g. `duration_ms` vs `durationMs`, or a counter
 * rename) without the co-located test catching it. Emitters log plain objects via
 * `log.info` / `log.warn`; the schema is the drift-prevention contract, not a
 * runtime validator on the hot path.
 *
 * Scope: scan-level heartbeat/duration/reentrancy only. The per-action
 * transitions (`scheduler.action.claimed` / `scheduler.action.skipped_missed`)
 * are orthogonal and deliberately not pinned here.
 *
 * The scheduler scans timer-driven with no per-request child logger, so unlike
 * the idempotency / pipeline families these lines carry no `deliveryId` binding.
 * All custom metric fields are snake_case (`duration_ms` + the per-scan counters).
 */
import { z } from "zod";

export const SCHEDULER_LOG_EVENTS = {
  scanStarted: "scheduler.scan.started",
  scanCompleted: "scheduler.scan.completed",
  scanSkippedOverlap: "scheduler.scan.skipped_overlap",
  scanFailed: "scheduler.scan.failed",
} as const;

/** Info: a scan tick began. The heartbeat that proves the timer is alive. */
export const SchedulerScanStartedSchema = z
  .object({
    event: z.literal(SCHEDULER_LOG_EVENTS.scanStarted),
  })
  .strict();

/**
 * Info: a scan tick finished cleanly. `duration_ms` is the scan wall-clock; the
 * counters give per-tick traffic so an operator can graph reach + due-rate.
 */
export const SchedulerScanCompletedSchema = z
  .object({
    event: z.literal(SCHEDULER_LOG_EVENTS.scanCompleted),
    duration_ms: z.number().int().nonnegative(),
    repos_enumerated: z.number().int().nonnegative(),
    actions_evaluated: z.number().int().nonnegative(),
    actions_claimed: z.number().int().nonnegative(),
    actions_advanced: z.number().int().nonnegative(),
    actions_failed: z.number().int().nonnegative(),
  })
  .strict();

/**
 * Warn: a tick fired while the previous scan was still running (the reentrancy
 * guard skipped it). The saturation signal: a non-zero rate means scans exceed
 * `SCHEDULER_SCAN_INTERVAL_MS`. `since_started_ms` is how long the in-flight
 * scan has been running, so an operator can tell a single slow scan from a wedge.
 */
export const SchedulerScanSkippedOverlapSchema = z
  .object({
    event: z.literal(SCHEDULER_LOG_EVENTS.scanSkippedOverlap),
    since_started_ms: z.number().int().nonnegative(),
  })
  .strict();

/**
 * Error: the scan tick threw. `duration_ms` is the wall-clock to the throw.
 * `err` (the standard pino error field) is not pinned here, same as the other
 * families: this schema fixes only the custom metric fields.
 */
export const SchedulerScanFailedSchema = z
  .object({
    event: z.literal(SCHEDULER_LOG_EVENTS.scanFailed),
    duration_ms: z.number().int().nonnegative(),
  })
  .strict();

export type SchedulerScanStarted = z.infer<typeof SchedulerScanStartedSchema>;
export type SchedulerScanCompleted = z.infer<typeof SchedulerScanCompletedSchema>;
export type SchedulerScanSkippedOverlap = z.infer<typeof SchedulerScanSkippedOverlapSchema>;
export type SchedulerScanFailed = z.infer<typeof SchedulerScanFailedSchema>;

/** Per-scan mutable counters threaded through `processAction` into the completed line. */
export interface ScanCounters {
  repos_enumerated: number;
  actions_evaluated: number;
  actions_claimed: number;
  actions_advanced: number;
  actions_failed: number;
}

export function createScanCounters(): ScanCounters {
  return {
    repos_enumerated: 0,
    actions_evaluated: 0,
    actions_claimed: 0,
    actions_advanced: 0,
    actions_failed: 0,
  };
}
