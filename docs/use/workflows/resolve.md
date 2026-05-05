# `bot:resolve`

Fixes failing CI, replies to existing review threads, and pushes new commits.

| Field           | Value                                                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Label           | `bot:resolve`                                                                                                                     |
| Mention         | `@chrisleekr-bot fix the CI failures` · `@chrisleekr-bot address the review comments` · `@chrisleekr-bot respond to the feedback` |
| Accepted target | Pull request                                                                                                                      |
| Requires prior  | —                                                                                                                                 |
| Artifact        | `$BOT_ARTIFACT_DIR/RESOLVE.md` (sibling temp dir, never committed to the repo)                                                    |
| Side effects    | New commits on the PR head branch; replies to review threads; force-push of a clean rebase if branch is behind base               |
| Source          | `src/workflows/handlers/resolve.ts`                                                                                               |

## Method

For each open reviewer comment the agent classifies as **Valid**, **Partially Valid**, **Invalid**, or **Needs Clarification**, then:

- Fixes valid ones with new commits.
- Replies to all four classes appropriately, in the same CodeRabbit-style three-block layout (status line, bold one-line title, prose reasoning).
- Marks the thread resolved (Valid / Partially Valid only) via the `resolve-review-thread` MCP tool after the reply lands.
- Fixes failing CI when there is a clear root cause.
- Polls CI after the final commit and does not exit until all checks return to green (or the per-iteration `FIX_ATTEMPTS_CAP=3` is exhausted, in which case the unresolved failure is recorded under `## Outstanding` in `RESOLVE.md`).

Branch refresh happens first if the head is stale (same logic as `review`).

Reviewer-thread replies are posted via `gh api repos/<owner>/<repo>/pulls/<num>/comments/<id>/replies -X POST`. The bot's `gh` and `git` calls authenticate via `GH_TOKEN` and `GITHUB_TOKEN`, injected from the GitHub App installation token by `buildProviderEnv` in `src/core/executor.ts`.

### Reply body format

All four classifications use the same shape so bot replies look consistent across `resolve`, `review`, `bot:fix-thread`, and `bot:explain-thread`:

```markdown
<STATUS_LINE>

**<One-line title summarizing what was done or concluded.>**

<1–3 sentences of reasoning: why the fix was applied, why the reviewer was right/wrong, or what specifically needs clarifying. Cite file:line where relevant. No diff — the commit link covers that.>
```

| Classification      | Status line                                   | Resolves thread?     |
| ------------------- | --------------------------------------------- | -------------------- |
| Valid               | `_✅ Addressed_ — commit \`<sha>\``           | Yes                  |
| Partially Valid     | `_⚠️ Partially addressed_ — commit \`<sha>\`` | Yes                  |
| Invalid             | `_❌ Not applicable_`                         | No (reviewer closes) |
| Needs Clarification | `_❓ Need clarification_`                     | No                   |

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
