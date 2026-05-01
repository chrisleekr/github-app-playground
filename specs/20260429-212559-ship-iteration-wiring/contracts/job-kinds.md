# Job Kind Contract Additions

**Feature**: [spec.md](../spec.md) · **Plan**: [plan.md](../plan.md) · **Source**: `src/orchestrator/job-queue.ts` + `src/daemon/job-executor.ts`

This document specifies the four new `JobKind` values introduced by this feature, their payload shapes on the queue, and the executor contract each must satisfy on the daemon side.

---

## Four new JobKind values

| JobKind                 | Owns                                                         | Touches git?               | Touches Agent SDK?         |
| ----------------------- | ------------------------------------------------------------ | -------------------------- | -------------------------- |
| `scoped-rebase`         | Merge base into head and push (no force)                     | Yes (clone + merge + push) | No (deterministic)         |
| `scoped-fix-thread`     | Apply mechanical fix scoped to a review thread, push, reply  | Yes                        | Yes (multi-turn)           |
| `scoped-explain-thread` | Read cited code, post thread reply                           | No                         | Yes (read-only multi-turn) |
| `scoped-open-pr`        | Create branch from default, scaffold initial commit, open PR | Yes                        | Yes (multi-turn)           |

---

## `scoped-rebase`

### Queue payload (extends `QueuedJob`)

```ts
{
  kind: "scoped-rebase",
  deliveryId: string,
  installationId: number,
  owner: string,
  repo: string,
  prNumber: number,
  triggerCommentId: number,
  enqueuedAt: number,
  retryCount: number,
}
```

### Executor contract

`src/daemon/scoped-rebase-executor.ts` MUST:

1. Fetch the PR via Octokit; abort with `closed` outcome if PR is closed/merged.
2. Clone head to a temp dir (existing helper in `src/core/pipeline.ts`).
3. Run `git fetch origin <base_ref>` then `git merge origin/<base_ref>` — explicitly NO `--ff-only`, NO `--rebase`, NO `--force`.
4. If merge succeeds and produced a commit: `git push origin HEAD:<head_ref>` — no `-f`, no `--force-with-lease`.
5. If merge reports "Already up to date": return `up-to-date`; do NOT push.
6. If merge fails with conflicts: collect conflicting paths via `git diff --name-only --diff-filter=U`; abort the merge cleanly (`git merge --abort`); return `conflict` with the path list.
7. Clean up the temp dir on every exit path (success, conflict, exception).
8. Post the user-facing comment on the PR using the comment body from `src/workflows/ship/scoped/rebase.ts`'s policy layer (the executor returns the structured outcome; the policy layer formats and posts).

### Static guarantees

- File MUST be in a directory covered by `scripts/check-no-destructive-actions.ts` (already covers `src/daemon/`).
- ESLint rule prohibiting `force` flag literals MUST trip on any regression.

---

## `scoped-fix-thread`

### Queue payload

```ts
{
  kind: "scoped-fix-thread",
  deliveryId: string,
  installationId: number,
  owner: string,
  repo: string,
  prNumber: number,
  threadRef: {
    threadId: string,         // GraphQL node id
    commentId: number,        // REST id of the trigger comment
    filePath: string,
    startLine: number,
    endLine: number,
  },
  triggerCommentId: number,
  enqueuedAt: number,
  retryCount: number,
}
```

### Executor contract

`src/daemon/scoped-fix-thread-executor.ts` MUST:

1. Clone head to a temp dir.
2. Build a prompt scoped to the cited file range (`filePath:startLine-endLine`), including the thread's review-comment body.
3. Invoke `@anthropic-ai/claude-agent-sdk` with the existing MCP server set + `resolve-review-thread` MCP server.
4. After the agent finishes: detect changes via `git status --porcelain`; commit any change with a Conventional-Commit message; push to `<head_ref>`.
5. Resolve the thread via `resolve-review-thread` MCP and post a reply linking to the new commit SHA.
6. Clean up temp dir.

### Halt conditions

- Agent attempts to write outside the cited file path range → halt with `reason: "fix exceeded thread scope"`; do not push.
- Agent produces no diff → reply on thread with "no change required" rather than commit an empty change.

---

## `scoped-explain-thread`

### Queue payload

```ts
{
  kind: "scoped-explain-thread",
  deliveryId: string,
  installationId: number,
  owner: string,
  repo: string,
  prNumber: number,
  threadRef: { /* same as fix-thread */ },
  triggerCommentId: number,
  enqueuedAt: number,
  retryCount: number,
}
```

### Executor contract

`src/daemon/scoped-explain-thread-executor.ts` MUST:

1. Read the cited file range via Octokit's contents API (no clone needed).
2. Invoke the Agent SDK with a read-only system prompt and a denylist that blocks all write tools (no `Edit`, no `Write`, no `Bash` git mutations).
3. Capture the agent's reply text and post it as a thread reply.
4. NEVER push, NEVER resolve the thread (read-only behavior).

---

## `scoped-open-pr`

### Queue payload

```ts
{
  kind: "scoped-open-pr",
  deliveryId: string,
  installationId: number,
  owner: string,
  repo: string,
  issueNumber: number,
  triggerCommentId: number,
  verdictSummary: string,    // pre-computed summary from the policy layer
  enqueuedAt: number,
  retryCount: number,
}
```

### Executor contract

`src/daemon/scoped-open-pr-executor.ts` MUST:

1. Clone the default branch to a temp dir.
2. Create a new feature branch named per the existing `create-new-feature` convention but with the issue number as a suffix (`<timestamp>-issue-<N>-<slug>`).
3. Invoke the Agent SDK with a "scaffold initial commit" prompt informed by `verdictSummary`.
4. Push the new branch to `origin`.
5. Open a PR via Octokit (`createPullRequest`) targeting the default branch, body linking the originating issue.
6. Post a thread reply on the originating issue with the new PR number.

### Halt conditions

- Agent produces no diff → halt with `reason: "no scaffold produced"`; do NOT push an empty branch.
- Default branch is unknown / not protected → halt and surface error to maintainer.

---

## Iteration-driven workflow runs (existing kind, documented for clarity)

The iteration handler (`src/workflows/ship/iteration.ts`) does NOT introduce a new `JobKind`. It uses the **existing** `workflowRun?: WorkflowRunRef` path on `QueuedJob`. The only addition is that `workflow_runs.context_json.shipIntentId` is populated, which the orchestrator's completion cascade reads.

In other words: rebase/fix-thread/explain-thread/open-pr each get their own `JobKind` because they bypass the workflow-run tree (single-shot, no parent run). The iteration handler stays inside the workflow-run tree.

---

## Idempotency

Each scoped `JobKind` carries `triggerCommentId`. The daemon-side handler MUST check the existing tracking-comment durable idempotency layer before performing any side-effect — re-deliveries of the same comment id MUST be no-ops with the same outcome reported.
