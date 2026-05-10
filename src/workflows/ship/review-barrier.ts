/**
 * Reviewer-latency barrier (T040, FR-023, research.md R3). Prevents the
 * bot from declaring a PR `ready` immediately after pushing a fix when
 * a human reviewer has not yet had time to react.
 *
 * Returns `true` (defer) when NEITHER of these holds:
 *   (a) at least one review with `commit.oid === current_head_sha`
 *       authored by a non-bot non-self account; OR
 *   (b) `now - last_push_at >= safetyMarginMs`.
 *
 * The barrier never enumerates specific reviewer logins. It excludes
 * the App's own login (so a self-review never satisfies the barrier)
 * and excludes other GitHub App / Bot accounts via
 * `author.__typename === 'Bot'`.
 */

/**
 * Minimal shape this barrier reads from the probe response. The full
 * GraphQL response carries more (`reviews`, etc.) than `ProbeResponseShape`
 * currently declares: declared narrowly here so the barrier stays
 * decoupled from the verdict module's type evolution.
 */
export interface BarrierProbeShape {
  readonly repository: {
    readonly pullRequest: {
      readonly headRefOid: string;
      readonly commits: {
        readonly nodes: readonly {
          readonly commit: { readonly committedDate: string };
        }[];
      };
      readonly reviews?: {
        readonly nodes: readonly {
          readonly author: {
            readonly login: string;
            // GraphQL Actor union, "User" | "Bot" | "Mannequin" | "Organization" | "EnterpriseUserAccount"
            readonly __typename?: string;
          } | null;
          readonly commit: { readonly oid: string } | null;
        }[];
      };
    } | null;
  } | null;
}

export interface ShouldDeferInput {
  readonly probeResponse: BarrierProbeShape;
  readonly ourAppLogin: string;
  readonly safetyMarginMs: number;
  readonly now?: Date;
}

export function shouldDeferOnReviewLatency(input: ShouldDeferInput): boolean {
  const pr = input.probeResponse.repository?.pullRequest;
  if (pr === undefined || pr === null) return false;

  const headSha = pr.headRefOid;
  const reviews = pr.reviews?.nodes ?? [];
  const headCommit = pr.commits.nodes[0]?.commit;
  const lastPushAt =
    headCommit?.committedDate !== undefined ? new Date(headCommit.committedDate) : null;
  const now = input.now ?? new Date();

  // Condition (a): non-bot non-self review on the current head SHA.
  const hasQualifyingReview = reviews.some((r): boolean => {
    if (r.commit?.oid !== headSha) return false;
    const authorLogin = r.author?.login ?? null;
    if (authorLogin === null) return false;
    if (authorLogin === input.ourAppLogin) return false;
    // Exclude any non-User actor, automation reviews (other bots, GitHub
    // Apps, deploy keys) must not satisfy the human-review barrier.
    // `__typename` is requested in the probe GraphQL query; older fixtures
    // without it fall back to the App-login self-exclusion above.
    const typename = r.author?.__typename;
    if (typename !== undefined && typename !== "User") return false;
    return true;
  });
  if (hasQualifyingReview) return false;

  // Condition (b): safety margin elapsed since last push.
  if (lastPushAt !== null) {
    const elapsed = now.getTime() - lastPushAt.getTime();
    if (elapsed >= input.safetyMarginMs) return false;
  }

  return true;
}
