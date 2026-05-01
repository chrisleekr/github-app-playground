# Phase 0 Research: Ship Iteration Wiring

**Feature**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)
**Date**: 2026-04-29

This document resolves the open technical questions identified while drafting `plan.md`. Each question follows the speckit format: Decision / Rationale / Alternatives Considered.

---

## Q1. Correlating `workflow_runs` completions back to a `ship_intent`

**Question**: When the iteration handler inserts a `workflow_runs` row for a daemon job (e.g., a `resolve-thread` or `branch-refresh` step driven by ship's iteration), how does the orchestrator's completion cascade learn that this run belongs to a ship intent so it can early-wake the intent via `ZADD ship:tickle 0 <intent>`?

### Decision A: Store `shipIntentId` inside `workflow_runs.context_json`

The iteration handler writes the originating intent UUID into `context_json.shipIntentId` when inserting the row. The orchestrator cascade in `src/workflows/orchestrator.ts` already reads `context_json` to resolve `WorkflowContext`; on completion it inspects the same blob for `shipIntentId` and, if present, performs `ZADD ship:tickle 0 <intent>`.

### Rationale

- **Zero schema change.** `workflow_runs.context_json` is already JSONB and ad-hoc per-workflow data lives there today (verified by reading `005_workflow_runs.sql` and `006_workflow_runs_ownership.sql`).
- **Backward compatible.** Existing rows without `shipIntentId` are unaffected — the cascade simply skips the `ZADD`.
- **Queryability is sufficient via JSONB index if needed later.** Operators can `WHERE context_json ->> 'shipIntentId' = $1` for diagnostics; if this becomes hot, a partial expression index can be added without invalidating the contract.
- **Aligns with existing pattern.** Other run-correlation fields (`parentRunId`, `parentStepIndex`) are also threaded through context, not as first-class columns.

### Alternatives considered

- **Add a nullable `ship_intent_id` column on `workflow_runs`.** Rejected: requires a migration (009) for a single-purpose column; column would be NULL for the vast majority of rows; foreign key into `ship_intents` would couple two lifecycles that have intentionally separate ownership.
- **Use the existing `parent_run_id` column with a synthetic parent.** Rejected: `parent_run_id` is for run-tree composition (e.g., `ship` composite → child steps), not for cross-aggregate pointers; overloading it would break the run-tree query semantics.

### Implementation note

`WorkflowRunRef` (in `src/shared/workflow-types.ts`) does **not** need to grow a new field — the daemon doesn't need to know about `shipIntentId` to execute the job. Only the orchestrator's completion handler reads it, and it does so via `context_json` lookup.

---

## Q2. JobKind taxonomy for the four scoped executors

**Question**: Should the four scoped commands (`bot:rebase`, `bot:fix-thread`, `bot:explain-thread`, `bot:open-pr`) share one umbrella `JobKind` with a sub-discriminator, or should each have its own `JobKind`?

### Decision: Per-executor JobKind

Four new values: `scoped-rebase`, `scoped-fix-thread`, `scoped-explain-thread`, `scoped-open-pr`.

### Rationale

- **Clean dispatch.** The daemon's job-router (`src/daemon/job-executor.ts`) switches on `JobKind`. Per-executor kinds give a flat, exhaustive `switch` without nested discrimination.
- **Per-kind observability.** Pino logs and any future metric labels read `kind` directly — operators can ask "how many rebases ran today?" without pivoting on a sub-field.
- **Type-safe payloads.** Each kind owns its own Zod schema in `ws-messages.ts`. With a single umbrella kind we'd carry a discriminated union nested inside the payload, which is harder to validate at the WS boundary.
- **Existing precedent.** The merged spec already uses one-handler-per-file under `src/workflows/ship/scoped/`; one-kind-per-executor on the daemon side mirrors that choice.

### Alternatives considered

- **Single `scoped-command` kind with `scoped_kind: 'rebase' | 'fix-thread' | ...` discriminator.** Rejected: pushes the dispatch logic from a flat switch into nested branching; complicates per-kind authorization checks if those diverge in the future; muddies metric labels.

---

## Q3. Tickle scheduler dependency wiring at boot

**Question**: The `createTickleScheduler` factory needs a `RedisClient` (for `ship:tickle` ZSET ops), a `Bun.sql` reference (for `reconcileFromPostgres`), and an `onDue(intentId)` callback. Where in `src/app.ts`'s startup sequence does it run, and where does it get its dependencies?

### Decision: Wire alongside the orchestrator's `start()`, using the same singleton accessors

In `src/app.ts`, after the orchestrator and database initialisations succeed but before the HTTP server starts accepting traffic, call:

```ts
const tickleScheduler = createTickleScheduler({
  valkey: requireValkeyClient(),
  // sql/intervalMs default to config — no need to inject explicitly
  onDue: (intent_id) => resumeShipIntent({ intentId: intent_id }),
});
await tickleScheduler.start();
```

On graceful shutdown (existing `SIGTERM`/`SIGINT` handler), call `tickleScheduler.stop()` before draining HTTP.

### Rationale

- **Same lifecycle slot as the orchestrator.** The orchestrator already runs in the webhook server process and uses the same Valkey/Postgres singletons; placing the scheduler beside it keeps boot ordering predictable.
- **`start()` performs reconciliation internally.** Verified in `src/workflows/ship/tickle-scheduler.ts`: the public surface is `start()` + `stop()`, and `start()` runs the boot reconciliation against `ship_continuations` before beginning the periodic scan. Callers MUST `await start()` once and need not invoke any separate reconcile method.
- **Graceful shutdown ordering.** Stopping the scheduler before HTTP drain ensures no `onDue` callback fires while the server is mid-shutdown. `stop()` is synchronous (cancels the timer) and idempotent.
- **Parameter naming convention.** `onDue` receives `intent_id` (snake_case) per the existing `TickleSchedulerDeps` interface; the resume handler converts to `intentId` (camelCase) at the boundary.

### Alternatives considered

- **Run the scheduler in the daemon process.** Rejected: paused intents are server-side state, and the tickle scheduler must call `resumeShipIntent` which lives in the same address space as the rest of the ship session machinery. Running it in the daemon would require a new RPC for resume, which violates the no-new-transport plan.
- **Run the scheduler in a separate worker process / cron.** Rejected: introduces an additional deployment artefact and a third process to manage; fails the Constitution's Single-Server preference for no good reason.

---

## Q4. Iteration handler — one action per iteration vs. batched actions

(Documented in spec.md Assumptions; restated here so the implementation does not drift.)

**Decision**: Exactly one daemon job per iteration. The loop runs many iterations rather than packing actions.

**Rationale**: Each daemon job mutates PR state (pushes a commit, posts a comment, resolves a thread). Re-probing between actions is the only way to detect that a single fix made the PR ready, or that a fix triggered a new failing check. Batching would collapse this feedback and risk wasted work on later actions.

**Alternative considered**: Multi-action iterations gated by a "fast-path" check. Rejected: complicates the verdict→action selection logic and the failure-attribution telemetry.

---

## Q5. Bridge to `workflow_runs` vs. duplicate pipeline inside `src/workflows/ship/`

(High-level decision confirmed by user; documented here for spec/plan traceability.)

**Decision**: Bridge — iteration handler enqueues onto the existing daemon pipeline.

**Rationale**: The existing `src/core/pipeline.ts` already does clone + Agent SDK + push + cleanup. Reimplementing this inside `src/workflows/ship/` would duplicate ~300 lines of clone/temp-dir/cleanup logic and create two parallel agent-execution paths, doubling the surface area for security and resource-leak bugs.

**Alternative considered**: Duplicate the pipeline inside `src/workflows/ship/` so the new lifecycle is self-contained. Rejected as documented above.

---

## Open questions

None. All `[NEEDS CLARIFICATION]` markers from spec.md have been resolved (the spec finished with zero such markers; this research file documents the technical decisions that informed informed defaults).
