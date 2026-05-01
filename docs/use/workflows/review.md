# `bot:review`

Reads a PR diff in full, cross-references with the rest of the codebase, and posts findings as inline comments.

| Field           | Value                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Label           | `bot:review`                                                                                                                          |
| Mention         | `@chrisleekr-bot review this PR` · `@chrisleekr-bot do a code review` · `@chrisleekr-bot check for issues`                            |
| Accepted target | Pull request                                                                                                                          |
| Requires prior  | —                                                                                                                                     |
| Artifact        | `REVIEW.md`                                                                                                                           |
| Side effects    | Inline review comments via `mcp__github_inline_comment__create_inline_comment`; force-push of a clean rebase if branch is behind base |
| Source          | `src/workflows/handlers/review.ts`                                                                                                    |

## Method

The agent operates as a senior engineer:

- Reads every changed file in full, not just the diff window.
- Cross-references callers, tests, and related code.
- Runs `bun test`, `bun run typecheck`, `bun run lint` when uncertain.
- Only posts findings it can defend with evidence.

Each finding carries a severity prefix:

| Severity    | Meaning                                             |
| ----------- | --------------------------------------------------- |
| `[blocker]` | Must fix before merge — correctness or security.    |
| `[major]`   | Should fix before merge — likely bug, missing test. |
| `[minor]`   | Nice to fix — readability.                          |
| `[nit]`     | Taste, optional. Not counted in `findings.total`.   |

Findings are posted **one MCP call per finding**, never as a single bundled review. This guarantees each finding lands on the right line with its own resolvable thread.

## No-findings case

The agent must still post a top-level review body listing exactly what was checked (files read, classes of issue scanned, tests run) and why no issues were flagged. Silence is indistinguishable from "didn't actually look".

## Branch refresh

If the PR head is behind base **and** the branch is not on a fork, the agent rebases onto base, resolves conflicts honestly (reads the surrounding code, runs typecheck and tests, never blindly takes ours/theirs), and force-pushes with `--force-with-lease`. Fork PRs get a comment asking the contributor to rebase, then the review proceeds against the stale head with affected findings flagged.

## Outputs

| Field                                                       | Type                                                    | Notes                                                       |
| ----------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------- |
| `state.head_sha`                                            | string                                                  | The SHA the review ran against (post-rebase if applicable). |
| `state.changed_files`, `state.additions`, `state.deletions` | numbers                                                 | Diff stats.                                                 |
| `state.branch_state`                                        | `{commits_behind_base, commits_ahead_of_base, is_fork}` | Pre-refresh snapshot.                                       |
| `state.findings`                                            | `{blocker, major, minor, nit, total}`                   | Counted from the severity tags; `total` excludes `nit`.     |
| `state.report`                                              | markdown                                                | Full `REVIEW.md`.                                           |
| `state.costUsd`, `state.turns`                              | metrics                                                 | —                                                           |

## Push policy

The only push acceptable from `review` is `git push --force-with-lease` after a clean rebase onto base (same diff, fresh head SHA). The handler never creates code commits, never calls `pulls.merge`, never posts an `APPROVE` or `REQUEST_CHANGES` review.
