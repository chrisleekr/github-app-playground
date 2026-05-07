import type { Octokit } from "octokit";

/**
 * Canonical "all-green" definition for the resolve handler's CI gate.
 *
 * Mirrors the prompt language at `resolve.ts` step 6: a check is failing iff
 * `status === "completed"` AND `conclusion` is one of `failure`, `cancelled`,
 * `timed_out`, or `action_required`. `skipped`, `neutral`, and `success` are
 * acceptable terminal states. In-flight (`queued`/`in_progress`) checks are
 * tracked separately as `pendingChecks` and block `allGreen` — the post-
 * pipeline gate must not finalize a run while CI is still running because
 * those pending checks could later fail.
 *
 * Single source of truth for both the handler prologue snapshot and the
 * post-pipeline re-check, so a future drift between the two definitions
 * cannot reintroduce the silent-success bug this gate exists to close.
 */

export interface CheckEvaluation {
  /** True when no failing AND no pending checks remain. Empty input → `true`. */
  readonly allGreen: boolean;
  /** Names of failing checks, deduplicated, in the order first encountered. */
  readonly failingChecks: string[];
  /** Names of in-flight checks (queued/in_progress), deduplicated. */
  readonly pendingChecks: string[];
}

interface CheckRunLike {
  readonly status: string | null;
  readonly conclusion: string | null;
  readonly name: string;
}

const FAILING_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required"]);
const PENDING_STATUSES = new Set(["queued", "in_progress", "waiting", "pending"]);

export function evaluateCheckRuns(checks: readonly CheckRunLike[]): CheckEvaluation {
  const seenFailing = new Set<string>();
  const seenPending = new Set<string>();
  const failing: string[] = [];
  const pending: string[] = [];
  for (const c of checks) {
    if (c.status === "completed") {
      if (c.conclusion === null) continue;
      if (!FAILING_CONCLUSIONS.has(c.conclusion)) continue;
      if (seenFailing.has(c.name)) continue;
      seenFailing.add(c.name);
      failing.push(c.name);
      continue;
    }
    if (c.status !== null && PENDING_STATUSES.has(c.status)) {
      if (seenPending.has(c.name)) continue;
      seenPending.add(c.name);
      pending.push(c.name);
    }
  }
  return {
    allGreen: failing.length === 0 && pending.length === 0,
    failingChecks: failing,
    pendingChecks: pending,
  };
}

/**
 * Paginate `checks.listForRef` for the given SHA, then evaluate against the
 * canonical all-green definition. Used by the resolve handler's prologue
 * snapshot AND the post-pipeline re-check so both apply the same rule.
 */
export async function evaluateChecks(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
): Promise<CheckEvaluation> {
  const allCheckRuns = await octokit.paginate(octokit.rest.checks.listForRef, {
    owner,
    repo,
    ref,
    per_page: 100,
  });
  return evaluateCheckRuns(allCheckRuns);
}
