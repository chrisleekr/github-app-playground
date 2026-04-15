import { z } from "zod";

/**
 * DispatchTarget — the four concrete execution targets the router may
 * dispatch a single event to. "auto" is NOT a target: it's a platform-wide
 * configuration mode (AGENT_JOB_MODE=auto) that resolves per-event into
 * one of these four.
 *
 * Source of truth: data-model.md §1 of the triage-dispatch-modes feature.
 * The Postgres `executions.dispatch_target` CHECK constraint and the
 * `triage_results.mode` CHECK constraint (minus "inline", which is not
 * triage-reachable) both mirror this list. Keep the DB migration and this
 * union in sync when extending.
 */
export const DISPATCH_TARGETS = ["inline", "daemon", "shared-runner", "isolated-job"] as const;

export type DispatchTarget = (typeof DISPATCH_TARGETS)[number];

export const DispatchTargetSchema = z.enum(DISPATCH_TARGETS);

/**
 * Type guard — narrows an unknown value to DispatchTarget. Preferred over
 * `DispatchTargetSchema.safeParse(...).success` at hot-path call sites
 * where we only need the boolean and don't care about the issue list.
 */
export function isDispatchTarget(value: unknown): value is DispatchTarget {
  return typeof value === "string" && (DISPATCH_TARGETS as readonly string[]).includes(value);
}

/**
 * DispatchReason — why the router chose the target it did. Used for
 * operator visibility (FR-010, FR-014) and the tracking-comment "why here?"
 * line (SC-007). This union is canonical: the Postgres
 * `executions.dispatch_reason` CHECK constraint lists the same eight values.
 *
 * Meaning of each value (from spec §Terminology + data-model.md §2):
 *   label                  — explicit bot:shared / bot:job label applied
 *   keyword                — deterministic keyword classifier matched
 *   triage                 — auto-mode LLM classification accepted (≥ threshold)
 *   default-fallback       — triage sub-threshold → configured default target
 *   triage-error-fallback  — triage timed out / parse-failed / circuit-open
 *   static-default         — static classifier returned "ambiguous" in a non-auto mode
 *   capacity-rejected      — isolated-job queue full; request refused outright
 *   infra-absent           — target infrastructure (K8s auth) not configured
 */
export const DISPATCH_REASONS = [
  "label",
  "keyword",
  "triage",
  "default-fallback",
  "triage-error-fallback",
  "static-default",
  "capacity-rejected",
  "infra-absent",
] as const;

export type DispatchReason = (typeof DISPATCH_REASONS)[number];

export const DispatchReasonSchema = z.enum(DISPATCH_REASONS);

export function isDispatchReason(value: unknown): value is DispatchReason {
  return typeof value === "string" && (DISPATCH_REASONS as readonly string[]).includes(value);
}
