import { z } from "zod";

/**
 * DispatchTarget — after the daemon-only collapse, every job goes through the
 * daemon WebSocket protocol. The value is retained as a singleton rather than
 * removed entirely so DB rows, log lines, and the `ws-messages.ts` schema stay
 * stable across future extensions.
 *
 * The Postgres `executions.dispatch_target` and `triage_results.mode` CHECK
 * constraints mirror this list (see migration `004_collapse_dispatch_to_daemon.sql`).
 */
export const DISPATCH_TARGETS = ["daemon"] as const;

export type DispatchTarget = (typeof DISPATCH_TARGETS)[number];

export const DispatchTargetSchema = z.enum(DISPATCH_TARGETS);

/**
 * Type guard — narrows an unknown value to DispatchTarget.
 */
export function isDispatchTarget(value: unknown): value is DispatchTarget {
  return typeof value === "string" && (DISPATCH_TARGETS as readonly string[]).includes(value);
}

/**
 * DispatchReason — why the orchestrator routed the job the way it did. Answers
 * the operator question "did this job go to an existing persistent daemon, or
 * did we spin up an ephemeral one (and why)?"
 *
 * Meaning of each value:
 *   persistent-daemon         — routed to an existing persistent daemon (default path)
 *   ephemeral-daemon-triage   — triage flagged the request as heavy, ephemeral daemon spawned
 *   ephemeral-daemon-overflow — persistent queue at/above threshold, ephemeral daemon spawned
 *   ephemeral-spawn-failed    — spawn was required but the K8s API call failed
 */
export const DISPATCH_REASONS = [
  "persistent-daemon",
  "ephemeral-daemon-triage",
  "ephemeral-daemon-overflow",
  "ephemeral-spawn-failed",
] as const;

export type DispatchReason = (typeof DISPATCH_REASONS)[number];

export const DispatchReasonSchema = z.enum(DISPATCH_REASONS);

export function isDispatchReason(value: unknown): value is DispatchReason {
  return typeof value === "string" && (DISPATCH_REASONS as readonly string[]).includes(value);
}
