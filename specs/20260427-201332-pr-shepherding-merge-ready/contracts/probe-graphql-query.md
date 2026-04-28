# Contract: Merge-Readiness Probe GraphQL Query

**Phase**: P1
**Module**: `src/workflows/ship/probe.ts`
**Authentication**: Installation token via existing `octokit` App.
**Cost**: ~$0 (one GraphQL request, no agent invocation).
**Latency target**: <100 ms p95.

This is the single GraphQL query the probe issues per iteration. It returns every field the `MergeReadiness` conjunction (spec.md §"Merge-Readiness Verdict") needs.

---

## Query

```graphql
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
      author {
        login
      }
      reviewThreads(first: 100) {
        totalCount
        nodes {
          id
          isResolved
          isOutdated
          comments(first: 1) {
            nodes {
              author {
                login
              }
              createdAt
            }
          }
        }
      }
      commits(last: 1) {
        nodes {
          commit {
            oid
            committedDate
            author {
              user {
                login
              }
              email
            }
            statusCheckRollup {
              state
              contexts(first: 100) {
                nodes {
                  __typename
                  ... on CheckRun {
                    name
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
          author {
            login
          }
          state
          submittedAt
          commit {
            oid
          }
        }
      }
    }
  }
}
```

---

## Variables

| Variable  | Type      | Source                   |
| --------- | --------- | ------------------------ |
| `$owner`  | `String!` | `ship_intents.owner`     |
| `$repo`   | `String!` | `ship_intents.repo`      |
| `$number` | `Int!`    | `ship_intents.pr_number` |

---

## Response → MergeReadiness mapping

The probe transforms the raw GraphQL response into a `MergeReadiness` value. The mapping is deterministic and testable in isolation (no external calls).

| GraphQL field                                        | Used for                | Failure mode → `NonReadinessReason`                                                                                                                                                                                       |
| ---------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mergeable`                                          | Conjunction clause 1    | `null` → `mergeable_pending` (after R2 backoff exhausted); `CONFLICTING` → `behind_base`                                                                                                                                  |
| `mergeStateStatus`                                   | Conjunction clause 2    | `BEHIND` → `behind_base`; `BLOCKED`/`UNSTABLE`/`DIRTY` → caller decides per sub-state                                                                                                                                     |
| `commits.nodes[0].commit.statusCheckRollup.contexts` | Conjunction clause 3    | `isRequired=true && conclusion ∉ {SUCCESS, NEUTRAL, SKIPPED}` → `failing_checks`; `isRequired=true && status ∈ {QUEUED, IN_PROGRESS, PENDING}` → `pending_checks`                                                         |
| `reviewThreads.nodes[].isResolved`                   | Conjunction clause 4    | any `isResolved=false && isOutdated=false` → `open_threads`                                                                                                                                                               |
| `reviewDecision`                                     | Conjunction clause 5    | `CHANGES_REQUESTED` → `changes_requested`                                                                                                                                                                                 |
| `baseRefOid`                                         | Conjunction clause 6    | mismatch with `ship_intents.target_base_sha` → trigger Q2-round1 base-ref resync (not a non-readiness reason; updates intent and re-probes)                                                                               |
| `commits.nodes[0].commit.author.user.login`          | Conjunction clause 7    | non-bot login on a SHA the bot did not push → `human_took_over`                                                                                                                                                           |
| `commits.nodes[0].commit.committedDate`              | Review barrier (FR-023) | most recent push timestamp; compared against `reviews[].submittedAt` filtered to non-bot non-self authors (any `author.__typename === 'User'` plus any App author that is not our own App login). No reviewer-login list. |
| `isDraft`                                            | Terminal action only    | informs whether the FR-019 draft → ready flip is required at terminal                                                                                                                                                     |

---

## Error handling

| GraphQL error                       | Probe behavior                                                                                                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rate limit (`RATE_LIMITED`)         | Retry once after waiting until `X-RateLimit-Reset`; if rate limit exhausted again, write `verdict_json` snapshot of the error and yield with `wake_at = reset_time + 60s`. Does not terminate intent. |
| Network error                       | Retry up to 3 times with exponential backoff (1s, 2s, 4s); if all fail, log and yield with `wake_at = now + 60s`. Does not terminate intent.                                                          |
| `NOT_FOUND` (PR or repo deleted)    | Terminate intent with `SessionTerminalState = pr_closed`, `BlockerCategory = unrecoverable-error`.                                                                                                    |
| `FORBIDDEN` (token lost permission) | Terminate intent with `BlockerCategory = permission-denied`.                                                                                                                                          |

All error paths write the failure to `ship_iterations.verdict_json` so the offline reconciler (deferred per R9) can audit them.

---

## Test fixtures

`test/workflows/ship/probe.test.ts` MUST cover at least:

1. All-green PR → `MergeReadiness.ready === true`.
2. `mergeable=null` → first call returns `mergeable_pending` after backoff exhausted.
3. Required check failing → `failing_checks` with details.
4. Required check pending → `pending_checks`.
5. Open review thread → `open_threads`.
6. `reviewDecision=CHANGES_REQUESTED` → `changes_requested`.
7. Base SHA changed mid-flight (cascade) → triggers resync, returns updated verdict on second probe.
8. Non-bot author on head SHA → `human_took_over`.
9. No non-bot review yet recorded against current head SHA AND safety margin not yet elapsed → caller-side barrier defers (probe itself returns `ready=true`; the reviewer-agnostic barrier is in `review-barrier.ts` and uses no reviewer list).
10. Combinations: two non-readiness reasons simultaneously → probe returns the highest-priority one (priority order documented in `verdict.ts`).

Fixtures live in `test/workflows/ship/fixtures/probe-responses/` as JSON files captured from real GraphQL responses (sanitised).
