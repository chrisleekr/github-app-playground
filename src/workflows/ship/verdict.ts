/**
 * Merge-readiness verdict — pure transform from the GraphQL probe
 * response (per `contracts/probe-graphql-query.md` §"Response →
 * MergeReadiness mapping") to a discriminated `MergeReadiness` value.
 *
 * Priority order (when multiple non-readiness conditions are present
 * simultaneously, the highest-priority reason wins):
 *
 *   1. `human_took_over`        — non-bot author on current head SHA (FR-010)
 *   2. `behind_base`            — base ref drift / mergeable=CONFLICTING
 *   3. `failing_checks`         — required check with non-success conclusion
 *   4. `pending_checks`         — required check still queued / running (FR-022)
 *   5. `mergeable_pending`      — `mergeable=null` after R2 backoff exhausted (FR-021)
 *   6. `changes_requested`      — `reviewDecision === 'CHANGES_REQUESTED'`
 *   7. `open_threads`           — at least one unresolved, non-outdated thread
 *
 * The probe orders these by lifecycle priority — a foreign push voids
 * everything else; a base mismatch makes other signals stale; etc.
 *
 * No I/O lives in this module. Network calls are in `probe.ts`.
 */

export const NON_READINESS_REASONS = [
  "failing_checks",
  "open_threads",
  "changes_requested",
  "behind_base",
  "mergeable_pending",
  "pending_checks",
  "human_took_over",
  // Transient: review-latency barrier defers a ready verdict until either
  // a non-bot review lands on the head SHA or the safety margin elapses.
  // Distinct from `human_took_over` so downstream lifecycle code does not
  // mistake the deferral for an actual takeover.
  "review_barrier_deferred",
] as const;

export type NonReadinessReason = (typeof NON_READINESS_REASONS)[number];

import { z } from "zod";

export const NonReadinessReasonSchema = z.enum(NON_READINESS_REASONS);

export type MergeReadiness =
  | { readonly ready: true; readonly checked_at: string; readonly head_sha: string }
  | {
      readonly ready: false;
      readonly reason: NonReadinessReason;
      readonly detail: string;
      readonly checked_at: string;
      readonly head_sha: string;
    };

interface CheckRollupContext {
  readonly __typename: "CheckRun" | "StatusContext";
  readonly name?: string;
  readonly context?: string;
  readonly conclusion?: string | null;
  readonly status?: string | null;
  readonly state?: string | null;
  readonly isRequired: boolean;
  /** Numeric REST id; only populated for CheckRun nodes. */
  readonly databaseId?: number | null;
}

export interface ProbeResponseShape {
  readonly repository: {
    readonly pullRequest: {
      readonly number: number;
      readonly isDraft: boolean;
      readonly state: "OPEN" | "CLOSED" | "MERGED";
      readonly merged: boolean;
      readonly mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN" | null;
      readonly mergeStateStatus: string | null;
      readonly reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
      readonly baseRefName: string;
      readonly baseRefOid: string;
      readonly headRefName: string;
      readonly headRefOid: string;
      readonly author: { readonly login: string } | null;
      readonly reviewThreads: {
        readonly nodes: readonly {
          readonly id: string;
          readonly isResolved: boolean;
          readonly isOutdated: boolean;
        }[];
      };
      readonly commits: {
        readonly nodes: readonly {
          readonly commit: {
            readonly oid: string;
            readonly committedDate: string;
            readonly author: {
              readonly user: { readonly login: string } | null;
              readonly email: string | null;
            };
            readonly statusCheckRollup: {
              readonly contexts: { readonly nodes: readonly CheckRollupContext[] };
            } | null;
          };
        }[];
      };
    } | null;
  } | null;
}

export interface VerdictInput {
  readonly response: ProbeResponseShape;
  readonly botAppLogin: string;
  /** Head SHAs the bot itself has pushed — non-bot author on a not-bot SHA → human_took_over. */
  readonly botPushedShas: ReadonlySet<string>;
}

