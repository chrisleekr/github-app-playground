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

// Whitelist of passing conclusions per the GitHub REST docs for check runs:
// https://docs.github.com/en/rest/checks/runs — anything else terminal
// (failure, cancelled, timed_out, action_required, stale) counts as failing.
// `stale` is set automatically by GitHub after 14 days of incompletion; treating
// it as green would let stuck check suites silently pass the post-pipeline gate.
const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
// All non-terminal status values per the REST docs. `requested` was added in
// the Checks API and is set when a rerun is queued but not yet running — must
// block `allGreen` so the gate doesn't fire before the rerun starts.
const PENDING_STATUSES = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);

export function evaluateCheckRuns(checks: readonly CheckRunLike[]): CheckEvaluation {
  const seenFailing = new Set<string>();
  const seenPending = new Set<string>();
  const failing: string[] = [];
  const pending: string[] = [];
  for (const c of checks) {
    if (c.status === "completed") {
      if (c.conclusion === null) continue;
      if (PASSING_CONCLUSIONS.has(c.conclusion)) continue;
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
