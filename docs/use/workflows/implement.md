# `bot:implement`

Opens a PR with code, tests, and a filled-out PR template based on the prior plan.

| Field           | Value                                 |
| --------------- | ------------------------------------- |
| Label           | `bot:implement`                       |
| Mention         | `@chrisleekr-bot implement this`      |
| Accepted target | Issue                                 |
| Requires prior  | A successful `plan` run               |
| Artifact        | `IMPLEMENT.md`                        |
| Side effects    | New branch, new commits, new PR       |
| Source          | `src/workflows/handlers/implement.ts` |

## Inputs

- Issue body.
- The plan markdown from the prior `plan` run.
- A fresh shallow clone of the repository.

## Outputs

| Field                                             | Type     | Notes                                                                                                                 |
| ------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------- |
| `state.pr_number`, `state.pr_url`, `state.branch` | strings  | The PR the bot opened.                                                                                                |
| `state.report`                                    | markdown | Full `IMPLEMENT.md` (Summary / Files changed / Commits / Tests run / Verification). Embedded in the tracking comment. |
| `state.costUsd`, `state.turns`                    | metrics  | —                                                                                                                     |

## PR detection

`findRecentOpenedPr` filters on `pr.user?.type === 'Bot'` plus `created_at >= since - 5s`. It deliberately does not match on a hard-coded login slug — dev installs publish as `chrisleekr-bot-dev[bot]` and prod as `chrisleekr-bot[bot]`, so a slug check would produce false negatives.

## PR body

The agent reads `.github/PULL_REQUEST_TEMPLATE/bot-implement.md` and fills every section based on actual work, then passes it via `gh pr create --body-file …`. This keeps bot PRs structurally consistent and prevents `gh` from auto-falling back to the human PR template.

## Stop conditions

- Pipeline pushes a branch and opens a PR.
- Pipeline succeeds but `findRecentOpenedPr` returns null → handler fails with `"implement completed but no PR was found"`.
- Pipeline fails → handler reports the underlying error.

The handler does **not** poll CI or reviewer state — that is `resolve`'s job, after `review` has run.

## Failure handling

The handler treats public and operator surfaces separately so the public tracking comment never carries the raw underlying error. Both the `runPipeline` failure path and the outer handler `catch` set the same safe `humanMessage`:

- **Public tracking comment** — a safe constant: `"implement pipeline execution failed — see server logs for details."` Octokit error stacks embed the installation token in the request URL, so the bot must never inline `err.message` into a comment body.
- **Operator surfaces (DB + logs)** — the SDK error is propagated as `ExecutionResult.errorMessage` and persisted as `state.failedReason` on the `workflow_runs` row. `pino` logs the full `err` object on the daemon. The orchestrator's quota-detection helper reads `state.failedReason` to decide whether to auto-defer the next ship iteration; see [`ship.md`](./ship.md).
