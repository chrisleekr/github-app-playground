# Runbook — stuck `bot:ship` session

A shepherding session that doesn't terminate cleanly leaves a row in `ship_intents` with status other than `ready_awaiting_human_merge` or `merged_externally`. This page is a guide to figuring out which class of stuck and what to do.

## Database tables

Two tables carry the bulk of operator-relevant state:

| Table                | Rows                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `ship_intents`       | One per session. Status, deadline, cumulative spend, terminal blocker category, tracking comment id. |
| `ship_iterations`    | One per probe / fix / reply / review iteration. Verdict on probe rows, cost, wall-clock.             |
| `ship_continuations` | One per active intent. `wake_at`, `state_blob`, `wait_for[]` array.                                  |
| `ship_fix_attempts`  | Retry ledger keyed by `(intent_id, signature)`. Drives `flake-cap` enforcement.                      |

Migration files live under `src/db/migrations/`. The ship lifecycle was added in `008_ship_intents.sql`.

## Status values

| Status                       | Meaning                                                | Recoverable?                                |
| ---------------------------- | ------------------------------------------------------ | ------------------------------------------- |
| `active`                     | Session is in flight (or about to be tickled).         | —                                           |
| `paused`                     | `bot:stop` issued. Deadline keeps counting.            | Yes — `bot:resume`.                         |
| `ready_awaiting_human_merge` | Probe verdict was `ready`; tracking comment finalised. | Terminal — human merge expected.            |
| `merged_externally`          | PR was merged while session was active.                | Terminal.                                   |
| `pr_closed`                  | PR was closed (not merged) while session was active.   | Terminal.                                   |
| `human_took_over`            | Foreign push detected, iteration cap, or flake cap.    | Terminal — see `terminal_blocker_category`. |
| `deadline_exceeded`          | `MAX_WALL_CLOCK_PER_SHIP_RUN` elapsed.                 | Terminal.                                   |
| `aborted_by_user`            | `bot:abort-ship` issued.                               | Terminal — no further mutations.            |

## Terminal blocker categories

When `status='human_took_over'`:

| Category                     | Meaning                                                                | Action                                                         |
| ---------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------- |
| `manual-push-detected`       | A non-bot principal pushed to the PR.                                  | If you want the bot to take over again, re-trigger `bot:ship`. |
| `iteration-cap`              | The session ran `MAX_SHIP_ITERATIONS` rounds without resolving.        | Re-scope the work or split the PR.                             |
| `flake-cap`                  | Same failure signature retried `FIX_ATTEMPTS_PER_SIGNATURE_CAP` times. | Investigate the flake; the bot will not retry indefinitely.    |
| `merge-conflict-needs-human` | Rebase produced conflicts the bot would not resolve confidently.       | Resolve manually, then re-trigger.                             |
| `permission-denied`          | A required GitHub mutation returned 403.                               | Check App permissions / repo collaborator access.              |
| `stopped-by-user`            | Session was paused indefinitely.                                       | `bot:resume` or `bot:abort-ship`.                              |
| `unrecoverable-error`        | Catch-all for unexpected pipeline failures.                            | Read `ship_iterations.verdict_json` for the last iteration.    |
| `design-discussion-needed`   | Probe escalated when the agent flagged a non-mechanical decision.      | Discuss in PR thread; re-trigger if direction is clear.        |

## Day-2 SQL queries

All queries assume `psql` against `DATABASE_URL`.

### Active sessions

```sql
SELECT
  id,
  owner || '/' || repo AS repo,
  pr_number,
  status,
  deadline_at,
  spent_usd,
  EXTRACT(EPOCH FROM (now() - created_at))::int AS age_seconds
FROM ship_intents
WHERE status IN ('active', 'paused')
ORDER BY created_at;
```

### Terminal-state distribution (last 7 days)

```sql
SELECT
  status,
  terminal_blocker_category,
  COUNT(*) AS n,
  ROUND(AVG(spent_usd)::numeric, 2) AS avg_spend
FROM ship_intents
WHERE terminated_at IS NOT NULL
  AND terminated_at > now() - interval '7 days'
GROUP BY status, terminal_blocker_category
ORDER BY n DESC;
```

### Top-spend sessions

```sql
SELECT id, owner, repo, pr_number, status, spent_usd, created_at, terminated_at
FROM ship_intents
ORDER BY spent_usd DESC
LIMIT 20;
```

### Iterations for one intent

```sql
SELECT iteration_n, kind, verdict_json->>'kind' AS verdict, cost_usd, started_at, finished_at
FROM ship_iterations
WHERE intent_id = '<uuid>'
ORDER BY iteration_n;
```

### Fix-attempt heatmap (signatures retried near the cap)

```sql
SELECT intent_id, signature, attempts, last_seen_at
FROM ship_fix_attempts
WHERE attempts >= 2
ORDER BY attempts DESC, last_seen_at DESC;
```

## Triage decision tree

```text
Is status terminal?
├── Yes — read terminal_blocker_category. Use the table above.
└── No  — status is active or paused.
    ├── status=paused — stopped by user, awaiting resume or abort.
    └── status=active — read ship_continuations for this intent.
        ├── wake_at in the past — tickle scheduler should pick it up next cycle.
        │     If multiple cycles pass with no progress, check tickle-scheduler logs
        │     (event:"ship.tickle.due") and ship.iteration.* events.
        └── wake_at in the future — session is waiting on a check_run / review_comment / synchronize event
              to fire the reactor. Verify the GitHub App is subscribed to those events.
```

## When to abort vs let it run

- Wall-clock has not yet hit `deadline_at` and the iteration count is below `MAX_SHIP_ITERATIONS` → let the tickle scheduler run another cycle.
- Same failure signature has retried `FIX_ATTEMPTS_PER_SIGNATURE_CAP` times → the bot will terminate itself with `flake-cap` on the next check; no manual abort needed.
- Session is genuinely wrong direction → `bot:abort-ship` and re-scope.
