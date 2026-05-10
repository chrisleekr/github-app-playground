/**
 * Shared GitHub GraphQL queries and response shapes.
 *
 * Single source of truth for queries called from more than one site.
 * Keeps the github-state MCP server (`src/mcp/servers/github-state.ts`)
 * in lockstep with the deterministic probe (`src/workflows/ship/probe.ts`)
 * so a schema change touches one file, not two. The verdict path and
 * the LLM tool surface render the same fields.
 */

/**
 * Merge-readiness probe query (FR-021, FR-022). Fetches PR metadata,
 * the head commit's `statusCheckRollup` (CI), the first 100 review
 * threads, and the latest 20 reviews: enough for `computeVerdict()` to
 * decide mergeability without round-tripping the REST API.
 *
 * The first 100 review threads are paginated separately via
 * {@link REVIEW_THREADS_PAGE_QUERY} when a PR carries more.
 */
export const PROBE_QUERY = `
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
          pageInfo { hasNextPage endCursor }
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

/**
 * Paginated review-threads query. The main {@link PROBE_QUERY} only
 * fetches the first 100 threads; this one walks the rest when a PR has
 * more.
 */
export const REVIEW_THREADS_PAGE_QUERY = `
  query ReviewThreadsPage($owner: String!, $repo: String!, $number: Int!, $cursor: String!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { id isResolved isOutdated }
        }
      }
    }
  }
`;
