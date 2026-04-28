# Contract: MCP Server — `resolve-review-thread`

**Phase**: P7
**Module**: `src/mcp/servers/resolve-review-thread.ts`
**Registered via**: `src/mcp/registry.ts` (per Constitution VII)
**Underlying API**: GraphQL — see [resolve-thread-mutation.md](./resolve-thread-mutation.md)

This MCP server exposes the GraphQL `resolveReviewThread` mutation as a single tool consumable by the Claude Agent SDK during `resolve` handler execution.

---

## Server lifecycle

| Stage          | Behavior                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Construction   | Receives `{ installationToken: string, owner: string, repo: string, pullNumber: number, logger: Logger }` per Constitution VII (no application-state access). |
| Initialization | Constructs an `octokit` client scoped to the installation token. Validates `owner` / `repo` / `pullNumber` non-empty.                                         |
| Tool calls     | Each `resolve_review_thread` call invokes the GraphQL mutation with the supplied `thread_id`.                                                                 |
| Teardown       | None required. The server holds no persistent resources beyond the octokit client.                                                                            |

---

## Tool: `resolve_review_thread`

### Input schema

```json
{
  "type": "object",
  "properties": {
    "thread_id": {
      "type": "string",
      "description": "The PullRequestReviewThread node ID (returned by the merge-readiness probe in reviewThreads.nodes[].id, or by a separate REST→GraphQL conversion if the agent only has REST comment ids)."
    }
  },
  "required": ["thread_id"],
  "additionalProperties": false
}
```

### Output schema

On success:

```json
{
  "type": "object",
  "properties": {
    "thread_id": { "type": "string" },
    "is_resolved": { "type": "boolean" },
    "pr_number": { "type": "number" }
  },
  "required": ["thread_id", "is_resolved", "pr_number"]
}
```

On failure (returned via standard MCP tool-error mechanism):

```json
{
  "code": "thread_not_found" | "permission_denied" | "rate_limited" | "network_error" | "graphql_error",
  "message": "<human-readable description>",
  "thread_id": "<the input thread id>",
  "pr_number": "<the server-bound PR number>"
}
```

`pr_number` is included on **both** the success and error payloads so the
caller can verify the cross-PR safety story (the server is bound to a
single PR at construction; a thread that resolves to a different PR
returns the bound PR number and a `graphql_error` code).

---

## Allowed-tools registration

The agent only sees this tool when invoked from a session/iteration that has explicitly registered it. Wiring point: `src/workflows/handlers/resolve.ts` adds `mcp__resolve-review-thread__resolve_review_thread` to the agent's allowed-tools list when the resolve iteration is acting on a PR with open threads.

This keeps the tool out of agent contexts where it isn't relevant (per Constitution VII single-responsibility).

---

## Security

| Concern                                      | Mitigation                                                                                                                                                                                                                                                                                      |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resolving the wrong PR's thread              | The server is bound to a single `(owner, repo, pullNumber)` at construction; resolving a thread that belongs to a different PR returns a `pr_number` mismatch in the response and the agent is instructed to abort the iteration.                                                               |
| Resolving a thread the agent didn't reply to | The agent prompt (in `resolve.ts`) explicitly requires that a reply comment with the change summary precede the resolve call. Enforced by prompt engineering — not by the MCP server itself, since the server has no state. Verifiable by post-mortem audit of `ship_iterations.runs_store_id`. |
| Token leak                                   | Installation token is held in-memory by the server instance only; never logged. Logger redacts any field matching `/token\|secret\|key/i` per existing logger conventions.                                                                                                                      |

---

## Tests

`test/mcp/resolve-review-thread.test.ts` MUST cover:

1. Server construction with valid params → succeeds.
2. Server construction with missing `installationToken` → throws.
3. `resolve_review_thread` with valid `thread_id` → returns `{ thread_id, is_resolved: true, pr_number }`.
4. `resolve_review_thread` with unknown `thread_id` → returns error `{ code: 'thread_not_found' }`.
5. `resolve_review_thread` against a thread on a different PR → returns error `{ code: 'graphql_error' }` with mismatch detail.
6. Permission denied → returns error `{ code: 'permission_denied' }`.
7. Network failure on first attempt, success on retry → returns success.
8. Network failure exhausting retries → returns error `{ code: 'network_error' }`.
9. Rate-limited → backs off and retries; returns success or `{ code: 'rate_limited' }` after retry exhaustion.
10. Token field never appears in any logged output (assertion against captured logs).

GraphQL mocked via `octokit.graphql` interceptor. No real API calls (Constitution V).
