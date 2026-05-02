# `bot:resolve`

Fixes failing CI, replies to existing review threads, and pushes new commits.

| Field           | Value                                                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Label           | `bot:resolve`                                                                                                                     |
| Mention         | `@chrisleekr-bot fix the CI failures` · `@chrisleekr-bot address the review comments` · `@chrisleekr-bot respond to the feedback` |
| Accepted target | Pull request                                                                                                                      |
| Requires prior  | —                                                                                                                                 |
| Artifact        | `RESOLVE.md`                                                                                                                      |
| Side effects    | New commits on the PR head branch; replies to review threads; force-push of a clean rebase if branch is behind base               |
| Source          | `src/workflows/handlers/resolve.ts`                                                                                               |

## Method

For each open reviewer comment the agent classifies as **Valid**, **Partially Valid**, **Invalid**, or **Needs Clarification**, then:

- Fixes valid ones with new commits.
- Replies to all four classes appropriately.
- Fixes failing CI when there is a clear root cause.

Branch refresh happens first if the head is stale (same logic as `review`).

Reviewer-thread replies are posted via `gh api repos/<owner>/<repo>/pulls/<num>/comments/<id>/replies -X POST`. The bot's `gh` and `git` calls authenticate via `GH_TOKEN` and `GITHUB_TOKEN`, injected from the GitHub App installation token by `buildProviderEnv` in `src/core/executor.ts`.

## Outputs

| Field                          | Type       | Notes                                                                                     |
| ------------------------------ | ---------- | ----------------------------------------------------------------------------------------- |
| `state.failing_checks`         | `string[]` | Names of failing checks at start of run.                                                  |
| `state.top_level_comments`     | number     | Count of open top-level review comments.                                                  |
| `state.branch_state`           | object     | Pre-refresh snapshot.                                                                     |
| `state.report`                 | markdown   | Full `RESOLVE.md` (Summary / CI status / Review comments / Commits pushed / Outstanding). |
| `state.costUsd`, `state.turns` | metrics    | —                                                                                         |

## Stop conditions

- `FIX_ATTEMPTS_CAP = 3` — maximum consecutive CI-fix attempts per run.
- `POLL_WAIT_SECS_CAP = 900` (15 min) — reviewer-patience window before the run terminates.
- The handler **never** calls `octokit.rest.pulls.merge` — merging is a human action.

## Failure handling

Public-comment and operator surfaces are separated so a raw SDK or octokit error never reaches the public PR thread. Both the `runPipeline` failure path and the outer handler `catch` apply the same separation:

- **Public tracking comment** — a safe constant: `"resolve pipeline execution failed — see server logs for details."` The actual error string remains internal because octokit error stacks include `https://x-access-token:GHS_xxx@…` in the request URL.
- **Operator surfaces** — `state.failedReason` on the `workflow_runs` row, `pino` log lines on the daemon, and `ExecutionResult.errorMessage` returned to the orchestrator. The orchestrator's transient-quota detector reads `state.failedReason` and auto-defers the ship loop's next iteration when the SDK reports `"You've hit your limit · resets … UTC"`.
