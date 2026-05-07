import type { Octokit } from "octokit";

/**
 * Canonical "all-green" definition for the resolve handler's CI gate.
 *
 * Mirrors the prompt language at `resolve.ts` step 6: a check is failing iff
 * `status === "completed"` AND `conclusion` is one of `failure`, `cancelled`,
 * `timed_out`, or `action_required`. `skipped`, `neutral`, and `success` are
 * acceptable terminal states; in-flight (`queued`/`in_progress`) checks are
 * NOT counted as failing — the caller polls until terminal.
 *
 * Single source of truth for both the handler prologue snapshot and the
 * post-pipeline re-check, so a future drift between the two definitions
 * cannot reintroduce the silent-success bug this gate exists to close.
 */

export interface CheckEvaluation {
  /** True when no failing checks remain. Empty input → `true`. */
  readonly allGreen: boolean;
  /** Names of failing checks, deduplicated, in the order first encountered. */
  readonly failingChecks: string[];
}

interface CheckRunLike {
  readonly status: string | null;
  readonly conclusion: string | null;
  readonly name: string;
}

const FAILING_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required"]);

export function evaluateCheckRuns(checks: readonly CheckRunLike[]): CheckEvaluation {
  const seen = new Set<string>();
  const failing: string[] = [];
  for (const c of checks) {
    if (c.status !== "completed") continue;
    if (c.conclusion === null) continue;
    if (!FAILING_CONCLUSIONS.has(c.conclusion)) continue;
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    failing.push(c.name);
  }
  return { allGreen: failing.length === 0, failingChecks: failing };
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
