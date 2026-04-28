/**
 * Merge-readiness probe (FR-021, FR-022). Issues the GraphQL query in
 * `contracts/probe-graphql-query.md`, applies the bounded
 * `mergeable=null` backoff schedule from `MERGEABLE_NULL_BACKOFF_MS_LIST`,
 * and returns a `MergeReadiness` verdict via `verdict.ts`.
 *
 * On schedule exhaustion the verdict is `mergeable_pending` — the
 * session yields per FR-020 and the loop never terminates on a null
 * mergeable status.
 */

import type { SQL } from "bun";
import type { Octokit } from "octokit";

import { config } from "../../config";
import { requireDb } from "../../db";
import { appendIteration } from "../../db/queries/ship";
import { logger } from "../../logger";
import {
  type CheckHistoryEntry,
  identifyFlakedRequiredChecks,
  projectHistoryFromProbe,
  triggerTargetedRerun,
} from "./flake-tracker";
import { resyncBaseSha } from "./intent";
import { type BarrierProbeShape, shouldDeferOnReviewLatency } from "./review-barrier";
import { computeVerdict, type MergeReadiness, type ProbeResponseShape } from "./verdict";

const PROBE_QUERY = `
  query MergeReadinessProbe($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        number
        isDraft
        state
        merged
        mergeable
        mergeStateStatus
        reviewDecision
        baseRefName
        baseRefOid
        headRefName
        headRefOid
        author { login }
        reviewThreads(first: 100) {
          totalCount
          nodes { id isResolved isOutdated }
        }
        commits(last: 1) {
          nodes {
            commit {
              oid
              committedDate
              author { user { login } email }
              statusCheckRollup {
                state
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun {
                      name
                      databaseId
                      conclusion
                      status
                      completedAt
                      isRequired(pullRequestNumber: $number)
                    }
                    ... on StatusContext {
                      context
                      state
                      isRequired(pullRequestNumber: $number)
                    }
                  }
                }
              }
            }
          }
        }
        reviews(last: 20) {
          nodes {
            id
            author { __typename login }
            state
            submittedAt
            commit { oid }
          }
        }
      }
    }
  }
`;

export interface RunProbeInput {
  readonly octokit: Pick<Octokit, "graphql">;
  readonly owner: string;
  readonly repo: string;
  readonly pr_number: number;
  readonly botAppLogin: string;
  readonly botPushedShas: ReadonlySet<string>;
  /** Override the env-driven backoff list — primarily for tests. */
  readonly mergeableBackoffMs?: readonly number[];
  /** Override the sleep function — required for deterministic tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface ProbeResult {
  readonly verdict: MergeReadiness;
  readonly response: ProbeResponseShape;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export async function runProbe(input: RunProbeInput): Promise<ProbeResult> {
  const backoff = input.mergeableBackoffMs ?? config.mergeableNullBackoffMsList;
  const sleep = input.sleep ?? defaultSleep;

  let lastResponse: ProbeResponseShape | null = null;
  for (let attempt = 0; attempt <= backoff.length; attempt += 1) {
    const response = await input.octokit.graphql<ProbeResponseShape>(PROBE_QUERY, {
      owner: input.owner,
      repo: input.repo,
      number: input.pr_number,
    });
    lastResponse = response;
    const mergeable = response.repository?.pullRequest?.mergeable ?? null;
    if (mergeable !== null && mergeable !== "UNKNOWN") {
      const verdict = computeVerdict({
        response,
        botAppLogin: input.botAppLogin,
        botPushedShas: input.botPushedShas,
      });
      return { verdict, response };
    }
    if (attempt < backoff.length) {
      const delay = backoff[attempt];
      if (delay !== undefined) await sleep(delay);
    }
  }

  // Schedule exhausted — return mergeable_pending; caller yields per FR-020.
  if (lastResponse === null) {
    throw new Error("runProbe: no GraphQL response captured (this is a bug)");
  }
  const verdict = computeVerdict({
    response: lastResponse,
    botAppLogin: input.botAppLogin,
    botPushedShas: input.botPushedShas,
  });
  return { verdict, response: lastResponse };
}

// ─── T044/T052 — `runProbeIntegrated`: opt-in wrapper that adds the
// review-barrier, flake-tracker, base-ref resync, and verdict_json
// persistence layers around `runProbe`. Existing callers of `runProbe`
// are unaffected.

export interface RunProbeIntegratedInput extends RunProbeInput {
  /**
   * Intent id whose `target_base_sha` is compared against the probe's
   * observed `baseRefOid` (Q2-round1 cascade). Required for any
   * integration that wants resyncBaseSha + verdict_json persistence.
   */
  readonly intent_id: string;
  /** Iteration number for the audit row (T052). */
  readonly iteration_n: number;
  /** Sequential history of check entries observed across iterations. */
  readonly flakeHistory?: readonly CheckHistoryEntry[];
  /**
   * REST octokit for `POST /check-runs/:id/rerequest` (T041). Optional —
   * when omitted, flake reruns are skipped (the verdict still flips
   * away from `ready`).
   */
  readonly restOctokit?: Pick<Octokit, "rest">;
  /** Bot App login for the review-barrier; defaults to `botAppLogin`. */
  readonly applyReviewBarrier?: { readonly safetyMarginMs: number };
  /** SQL handle for the audit-row write. Defaults to `requireDb()`. */
  readonly sql?: SQL;
}

