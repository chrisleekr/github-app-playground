# Quickstart: Ship Iteration Wiring End-to-End Validation

**Feature**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)
**Date**: 2026-04-29

This document is the operator playbook for validating the full feature against a real GitHub installation. SC-004 requires all 11 scenarios below to pass before the feature is marked complete.

---

## Prerequisites

- `@chrisleekr-bot-dev` GitHub App installation reachable via ngrok (env `TRIGGER_PHRASE=@chrisleekr-bot-dev` per saved memory).
- Local stack running: `bun run dev:deps` (Postgres + Valkey), `bun run dev` (webhook server), and one daemon process (`bun run src/daemon/main.ts` or whatever the project's documented daemon launch is).
- ngrok tunnel pointing the GitHub App webhook URL at the local server.
- A test repository with the App installed; a maintainer who can post comments and create PRs/issues.
- A way to inspect Postgres (`psql` against `DATABASE_URL`) and Valkey (`valkey-cli` or `redis-cli`).

## Pre-flight

1. **Tickle scheduler is running.** Look for a startup log line: `event=ship.tickle.started`. If absent, the new boot wiring is broken; abort.
2. **No "not yet wired" notices in code.** Run `grep -rn "not yet wired" src/` — must return zero matches.
3. **Static destructive-flag check passes.** Run `bun run scripts/check-no-destructive-actions.ts` (or whichever invocation the project uses) — must exit 0.

---

## Scenarios

For each scenario below, record the result in a worksheet (pass/fail + observed behavior) before moving on.

### S1 — ship-from-ready (regression)

**Setup**: Open a PR with no unresolved review threads, all checks green, up-to-date with base.

**Action**: Comment `@chrisleekr-bot-dev ship`.

**Expected**: Tracking comment posts, intent goes straight to `ready_awaiting_human_merge` terminal state, no daemon job enqueued (verify via `valkey-cli LLEN queue:jobs`).

**Why this scenario**: regression check that the merged spec's terminal-ready shortcut still works alongside the new iteration loop.

---

### S2 — ship-from-thread

**Setup**: Open a PR with one unresolved review thread that asks for a small mechanical change.

**Action**: Comment `@chrisleekr-bot-dev ship`.

**Expected**:

- Tracking comment posts and updates over time.
- One `workflow_runs` row inserted with `context_json.shipIntentId` set.
- Daemon picks up the job, applies the fix, pushes a commit.
- Orchestrator cascade `ZADD ship:tickle 0 <intent>` after completion.
- Resume handler re-probes; verdict is now ready; intent terminates.

**Verify**:

- `psql -c "SELECT id, status FROM ship_intents WHERE pr_number = N"` shows terminal status.
- `psql -c "SELECT context_json->>'shipIntentId' FROM workflow_runs WHERE ..."` returns the intent id.

---

### S3 — ship-with-pause-and-resume

**Setup**: Open a PR where the next action is `awaiting:checks` (e.g., a long CI run).

**Action**: Comment `@chrisleekr-bot-dev ship`.

**Expected**:

- Intent transitions to `paused` after the first iteration.
- `valkey-cli ZRANGE ship:tickle 0 -1 WITHSCORES` shows the intent with a future score.
- When CI completes, the orchestrator early-wakes via `ZADD ship:tickle 0 <intent>`.
- Resume handler runs, re-probes, advances or terminates.

**Verify**: `event=ship.tickle.due` log line fires for the intent id.

---

### S4 — rebase no-op

**Setup**: PR head is already up-to-date with base.

**Action**: Comment `@chrisleekr-bot-dev rebase`.

**Expected**: Bot replies "Already up to date with `<base>` — nothing to merge." No commit, no push.

---

### S5 — rebase clean

**Setup**: PR head is N commits behind base, no conflicts.

**Action**: Comment `@chrisleekr-bot-dev rebase`.

**Expected**: Bot merges base into head, pushes a merge commit, replies with the merge commit SHA. **Verify no force-push** in the GitHub event log.

---

### S6 — rebase conflict

**Setup**: PR head conflicts with base.

**Action**: Comment `@chrisleekr-bot-dev rebase`.

**Expected**: Bot replies with conflict notice + list of conflicting paths. No commit, no push.

---

### S7 — fix-thread

**Setup**: Open review thread asking for a single-line change.

**Action**: Reply on the thread with `@chrisleekr-bot-dev fix-thread`.

**Expected**: Bot pushes a commit limited to the cited file range, posts thread reply linking to the commit SHA, resolves the thread.

---

### S8 — explain-thread

**Setup**: Open review thread asking what some code does.

**Action**: Reply on the thread with `@chrisleekr-bot-dev explain-thread`.

**Expected**: Bot posts a thread reply explaining the cited code. **No commit, no push, thread NOT resolved**.

---

### S9 — open-pr actionable

**Setup**: An issue with an actionable verdict (e.g., a small feature request the bot has previously triaged as "ready to scaffold").

**Action**: Comment `@chrisleekr-bot-dev open-pr` on the issue.

**Expected**: New branch created from default; starter PR opened against default; issue gets a comment linking to the new PR.

---

### S10 — abort-ship mid-iteration

**Setup**: Active intent in the middle of an iteration (e.g., during S2 between probe and daemon completion).

**Action**: Comment `@chrisleekr-bot-dev abort-ship`.

**Expected**: Intent transitions to `aborted_by_user`. The in-flight daemon job completes but its result is discarded (no further iteration). Tracking comment finalizes.

---

### S11 — stop + resume

**Setup**: Active intent.

**Action 1**: Comment `@chrisleekr-bot-dev stop`. Verify intent is `paused` and no further iterations enqueue.

**Action 2** (>1 minute later): Comment `@chrisleekr-bot-dev resume`. Verify intent goes back to `active` and a new iteration is enqueued within 10 seconds.

---

## Pass criteria

- **All 11 scenarios pass.**
- **Zero unexpected destructive-flag invocations** in any daemon-side log.
- **No orphaned temp directories** left in the daemon's tempfs after the run (check `du -sh` of the daemon's temp root before and after).
- **Cost reporting** appears in the per-job completion log (`costUsd`, `durationMs`).

## On failure

- Capture the daemon log around the failure window.
- Capture `psql` snapshot of the affected `ship_intents`, `ship_iterations`, `ship_continuations`, `workflow_runs` rows.
- Capture `valkey-cli` snapshot of `ship:tickle` and `queue:jobs`.
- File a follow-up entry against this spec rather than masking with a workaround.
