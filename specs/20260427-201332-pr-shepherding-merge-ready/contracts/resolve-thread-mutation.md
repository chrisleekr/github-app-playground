# Contract: GraphQL `resolveReviewThread` Mutation

**Phase**: P7
**Module**: `src/mcp/servers/resolve-review-thread.ts` (new MCP server) + invoked from `src/workflows/handlers/resolve.ts`.
**Authentication**: Installation token via existing `octokit` App.
**Reference**: GitHub GraphQL API — `resolveReviewThread` mutation.

The current `resolve` handler replies to review comments but cannot mark threads resolved via REST. This mutation closes the structural gap (FR-005: "reply… then resolve the thread").

---

## Mutation

```graphql
mutation ResolveReviewThread($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread {
      id
      isResolved
      pullRequest {
        number
      }
    }
  }
}
```

---

## Inputs

| Variable    | Type  | Source                                                                                      |
| ----------- | ----- | ------------------------------------------------------------------------------------------- |
| `$threadId` | `ID!` | The `PullRequestReviewThread.id` from the probe query response (`reviewThreads.nodes[].id`) |

---

## Required permissions

The GitHub App installation must hold `pull_requests: write`. (Already granted; no manifest change required.)

---

## Behavior contract

- **Idempotent**: calling on an already-resolved thread is a no-op (returns `isResolved: true`).
- **Authorisation**: the bot can resolve any thread on a PR it has push access to. (GitHub permits resolution by repo collaborators including App installations with PR write.)
- **Audit**: resolution shows in PR timeline as performed by the bot's GitHub App login.

---

## Error handling

| GraphQL error                   | MCP server behavior                                                                                                                                |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NOT_FOUND` (thread id unknown) | Return tool error with `code: 'thread_not_found'`. Caller logs and skips.                                                                          |
| `FORBIDDEN`                     | Return tool error with `code: 'permission_denied'`. Caller surfaces to tracking comment as `BlockerCategory = permission-denied` and halts intent. |
| Rate-limit                      | Retry once with backoff per the secondary rate-limit policy; on second failure, return tool error and let caller yield.                            |
| Network                         | Retry up to 3 times; on exhaustion, return tool error.                                                                                             |

---

## MCP tool surface

The MCP server exposes one tool:

```json
{
  "name": "resolve_review_thread",
  "description": "Mark a GitHub PR review thread as resolved. Use after replying to the thread with a comment summarising the change.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "thread_id": {
        "type": "string",
        "description": "The PullRequestReviewThread node ID (from the probe response or REST conversion)."
      }
    },
    "required": ["thread_id"]
  }
}
```

The tool returns:

```json
{ "thread_id": "<id>", "is_resolved": true }
```

or an error object on failure.

---

## Tests

`test/mcp/resolve-review-thread.test.ts` MUST cover:

1. Resolve unresolved thread → returns `is_resolved: true`.
2. Resolve already-resolved thread → returns `is_resolved: true` (idempotent).
3. Resolve unknown thread id → returns `code: thread_not_found`.
4. Permission denied → returns `code: permission_denied`.
5. Network failure with retry → succeeds on retry.
6. Rate limit → backs off and retries.

GraphQL is mocked with `octokit.graphql` interceptor. No real API calls (Constitution V).
