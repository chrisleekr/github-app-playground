/**
 * Flake tracker (T041, FR-014, FR-014a). Identifies required checks
 * that flaked across iterations of a single ship session, triggers a
 * targeted re-run via REST, and renders an audit annotation for the
 * tracking comment.
 *
 * Non-required checks that flake go into the annotation but never gate
 * the verdict: the bot never blocks merge-readiness on a non-required
 * status that flips green-then-red-then-green.
 */

import type { Octokit } from "octokit";

import { logger } from "../../logger";
import type { ProbeResponseShape } from "./verdict";

export interface CheckHistoryEntry {
  readonly head_sha: string;
  readonly check_name: string;
  readonly conclusion: string | null;
  readonly is_required: boolean;
  /** Check run id from REST (needed to trigger a targeted rerequest). */
  readonly check_run_id: number | null;
}

export interface FlakedCheck {
  readonly check_name: string;
  readonly head_sha: string;
  readonly is_required: boolean;
  readonly check_run_id: number | null;
}

/**
 * A check flaked when, for a single (head_sha, check_name) pair, the
 * conclusion oscillated from FAILURE → SUCCESS or vice-versa across
 * iterations. Plain consistent failure is NOT a flake.
 */
export function identifyFlakedRequiredChecks(history: readonly CheckHistoryEntry[]): FlakedCheck[] {
  const grouped = new Map<string, CheckHistoryEntry[]>();
  for (const entry of history) {
    const key = `${entry.head_sha}::${entry.check_name}`;
    const list = grouped.get(key) ?? [];
    list.push(entry);
    grouped.set(key, list);
  }

  const flakes: FlakedCheck[] = [];
  for (const [, entries] of grouped) {
    const conclusions = new Set<string>();
    for (const e of entries) {
      if (e.conclusion !== null) conclusions.add(e.conclusion);
    }
    const oscillated =
      conclusions.has("SUCCESS") &&
      (conclusions.has("FAILURE") || conclusions.has("CANCELLED") || conclusions.has("TIMED_OUT"));
    if (!oscillated) continue;
    const last = entries[entries.length - 1];
    if (last === undefined) continue;
    if (!last.is_required) continue;
    flakes.push({
      check_name: last.check_name,
      head_sha: last.head_sha,
      is_required: last.is_required,
      check_run_id: last.check_run_id,
    });
  }
  return flakes;
}

export interface TriggerTargetedRerunInput {
  readonly octokit: Pick<Octokit, "rest">;
  readonly owner: string;
  readonly repo: string;
  readonly checks: readonly FlakedCheck[];
}

/**
 * REST `POST /repos/{owner}/{repo}/check-runs/{check_run_id}/rerequest`.
 * Best-effort: rerequest failures are logged but don't halt the
 * session. The probe will re-evaluate on the next iteration regardless.
 */
export async function triggerTargetedRerun(input: TriggerTargetedRerunInput): Promise<void> {
  for (const check of input.checks) {
    if (check.check_run_id === null) continue;
    try {
      // eslint-disable-next-line no-await-in-loop -- per-check sequential is fine; flake count is small (<10)
      await input.octokit.rest.checks.rerequestRun({
        owner: input.owner,
        repo: input.repo,
        check_run_id: check.check_run_id,
      });
    } catch (err) {
      // Best-effort, log but do not halt. Caller's iteration loop
      // re-probes the check state regardless of rerun outcome.
      logger.warn(
        {
          event: "ship.flake.rerun_failed",
          check_name: check.check_name,
          check_run_id: check.check_run_id,
          err: String(err),
        },
        "ship flake rerun failed",
      );
    }
  }
}

/**
 * Markdown annotation listing every flake observed during the session.
 * Embedded in the tracking-comment body by `tracking-comment.ts` when
 * non-empty.
 */
export function renderFlakeAnnotation(history: readonly CheckHistoryEntry[]): string {
  const flakes = identifyFlakedRequiredChecks(history);
  if (flakes.length === 0) return "";
  const lines = flakes.map(
    (f) =>
      `- \`${f.check_name}\` flaked on \`${f.head_sha.slice(0, 7)}\`${f.is_required ? " *(required)*" : ""}`,
  );
  return lines.join("\n");
}

/**
 * Project the latest probe response into `CheckHistoryEntry[]`.
 * Caller appends successive snapshots into a session-scoped history
 * before calling `identifyFlakedRequiredChecks`.
 */
export function projectHistoryFromProbe(probeResponse: ProbeResponseShape): CheckHistoryEntry[] {
  const pr = probeResponse.repository?.pullRequest;
  if (pr === undefined || pr === null) return [];
  const headSha = pr.headRefOid;
  const headCommit = pr.commits.nodes[0]?.commit;
  const contexts = headCommit?.statusCheckRollup?.contexts.nodes ?? [];
  const out: CheckHistoryEntry[] = [];
  for (const c of contexts) {
    if (c.__typename === "CheckRun") {
      out.push({
        head_sha: headSha,
        check_name: c.name ?? "<unknown>",
        conclusion: c.conclusion ?? null,
        is_required: c.isRequired,
        // databaseId is the numeric REST id used by the rerequest endpoint.
        // StatusContext entries have no equivalent, they remain null.
        check_run_id: c.databaseId ?? null,
      });
    } else {
      out.push({
        head_sha: headSha,
        check_name: c.context ?? "<unknown>",
        conclusion: c.state ?? null,
        is_required: c.isRequired,
        check_run_id: null,
      });
    }
  }
  return out;
}
