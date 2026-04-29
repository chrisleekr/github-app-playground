# Phase 1 Data Model: Ship Iteration Wiring

**Feature**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)
**Date**: 2026-04-29

This feature adds **no new tables** and **no new columns**. It introduces new read/write touch-points on existing tables, plus four new payload variants on the existing job queue. This document enumerates them so reviewers can verify the entity-level invariants without re-reading every source file.

---

## Postgres tables (existing, unchanged)

### `ship_intents`

Created by migration `008_ship_intents.sql`. One row per `bot:ship` session.

**New touch-points in this feature**:

- **Read**: `iteration.ts` loads the active intent by id at the start of each iteration to evaluate cap/deadline.
- **Read**: `resumeShipIntent` (new) loads the intent at tickle wake-up.
- **Write**: terminal-state transitions (`deadline_exceeded`, `aborted_by_user`, `human_took_over`, `ready_awaiting_human_merge`) occur via the **existing** transition helpers — this feature adds no new column writes.

**Invariants honored** (already enforced by the table):

- `ship_intents_one_active_per_pr` unique index — only one non-terminal intent per (owner, repo, pr_number). Iteration handler must never create a parallel intent.
- `status` CHECK constraint — terminal categories named in the FR list match the existing enum (`merged_externally`, `ready_awaiting_human_merge`, `deadline_exceeded`, `human_took_over`, `aborted_by_user`, `pr_closed`).

### `ship_iterations`

Insert-only audit trail (one row per probe/resolve/review/branch-refresh).

**New touch-points**:

- **Write**: `iteration.ts` appends one row per iteration step it drives. Existing fields suffice — the row records the action selected and the `workflow_run_id` it enqueued.

### `ship_continuations`

Mutable per-intent yield state (StateBlobV1).

**New touch-points**:

- **Read**: `resumeShipIntent` reads the latest `state_blob` to know where the previous iteration left off.
- **Write**: `iteration.ts` updates the blob via the existing helper after each iteration. No new fields.

### `ship_fix_attempts`

Per-(intent, signature) retry ledger. **No new touch-points** — existing logic in `fix-attempts.ts` continues to own this table.

### `workflow_runs`

Created by migration `005_workflow_runs.sql`; ownership tightened by `006_workflow_runs_ownership.sql`.

**New touch-points**:

- **Write**: `iteration.ts` inserts one row per iteration with `context_json.shipIntentId` set to the originating intent UUID. All other columns follow the existing convention (e.g., `parent_run_id`, `workflow_name`, `step_index`).
- **Read**: `src/workflows/orchestrator.ts` cascade reads `context_json.shipIntentId` on completion and, if present, executes `ZADD ship:tickle 0 <intent>` against Valkey.

**Schema convention** (no migration; documented for reviewer):

```jsonc
// workflow_runs.context_json shape for iteration-driven runs
{
  // ...existing fields (workflowName, repoOwner, repoName, etc.)
  "shipIntentId": "550e8400-e29b-41d4-a716-446655440000",
}
```

---

## Valkey keys (existing, unchanged)

### `ship:tickle` (sorted set)

- **Score**: `due_at` epoch milliseconds.
- **Member**: `ship_intent.id` UUID string.
- **New writers**: `iteration.ts` adds entries when it decides the next action is `awaiting:*` (using `due_at` from continuation). Orchestrator cascade adds entries with `score=0` to early-wake on workflow completion.
- **Reader**: `tickle-scheduler.ts` (existing) tick loop pops members whose score has elapsed and invokes the new `onDue(intentId)` callback.

### `queue:jobs` (list)

- **Existing format**: `QueuedJob` JSON; daemon `BRPOP`s from the tail.
- **New variants**: four scoped-job variants (see [contracts/job-kinds.md](./contracts/job-kinds.md)).

---

## Application-layer types (TypeScript)

### `WorkflowRunRef` (existing, unchanged)

`src/shared/workflow-types.ts`. Daemon branches on its presence; this feature does not modify the type.

### `QueuedJob` (existing, **EXTENDED** in implementation)

`src/orchestrator/job-queue.ts`. Today the type is a single shape with an optional `workflowRun?: WorkflowRunRef`. This feature adds a discriminated union to support scoped-job payloads:

```ts
// Sketch (final shape lives in implementation, not this doc):
export type QueuedJob =
  | LegacyOrWorkflowQueuedJob // existing shape, unchanged
  | ScopedRebaseQueuedJob
  | ScopedFixThreadQueuedJob
  | ScopedExplainThreadQueuedJob
  | ScopedOpenPrQueuedJob;
```

Each scoped variant carries `kind: 'scoped-rebase' | ...` plus the minimum context the daemon needs to run the executor. Full payload schemas in [contracts/job-kinds.md](./contracts/job-kinds.md).

### `ws-messages.ts` (existing, **EXTENDED**)

`src/shared/ws-messages.ts`. Today carries job-offer / accept / reject / completion messages for legacy and workflow runs. This feature adds offer + completion variants for each scoped `JobKind`. Full schemas in [contracts/ws-messages.md](./contracts/ws-messages.md).

---

## State transitions

### Intent lifecycle (no new states; transitions happen at new sites)

```text
                +-------+
created  ------>+active +------+
                +---+---+      |
                    |          |
   probe non-ready  v          v  cap/deadline tripped
                +---+---+    +-------+
                | active|--->|terminal:halted:cap
                | iter+1|    |terminal:halted:deadline
                +---+---+    +-------+
                    |
   awaiting:* verdict
                    v
                +-------+    onDue(intent) (tickle)
                | paused|<-->| resume → re-probe
                +---+---+
                    |
                    v   probe ready / cap / deadline
                +-------+
                |terminal|
                +-------+
```

(The state names are the existing `ship_intents.status` values; `paused` and `active` are non-terminal, all others are terminal.)

### Workflow-run lifecycle

Unchanged. The new code piggybacks on the existing run state machine; `context_json.shipIntentId` is metadata, not state.

---

## Validation rules

- **`shipIntentId` in `context_json`** — when present, MUST be a valid UUID v4 string AND MUST reference a `ship_intents.id` whose `status` is non-terminal at insert time. Validated in `iteration.ts` before insert.
- **Tickle ZADD on completion** — only fires when `context_json.shipIntentId` is present AND the intent is still non-terminal at completion time (avoid stale wakes). Re-checked in the orchestrator cascade.
- **One iteration in flight per intent** — enforced implicitly by the existing `ship_intents_one_active_per_pr` unique index plus the iteration handler's check that the intent has no in-flight `workflow_runs` row before enqueuing the next one.