export function computeVerdict(input: VerdictInput): MergeReadiness {
  const pr = input.response.repository?.pullRequest;
  const checked_at = new Date().toISOString();
  if (pr === undefined || pr === null) {
    return {
      ready: false,
      reason: "human_took_over",
      detail: "PR not found in probe response",
      checked_at,
      head_sha: "",
    };
  }
  const head_sha = pr.headRefOid;
  const headCommit = pr.commits.nodes[0]?.commit;

  // Priority 1 — non-bot author on a SHA the bot did not push.
  if (headCommit !== undefined) {
    const authorLogin = headCommit.author.user?.login ?? null;
    const isBot = authorLogin === input.botAppLogin;
    const isBotPushed = input.botPushedShas.has(headCommit.oid);
    if (!isBot && !isBotPushed) {
      return {
        ready: false,
        reason: "human_took_over",
        detail: `head ${head_sha} authored by ${authorLogin ?? "<unknown>"}`,
        checked_at,
        head_sha,
      };
    }
  }

  // Priority 2 — base drift / merge conflict.
  if (pr.mergeable === "CONFLICTING") {
    return {
      ready: false,
      reason: "behind_base",
      detail: "PR has merge conflicts with base",
      checked_at,
      head_sha,
    };
  }
  if (pr.mergeStateStatus === "BEHIND") {
    return {
      ready: false,
      reason: "behind_base",
      detail: "PR head is behind base",
      checked_at,
      head_sha,
    };
  }

  // Priority 3 + 4 — check rollup.
  const contexts = headCommit?.statusCheckRollup?.contexts.nodes ?? [];
  const failingRequired: string[] = [];
  const pendingRequired: string[] = [];
  for (const ctx of contexts) {
    if (!ctx.isRequired) continue;
    if (ctx.__typename === "CheckRun") {
      const c = ctx.conclusion;
      if (c !== null && c !== undefined && c !== "SUCCESS" && c !== "NEUTRAL" && c !== "SKIPPED") {
        failingRequired.push(ctx.name ?? "<unknown>");
      } else if (
        ctx.status === "QUEUED" ||
        ctx.status === "IN_PROGRESS" ||
        ctx.status === "PENDING"
      ) {
        pendingRequired.push(ctx.name ?? "<unknown>");
      }
    } else {
      const s = ctx.state;
      if (s === "FAILURE" || s === "ERROR") failingRequired.push(ctx.context ?? "<unknown>");
      else if (s === "PENDING") pendingRequired.push(ctx.context ?? "<unknown>");
    }
  }
  if (failingRequired.length > 0) {
    return {
      ready: false,
      reason: "failing_checks",
      detail: `failing required checks: ${failingRequired.join(", ")}`,
      checked_at,
      head_sha,
    };
  }
  if (pendingRequired.length > 0) {
    return {
      ready: false,
      reason: "pending_checks",
      detail: `pending required checks: ${pendingRequired.join(", ")}`,
      checked_at,
      head_sha,
    };
  }

  // Priority 5 — mergeable still null after backoff (caller already exhausted R2 schedule).
  if (pr.mergeable === null || pr.mergeable === "UNKNOWN") {
    return {
      ready: false,
      reason: "mergeable_pending",
      detail: "GitHub still computing mergeable status after backoff exhausted",
      checked_at,
      head_sha,
    };
  }

  // Priority 6 — explicit changes-requested.
  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    return {
      ready: false,
      reason: "changes_requested",
      detail: "PR has CHANGES_REQUESTED review decision",
      checked_at,
      head_sha,
    };
  }

  // Priority 7 — unresolved, non-outdated review threads.
  const openThreads = pr.reviewThreads.nodes.filter((t) => !t.isResolved && !t.isOutdated);
  if (openThreads.length > 0) {
    return {
      ready: false,
      reason: "open_threads",
      detail: `${openThreads.length} unresolved review thread(s)`,
      checked_at,
      head_sha,
    };
  }

  return { ready: true, checked_at, head_sha };
}
