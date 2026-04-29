# Feature Specification: Ship Iteration Wiring

**Feature Branch**: `20260429-212559-ship-iteration-wiring`
**Created**: 2026-04-29
**Status**: Draft
**Input**: User description: "Wire the bot:ship iteration loop and four scoped daemon executors (fix-thread, explain-thread, rebase, open-pr) by bridging the new ship_intents lifecycle to the existing workflow_runs daemon pipeline. Start the tickle scheduler in webhook server boot. Add integration tests + e2e validation. Closes the post-PR-77 integration gap discovered during e2e prep."

## Background _(non-normative)_

The merged PR shepherding spec (`specs/20260427-201332-pr-shepherding-merge-ready`, PR #77) introduced a new `ship_intents` lifecycle alongside the existing `workflow_runs` composite pipeline. End-to-end review uncovered three integration gaps that unit tests passed over:

1. **Iteration loop only handles the terminal-ready shortcut.** When a probe returns a non-ready verdict, the session is created but no follow-up work is enqueued. The relevant branch in the runner logs `"iteration loop pending US2"` and exits.
2. **Tickle scheduler is defined but never started.** The factory exists; no boot path calls it. Paused intents waiting on `ship:tickle` will never wake.
3. **Four scoped commands acknowledge but do not execute.** `bot:rebase`, `bot:fix-thread`, `bot:explain-thread`, and the actionable path of `bot:open-pr` post a "not yet wired" notice instead of doing the work. The policy layer is correct; the daemon-side data plane is missing.

This feature closes those three gaps in a single PR before any end-to-end validation is attempted. The chosen architecture is a **bridge** — the new lifecycle enqueues jobs onto the existing daemon pipeline rather than duplicating clone/Agent SDK glue inside `src/workflows/ship/`.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Iteration loop drives a non-ready PR to merge-ready (Priority: P1)

A maintainer comments `@chrisleekr-bot ship` on a PR that has unresolved review threads, failing checks, or behind-base status. The bot acknowledges the intent, performs each remedial action one at a time, and continues until the PR is merge-ready or hits a terminal halt category (cap/deadline/conflict/maintainer-stop).

**Why this priority**: This is the headline behavior the merged spec promised but does not yet deliver. Without it, `bot:ship` is a no-op for any PR that is not already ready. Every other slice depends on this loop existing.

**Independent Test**: Open a PR with an unresolved review thread; comment `@chrisleekr-bot ship`; observe the tracking comment update through at least one fix iteration; observe the intent transition to `terminal:ready` once all gates pass. Can be tested without tickle scheduler (single iteration) and without the four scoped executors (use a thread-fix path that already works in the legacy pipeline).

**Acceptance Scenarios**:

1. **Given** an open PR with unresolved review threads and a posted `bot:ship` intent in `active` state, **When** a probe returns a non-ready verdict naming the threads as the next action, **Then** the bot enqueues a fix-thread job, awaits its completion, re-probes, and the tracking comment reflects each step.
2. **Given** an active intent and a probe that returns `terminal:ready`, **When** the iteration handler runs, **Then** the intent transitions to terminal state, the tracking comment is finalized, and no further jobs are enqueued.
3. **Given** an active intent that has reached its iteration cap, **When** the next iteration is attempted, **Then** the intent transitions to `terminal:halted:cap` with a clear comment and stops.
4. **Given** an active intent whose deadline has passed, **When** the next iteration is attempted, **Then** the intent transitions to `terminal:halted:deadline` and stops.

---

### User Story 2 - Paused intents wake and resume on schedule (Priority: P2)

A maintainer's `bot:ship` intent enters a paused state because it is waiting on a CI run, a CodeRabbit review, or a base-branch merge by another contributor. When the awaited event fires (or after the configured idle interval), the bot wakes the intent, re-probes the PR, and either continues iterating or transitions to a terminal state.

**Why this priority**: Without this, an intent paused for `awaiting:checks` or `awaiting:review` is effectively dead — the iteration loop in US1 only fires on the initial dispatch. Tickle wiring is what makes the loop multi-round across real-world wait events.

**Independent Test**: Create an intent that the iteration handler decides to pause (e.g., `awaiting:checks`); manually `ZADD ship:tickle 0 <intent>`; observe the scheduler tick fires `onDue`, the resume handler loads the intent, re-probes, and either advances or re-pauses with an updated `due_at`.

**Acceptance Scenarios**:

1. **Given** the webhook server has booted, **When** the boot sequence completes, **Then** the tickle scheduler is running with its tick loop and Postgres reconciliation active.
2. **Given** an intent paused with `due_at = T`, **When** wall-clock reaches `T` or a webhook reactor early-wakes it via `ZADD ship:tickle 0 <intent>`, **Then** the resume handler runs exactly once for that wake.
3. **Given** a resumed intent that re-probes to a non-ready verdict, **When** the resume handler decides the next action is again `awaiting:*`, **Then** a new `due_at` is persisted and the intent stays paused.
4. **Given** a resumed intent whose iteration cap or deadline has tripped, **When** the resume handler runs, **Then** it transitions terminal without enqueuing further work.

---

### User Story 3 - Scoped commands execute deterministically against a PR (Priority: P3)

A maintainer issues a single-shot command — `@chrisleekr-bot rebase`, `bot:fix-thread`, `bot:explain-thread`, or `bot:open-pr` (actionable path) — and the bot performs the requested action against the target PR or thread without going through the multi-iteration `ship` lifecycle.

**Why this priority**: Scoped commands are the maintainer's escape hatch when they want one specific thing done without committing to a full ship. They also serve as the building blocks the iteration loop in US1 can call into. The merged spec's policy layer is correct; only the daemon-side execution is missing.

**Independent Test**: Each verb tested in isolation against a real PR:

- `bot:rebase` — comment on a PR behind its base; verify the bot merges base into head and pushes (no force-push) or halts on conflict with a list of conflicting paths.
- `bot:fix-thread` — comment under a review thread; verify the bot edits the cited code, pushes, and replies on the thread.
- `bot:explain-thread` — comment under a review thread; verify the bot replies with an explanation of the cited code, no commit.
- `bot:open-pr` (actionable) — comment on an issue that already has a verdict; verify a branch is created and a PR opened.

**Acceptance Scenarios**:

1. **Given** a PR whose head is behind its base by N commits and a `bot:rebase` comment, **When** the executor runs, **Then** the merge commit is pushed to the head branch, no force-push occurs, and the bot replies with the merge-commit SHA. On conflict, no push happens and the reply lists the conflicting paths.
2. **Given** a review thread on a PR and a `bot:fix-thread` comment, **When** the executor runs, **Then** the bot clones the head, applies a mechanical fix scoped to the cited code, pushes the change, and posts a thread reply linking to the new commit.
3. **Given** a review thread and a `bot:explain-thread` comment, **When** the executor runs, **Then** the bot reads the cited file range and posts a thread reply with the explanation; no commit, no push.
4. **Given** an issue with an actionable verdict and a `bot:open-pr` comment, **When** the executor runs, **Then** a new branch is created from the default branch, a starter PR is opened against the issue, and the issue is linked.

---

### Edge Cases

- **Closed/merged PR**: rebase, fix-thread, and explain-thread MUST refuse with a polite reply rather than crash.
- **Iteration cap breached during a long-running daemon job**: cap enforcement happens at iteration boundaries, not mid-job; a job that started under the cap completes and its result is processed before the next iteration is rejected.
- **Daemon offline when iteration tries to enqueue**: the job sits on the queue; on the next tickle the resume handler observes the queued state and waits without re-enqueuing duplicates.
- **Stale `ship:tickle` entries** for intents that were already terminated (e.g., via `bot:abort-ship`): the tick loop MUST check intent state before invoking `onDue` and skip terminal intents.
- **Concurrent maintainer command during an active intent**: a `bot:stop` or `bot:abort-ship` posted while a daemon job is running marks the intent paused/terminal; the daemon job completes but its result is dropped (intent state is the source of truth).
- **Force-push refusal at the policy layer**: any attempt by a daemon executor to invoke a force-flag MUST be rejected by the static linter rule (`scripts/check-no-destructive-actions.ts`) at build time; rebase callers MUST receive a structured `RunMergeResult` rather than a raw exec.
- **Probe disagreement across iterations**: if iteration N probes ready but iteration N+1 (after a maintainer-pushed change) probes non-ready, the intent re-enters the active loop — no special "already-ready" lock.

## Requirements _(mandatory)_

### Functional Requirements

#### Iteration loop (US1)

- **FR-001**: System MUST, on a non-ready probe verdict for an active ship intent, select exactly one next action from the verdict and enqueue it onto the existing daemon job queue.
- **FR-002**: System MUST insert one row into `workflow_runs` per iteration that carries the originating `ship_intent_id` so the daemon's completion path can correlate back.
- **FR-003**: System MUST replace the placeholder log `"iteration loop pending US2"` in the non-ready branch of the session runner with a real call into the iteration handler.
- **FR-004**: System MUST evaluate iteration-cap and deadline at the top of every iteration; if either is exceeded, the intent MUST transition to the matching terminal halt category before any job is enqueued.
- **FR-005**: System MUST, on workflow completion for a run carrying a `ship_intent_id`, schedule the intent for early re-entry (e.g., by writing the intent id to the tickle key with `score=0`) so the iteration loop continues without waiting for the next idle tick.

#### Tickle scheduler bootstrap and resume (US2)

- **FR-006**: System MUST start the tickle scheduler exactly once during webhook server boot, with `onDue(intentId)` wired to a resume handler that owns intent re-entry.
- **FR-007**: Resume handler MUST load the latest intent state and continuation, re-run the probe, and either invoke the iteration handler (FR-001) or persist a new pause with an updated `due_at`.
- **FR-008**: Resume handler MUST short-circuit cleanly for intents already in a terminal state (skip without error, do not re-enqueue, do not extend `due_at`).
- **FR-009**: Tickle scheduler MUST reconcile from Postgres on startup so paused intents that survived a restart are re-tracked.
- **FR-010**: Tickle scheduler MUST be stoppable on graceful shutdown without losing pending wakes (Postgres remains the source of truth; the in-memory queue is a cache).

#### Scoped daemon executors (US3)

- **FR-011**: `bot:rebase` MUST execute via a daemon-side executor that merges `origin/<base>` into `<head>` on a fresh clone and pushes the head branch without force-flags. Conflict paths MUST be returned to the policy layer as a structured result.
- **FR-012**: `bot:fix-thread` MUST execute via a daemon-side executor that runs the Agent SDK with a mechanical-fix prompt scoped to the cited file range, pushes the change, and posts a thread reply.
- **FR-013**: `bot:explain-thread` MUST execute via a daemon-side executor that reads the cited code (no clone-and-modify required if read-only) and posts a thread reply. No push, no commit.
- **FR-014**: `bot:open-pr` actionable path MUST execute via a daemon-side executor that creates a branch, scaffolds an initial commit, and opens a PR — replacing the throw inside the `createBranchAndPr` callback site in `src/workflows/ship/scoped/dispatch-scoped.ts`.
- **FR-015**: Each scoped executor MUST be its own `JobKind` on the daemon job queue and MUST reuse the existing daemon WebSocket round-trip rather than introducing a new transport.
- **FR-016**: All scoped executors MUST honor the FR-009 destructive-flag prohibitions inherited from the merged spec; `scripts/check-no-destructive-actions.ts` coverage MUST extend to any new files in `src/daemon/` that touch git.

#### Cross-cutting

- **FR-017**: All new persistence MUST go through the existing `Bun.sql` singleton; no new database connection patterns.
- **FR-018**: All new logs MUST be structured `pino` records with `event` keys following the existing `ship.*` namespace. Concrete event keys introduced by this feature: `ship.iteration.enqueued`, `ship.iteration.terminal_cap`, `ship.iteration.terminal_deadline`; `ship.tickle.started`, `ship.tickle.due`, `ship.tickle.skip_terminal`; `ship.scoped.<verb>.enqueued` and `ship.scoped.<verb>.daemon.completed` (and `.daemon.failed` on halt) for `<verb> ∈ { rebase, fix-thread, explain-thread, open-pr }`. Glob `ship.scoped.*.daemon.*` is the convention for ops dashboards.
- **FR-019**: New code MUST NOT introduce any new npm dependencies.
- **FR-020**: Integration tests MUST cover the full daemon WS round-trip for at least one scoped executor and a tickle re-entry smoke path.
- **FR-021**: An end-to-end validation matrix MUST be exercised against a real GitHub installation (`@chrisleekr-bot-dev` via ngrok) covering at minimum: ship-from-ready, ship-from-thread, ship-with-pause-and-resume, rebase no-op, rebase clean, rebase conflict, fix-thread, explain-thread, open-pr actionable, abort-ship mid-iteration, and stop+resume.

### Retrospective bookkeeping

- **FR-022**: System MUST flip the misclassified `[x]` entries in `specs/20260427-201332-pr-shepherding-merge-ready/tasks.md` to `[~]` with a pointer to this spec for: T021 (tickle bootstrap), T046 (terminal-state mapping), T070 (soak), T071 (flag removal — superseded by T072), T082, T083, T085, T088 (scoped handlers), and T092 (post-merge e2e).

### Key Entities

- **Ship intent**: existing `ship_intents` row; gains no new columns. Lifecycle states (`active`, `paused`, `terminal:*`) and continuation pointers reused as-is.
- **Workflow run**: existing `workflow_runs` row; gains a usage pattern where `ship_intent_id` correlates a daemon execution back to its driving intent.
- **Tickle entry**: Valkey sorted-set entry under `ship:tickle`; score is the wake-up `due_at` in epoch ms.
- **Scoped job**: new `JobKind` variants on the existing daemon job queue: `scoped-rebase`, `scoped-fix-thread`, `scoped-explain-thread`, `scoped-open-pr`.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: 100% of active ship intents driven by a non-ready probe enqueue exactly one daemon job before the iteration handler returns. Verified by integration test, not by wall-clock timing.
- **SC-002**: 100% of paused intents whose `due_at` has elapsed are re-entered by the resume handler on the next tickle-tick after `due_at`. Verified by integration test asserting one re-entry side-effect per due intent per tick (no missed wakes, no duplicate wakes).
- **SC-003**: 0 attempts by any scoped executor to invoke a destructive git flag (force-push, reset --hard, history rewrite). Verified by the existing static linter.
- **SC-004**: All 11 e2e validation scenarios pass end-to-end against `@chrisleekr-bot-dev` before this spec is marked complete.
- **SC-005**: Iteration cap and deadline enforcement reject 100% of iterations that would exceed limits, in both the active and resume paths, with no false negatives.
- **SC-006**: A maintainer who comments `@chrisleekr-bot-dev ship` on a non-ready PR observes the tracking comment update with iteration progress without perceiving an unexplained stall. Verified qualitatively during quickstart S2; no specific wall-clock threshold is asserted automatically.
- **SC-007**: Zero "not yet wired" notices remain in the dispatch path after this feature lands; verified by grep + integration test.

## Assumptions

- The existing `workflow_runs` daemon pipeline (`src/core/pipeline.ts` clone+Agent SDK+push) is correct and complete; this feature bridges to it rather than reimplementing it.
- The existing tickle scheduler factory (`createTickleScheduler`) is correct; the gap is that it is never started. No changes to its internals are required by this spec.
- The merged spec's policy layer for scoped commands (`src/workflows/ship/scoped/*.ts`) is correct; each scoped command exposes a callback (e.g., `runMerge`, `createBranchAndPr`) that the new daemon-side executors will satisfy.
- `@chrisleekr-bot-dev` via ngrok is the e2e target; production `@chrisleekr-bot` is not part of validation.
- Iteration cap (`MAX_SHIP_ITERATIONS`) and deadline (`MAX_WALL_CLOCK_PER_SHIP_RUN`) come from the existing Zod config schema in `src/config.ts`; no new env vars are introduced.
- One scoped action per iteration is sufficient — the loop runs many iterations rather than packing multiple actions into one. Parallelism within an iteration is out of scope.
- The webhook reactor in `src/workflows/orchestrator.ts` already has the right entry point to early-wake intents on workflow completion; only the conditional `ZADD` is missing.
- Test coverage thresholds (90% per-file lines + functions, the project default) apply to all new files; no exemptions.