export interface ProbeIntegratedResult extends ProbeResult {
  readonly history: readonly CheckHistoryEntry[];
  readonly baseShaResynced: boolean;
}

export async function runProbeIntegrated(
  input: RunProbeIntegratedInput,
): Promise<ProbeIntegratedResult> {
  const result = await runProbe(input);
  const sql = input.sql ?? requireDb();

  const pr = result.response.repository?.pullRequest;
  let verdict = result.verdict;

  // T043 — base-ref resync (cascade base change).
  let baseShaResynced = false;
  if (pr !== undefined && pr !== null) {
    const observedBase = pr.baseRefOid;
    const intentRow: { target_base_sha: string }[] = await sql`
      SELECT target_base_sha FROM ship_intents WHERE id = ${input.intent_id}
    `;
    const expected = intentRow[0]?.target_base_sha;
    if (expected !== undefined && expected !== observedBase) {
      const updated = await resyncBaseSha(input.intent_id, observedBase, sql);
      baseShaResynced = updated !== null;
    }
  }

  // T044 — review-barrier: gate `ready` verdicts.
  if (verdict.ready && input.applyReviewBarrier !== undefined) {
    // The barrier shape is declared narrowly in `review-barrier.ts` and
    // doesn't fully overlap with `ProbeResponseShape`'s nested types
    // (e.g. `reviews` is barrier-only). Both fixtures and the runtime
    // GraphQL response satisfy both shapes; cast through `unknown` so
    // the intent is explicit rather than silenced via `as never`.
    const defer = shouldDeferOnReviewLatency({
      probeResponse: result.response as unknown as BarrierProbeShape,
      ourAppLogin: input.botAppLogin,
      safetyMarginMs: input.applyReviewBarrier.safetyMarginMs,
    });
    if (defer) {
      verdict = {
        ready: false,
        reason: "review_barrier_deferred",
        detail:
          "review-barrier deferring: no non-bot review on current head SHA and safety margin not yet elapsed",
        checked_at: verdict.checked_at,
        head_sha: verdict.head_sha,
      };
    }
  }

  // T044 — flake tracker: project history; trigger reruns; re-write
  // verdict if flakes observed AND we'd otherwise have said ready.
  const projectedHistory = projectHistoryFromProbe(result.response);
  const fullHistory: readonly CheckHistoryEntry[] = input.flakeHistory
    ? [...input.flakeHistory, ...projectedHistory]
    : projectedHistory;
  if (verdict.ready) {
    const flakes = identifyFlakedRequiredChecks(fullHistory);
    if (flakes.length > 0) {
      if (input.restOctokit !== undefined) {
        await triggerTargetedRerun({
          octokit: input.restOctokit,
          owner: input.owner,
          repo: input.repo,
          checks: flakes,
        });
      }
      verdict = {
        ready: false,
        reason: "failing_checks",
        detail: `flaked required checks awaiting rerun: ${flakes.map((f) => f.check_name).join(", ")}`,
        checked_at: verdict.checked_at,
        head_sha: verdict.head_sha,
      };
    }
  }

  // T052 — write verdict_json + full GraphQL response to ship_iterations.
  try {
    await appendIteration(
      {
        intent_id: input.intent_id,
        iteration_n: input.iteration_n,
        kind: "probe",
        verdict_json: { verdict, response: result.response },
      },
      sql,
    );
  } catch (err) {
    // Best-effort — audit-row failure must not abort the iteration.
    // Log so an unexpected persistence failure shows up in observability.
    logger.warn(
      { err, intent_id: input.intent_id, event: "ship.probe.audit_row_failed" },
      "ship probe audit-row write failed (best-effort)",
    );
  }

  return { verdict, response: result.response, history: fullHistory, baseShaResynced };
}
