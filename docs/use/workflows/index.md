# Workflows

Six workflows are registered today (`src/workflows/registry.ts`). Each has a single label, a single comment-mention verb, and produces one Markdown artifact that becomes the body of the tracking comment.

| Workflow                    | Label           | Surfaces                                       | What it does                                                                 | Detail           |
| --------------------------- | --------------- | ---------------------------------------------- | ---------------------------------------------------------------------------- | ---------------- |
| [`triage`](triage.md)       | `bot:triage`    | Issue label or comment                         | Decides whether an issue is actionable, with structural or runtime evidence  | `TRIAGE.md`      |
| [`plan`](plan.md)           | `bot:plan`      | Issue label or comment, after `triage`         | Writes an implementation plan                                                | `PLAN.md`        |
| [`implement`](implement.md) | `bot:implement` | Issue label or comment, after `plan`           | Opens a PR with code, tests, and a filled-out PR template                    | `IMPLEMENT.md`   |
| [`review`](review.md)       | `bot:review`    | PR label or comment                            | Reads the diff in full, posts findings as inline comments                    | `REVIEW.md`      |
| [`resolve`](resolve.md)     | `bot:resolve`   | PR label or comment                            | Fixes failing CI, replies to review threads, pushes new commits              | `RESOLVE.md`     |
| [`ship`](ship.md)           | `bot:ship`      | PR comment, label, or natural-language mention | Shepherds an open PR to merge-ready: probe → fix → reply → wait, until clean | tracking comment |

## How they relate

`triage`, `plan`, and `implement` are the issue-side cascade for new work. `review` and `resolve` are the PR-side pair: `review` proactively reads a diff and posts findings; `resolve` reactively answers existing feedback and fixes failing CI. The split is deliberate — conflating "look at this PR" with "fix this PR" was the design mistake the verb-rename corrected.

`ship` is the PR shepherding lifecycle (its own state machine, its own database tables). It does not run the cascade above; it drives an open PR through the merge-readiness probe ladder until a human can hit merge. See [`ship.md`](ship.md).

## Common rules across all workflows

- **The bot never merges.** No workflow calls `pulls.merge` or posts an `APPROVE` / `REQUEST_CHANGES` review. Static guard at `scripts/check-no-destructive-actions.ts`.
- **Always-rebase semantics.** PR-side workflows (`review`, `resolve`, `ship`) rebase the branch onto base before reading the diff if it is behind, then `git push --force-with-lease`. Fork PRs cannot be force-pushed by the bot — it asks the contributor to rebase and proceeds against the stale head.
- **One Markdown artifact, one tracking comment.** Each run captures `<NAME>.md` from the working tree before cleanup and embeds it verbatim in the tracking comment.
- **Tracking comments are idempotent.** Every tracking comment carries a hidden `<!-- workflow-run:{id} -->` marker. `setState()` in `src/workflows/tracking-mirror.ts` scans for the marker before posting, adopts any pre-existing comment found (e.g. after an octokit retry that silently duplicated a `POST`, or a pod restart between create and CAS reservation), and reconciles duplicates after create — keeping a single canonical comment per run regardless of transient API failures.
- **Cost is visible.** Every workflow records `cost_usd`, `turns`, and `wall_clock_ms` on the run row. The shepherding lifecycle exposes cumulative spend in the tracking comment header.

## Trigger-comment intent classifier

A comment that mentions the trigger phrase is routed through `src/workflows/intent-classifier.ts` — a single-turn Haiku call that returns `{ workflow, confidence, rationale }`.

- `confidence < INTENT_CONFIDENCE_THRESHOLD` (default `0.75`) → the dispatcher posts a clarification reply and stops.
- `workflow` not in registry → refusal reply.
- `workflow` in registry → same dispatch as the label path.

The classifier prompt distinguishes `review` (proactive — find bugs, post inline findings) from `resolve` (reactive — fix CI, answer feedback). Tune the threshold per environment with `INTENT_CONFIDENCE_THRESHOLD`.
