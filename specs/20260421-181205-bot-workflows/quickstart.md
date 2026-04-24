# Quickstart: Definitive Bot Workflows

This is the maintainer-facing walkthrough for driving the new bot workflows. Assumes the GitHub App is installed on a repo under `ALLOWED_OWNERS`.

## Concepts at a glance

Five workflows. One label per workflow. One composite (`ship`) that chains four of them. See [`spec.md`](./spec.md) for the contract; this page is how to use it.

| Workflow    | Label           | Runs against | Produces                              |
| ----------- | --------------- | ------------ | ------------------------------------- |
| `triage`    | `bot:triage`    | open issue   | validity verdict + recommended next   |
| `plan`      | `bot:plan`      | open issue   | task decomposition                    |
| `implement` | `bot:implement` | open issue   | PR linked to the issue                |
| `review`    | `bot:review`    | open PR      | merge-ready PR (or halts with reason) |
| `ship`      | `bot:ship`      | open issue   | merge-ready PR via all four stages    |

## 1. Trigger one workflow at a time (label)

```text
# Open issue #42. You want triage only.
Apply label bot:triage.
```

Within 10 seconds the bot posts a tracking comment ("Working on triage…"). When triage finishes the comment updates with the verdict. No other workflow runs.

To continue manually, apply the next label (`bot:plan`, then `bot:implement`). Each step refuses if its prior output is missing, so you cannot skip.

## 2. Trigger one workflow at a time (comment)

```text
@chrisleekr-bot please plan this
```

The bot runs its intent classifier, recognises "plan", and dispatches the `plan` workflow exactly as if you had applied `bot:plan`. If the ask is ambiguous, the bot replies with a single clarifying question rather than guessing.

## 3. Drive the full pipeline with one label

```text
Apply label bot:ship on an open issue.
```

The bot runs:

```text
triage → plan → implement → review
```

Each step is a separate queued job that hands off to the next one on success. When the PR is merge-ready the final tracking comment says so and stops. **The bot never merges** — that remains your action.

If any step fails, the bot halts with a tracking-comment entry naming the failed step and reason. You resume by **re-applying `bot:ship`** — the bot reads the run store, finds the last successful step, and continues from the next one.

## 4. Only one bot label at a time

The bot enforces this itself. If issue #42 has `bot:plan` and you apply `bot:ship`, the bot removes `bot:plan` automatically before dispatching `bot:ship`. You never need to clean up labels manually.

## 5. Check what the bot is doing

- **Human-readable state**: read the bot's tracking comment on the issue/PR.
- **Authoritative state**: query `SELECT * FROM workflow_runs WHERE target_owner=... AND target_repo=... AND target_number=... ORDER BY created_at DESC`.

The DB row is authoritative; the tracking comment is a best-effort projection of the row. If a comment update fails (GitHub 5xx, rate limit, permission drift), the handler logs the error and continues — the DB state remains correct. Brief divergences can occur while retries drain.

## 6. Stop bounds for `review`

The `review` workflow halts when either:

- 3 consecutive CI-fix attempts have failed, or
- 15 minutes have elapsed with no new reviewer comments and the PR is not yet approved.

These match the existing `pr-auto` skill and are enforced in the handler. There is no wall-clock cap beyond (b).

## 7. Adding a new workflow (for maintainers of this codebase)

The point of the registry is that adding a new workflow is three files:

1. Append one entry to `src/workflows/registry.ts`.
2. Create `src/workflows/handlers/<name>.ts` exporting `handler: WorkflowHandler`.
3. Add a section to `docs/BOT-WORKFLOWS.md`.

No changes to the dispatcher, the intent classifier, or any other handler. No DB migration. If any of those three files need changes for a new workflow, the registry has leaked and something must be refactored back into it.

## Local verification

```bash
bun run dev:deps                 # start local Valkey + Postgres
bun run check                    # typecheck + lint + format + tests
bun run dev                      # watch-mode server

# In a separate terminal once the server is running:
curl -X POST http://localhost:3000/healthz
```

A `bot-workflows` integration test under `test/workflows/` simulates:

1. Apply `bot:triage` on a fixture issue → assert one `triage` row in `workflow_runs` with `status='succeeded'`.
2. Apply `bot:ship` on a fixture issue → assert one parent row plus four child rows in order.
3. Apply `bot:plan` while `bot:triage` is live on the same issue → assert `bot:triage` is removed before the `plan` run is enqueued.
4. Re-apply `bot:ship` after simulated `implement` failure → assert no second PR attempt; review is enqueued with the existing PR.

## Troubleshooting

| Symptom                                        | Most likely cause                                                                                                                                        | Fix                                                                                                                                                        |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Label applied, no tracking comment within 10 s | Webhook didn't reach the server, or the label is not in the registry                                                                                     | Check server logs for the delivery id; confirm label exactly matches `^bot:[a-z]+$`.                                                                       |
| "requires prior output" refusal                | You applied `bot:implement` without a successful prior `bot:plan` run on the same issue                                                                  | Apply `bot:plan` first, or use `bot:ship`.                                                                                                                 |
| Two tracking comments on one issue             | Tracking-comment reservation race lost its compensating `deleteComment` (see `tracking-mirror.setState`). The DB still points at the single winning row. | Confirm exactly one `workflow_runs` row for the target; manually delete the loser comment. File a bug only if two **runs** also exist.                     |
| `bot:ship` re-applied but nothing happens      | The latest parent row is `status='succeeded'` (everything already done) or `status='failed'` with no remaining steps                                     | Check `workflow_runs`; if terminal and you want a full re-run, the re-run mechanism is a future spec — for now, manually close the linked PR and re-apply. |
