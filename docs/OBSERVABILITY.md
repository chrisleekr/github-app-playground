# Observability

Structured JSON logs via [pino](https://getpino.io) are the primary signal. Every dispatch decision and every pipeline step carries a `deliveryId` so you can reconstruct a request end-to-end from a single log query. When `DATABASE_URL` is configured, the same information is also persisted to the `executions` and `triage_results` tables for aggregate reporting.

## Log fields

| Field                    | What it means                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| `deliveryId`             | `X-GitHub-Delivery` header — stable across every log line for a single webhook.                       |
| `event`                  | GitHub event name (`pull_request`, `issue_comment`, …).                                               |
| `repo`                   | `owner/name` of the triggering repo.                                                                  |
| `dispatch_target`        | Always `daemon` (singleton — kept as a field for DB/log stability).                                   |
| `dispatch_reason`        | Why the job landed where it did. See below.                                                           |
| `isEphemeral`            | Present on daemon-originating log lines. `true` if emitted by an ephemeral daemon, `false` otherwise. |
| `triage_fallback_reason` | Only present on triage fallbacks — one of the six values in [Triage](TRIAGE.md#fallback-reasons).     |
| `confidence`             | Triage confidence (0–1), only when the decision came from triage.                                     |
| `heavy`                  | Triage binary signal (`true`/`false`) — only on triage-success.                                       |
| `rationale`              | Free-text rationale from the triage LLM. Only on triage-success.                                      |
| `cost_usd`               | Agent-reported total cost from the SDK. Present on completed executions.                              |
| `workflowRunId`          | UUID of the `workflow_runs` row — stable per bot workflow run. See [Bot Workflows](BOT-WORKFLOWS.md). |
| `workflowName`           | Workflow name (`triage`, `plan`, `implement`, `review`, `ship`). Emitted by dispatcher and handlers.  |
| `ship_duration_ms`       | Composite `ship` wall-clock duration measured from parent enqueue to terminal status.                 |
| `intentWorkflow`         | Intent-classifier verdict for comment triggers (includes `clarify`/`unsupported`).                    |
| `intentConfidence`       | Intent-classifier confidence (0–1). Dispatcher compares to `INTENT_CONFIDENCE_THRESHOLD`.             |

## Ship-workflow log fields (FR-016)

The `bot:ship` lifecycle emits structured pino log lines validated against the canonical Zod schema in `src/workflows/ship/log-fields.ts`. The schema is consumed by every emitter (probe, intent transitions, reactor fan-out) so field names and types do not drift between modules.

| Field                       | Type                                                                            | When present                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `event`                     | string (e.g. `ship.intent.transition`, `ship.probe.run`, `ship.reactor.fanout`) | Always                                                                                         |
| `intent_id`                 | UUID                                                                            | Always                                                                                         |
| `pr`                        | `{owner, repo, number, installation_id}`                                        | Always                                                                                         |
| `iteration_n`               | non-negative int                                                                | Always (0 on pre-iteration events)                                                             |
| `phase`                     | `probe` \| `fix` \| `reply` \| `wait` \| `terminal`                             | Iteration events                                                                               |
| `from_status` / `to_status` | `SessionStatus`                                                                 | Transition events only                                                                         |
| `terminal_blocker_category` | `BlockerCategory`                                                               | Terminal `human_took_over` transitions                                                         |
| `non_readiness_reason`      | `NonReadinessReason`                                                            | Probe events with non-ready verdict                                                            |
| `trigger_surface`           | `literal` \| `nl` \| `label`                                                    | Session-start events only (FR-027)                                                             |
| `principal_login`           | string                                                                          | Session-start events only                                                                      |
| `spent_usd_cents`           | non-negative integer                                                            | Always — cumulative session spend (cents, NOT float, to avoid binary-fp drift in aggregations) |
| `wall_clock_ms`             | non-negative integer                                                            | Always — cumulative session wall-clock                                                         |
| `delta_usd_cents`           | non-negative integer                                                            | Per-event spend (iteration events only)                                                        |
| `delta_ms`                  | non-negative integer                                                            | Per-event wall-clock duration                                                                  |

**Querying example** (Datadog / Loki):

```text
event:"ship.intent.transition" to_status:"human_took_over" terminal_blocker_category:"flake-cap"
| count by pr.repo
```

The schema is the **source of truth**. Adding or renaming a field requires updating `src/workflows/ship/log-fields.ts`; the co-located `log-fields.test.ts` round-trips a sample through the schema and rejects unknown / mistyped fields, so silent drift fails CI.

### Iteration / tickle / scoped event keys (FR-018)

Every ship-iteration-wiring emitter draws its `event` value from the typed `SHIP_LOG_EVENTS` constant in `src/workflows/ship/log-fields.ts`. A typo is therefore a compile error, and operators can grep for these literals deterministically.

| Event key                             | Where it fires                                                                            | What it indicates                                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `ship.iteration.enqueued`             | `iteration.runIteration` after `enqueueJob`                                               | A non-ready verdict bridged into the daemon `workflow_runs` pipeline. One row per iteration.                   |
| `ship.iteration.terminal_cap`         | `iteration.runIteration` cap check                                                        | The intent hit `MAX_SHIP_ITERATIONS` and was transitioned to `deadline_exceeded` with `iteration-cap` blocker. |
| `ship.iteration.terminal_deadline`    | `iteration.runIteration` deadline check                                                   | The intent's `deadline_at` elapsed; transitioned to `deadline_exceeded`.                                       |
| `ship.tickle.started`                 | `app.ts` boot, after `tickleScheduler.start()`                                            | The cron tickle scheduler is now scanning `ship:tickle`. Quickstart S0 pre-flight asserts on this line.        |
| `ship.tickle.due`                     | `orchestrator.onStepComplete` early-wake **OR** `session-runner.resumeShipIntent`         | An intent is being re-entered. `source` field discriminates `workflow_run_completion` vs scheduler.            |
| `ship.tickle.skip_terminal`           | `orchestrator.onStepComplete` early-wake                                                  | The hook found a `shipIntentId` but the intent is already terminal (or missing); ZADD was skipped.             |
| `ship.scoped.<verb>.enqueued`         | `dispatch-scoped.ts` after `enqueueJob`                                                   | A scoped command (`rebase` / `fix_thread` / `explain_thread` / `open_pr`) was enqueued for daemon dispatch.    |
| `ship.scoped.<verb>.daemon.completed` | `connection-handler.handleScopedJobCompletion` (orchestrator) **AND** the executor itself | Daemon reported successful completion. The bridge logs at this key on `status === "succeeded"`.                |
| `ship.scoped.<verb>.daemon.failed`    | Same handler / executor                                                                   | Daemon reported `halted` or `failed`. `reason` field carries the structured halt reason.                       |

`<verb>` ∈ `rebase`, `fix_thread`, `explain_thread`, `open_pr`. The literal strings live as nested const properties on `SHIP_LOG_EVENTS` so a Datadog search like `event:"ship.scoped.rebase.daemon.completed"` is guaranteed to match the emitter.

## Dispatch reasons

Canonical source: `src/shared/dispatch-types.ts`. Four values, all landing on `dispatch_target=daemon`.

| Reason                      | When the router sets it                                                                                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `persistent-daemon`         | Routed to an existing persistent daemon. The default, hot path. Also used on cooldown — when a scale-up was warranted but blocked by the cooldown window. |
| `ephemeral-daemon-triage`   | Triage returned `heavy=true` and an ephemeral daemon Pod was spawned to claim the job.                                                                    |
| `ephemeral-daemon-overflow` | Queue length ≥ `EPHEMERAL_DAEMON_SPAWN_QUEUE_THRESHOLD` **and** the persistent pool is saturated (zero free slots); a spawn drains the overflow.          |
| `ephemeral-spawn-failed`    | A spawn was required but the K8s API call failed. The job is rejected with a tracking-comment infra error.                                                |

## Aggregate reporting

When `DATABASE_URL` is set, helpers in `src/db/queries/dispatch-stats.ts` expose the most operator-relevant aggregates. Call them from an internal admin endpoint, a scheduled job, or `bun repl`:

| Helper                           | Returns                                                                                                                                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eventsPerTarget(days)`          | Count of executions grouped by `dispatch_target`. Post-collapse this is always a single `daemon` row — useful only as a liveness counter; query `dispatch_reason` directly for the per-reason split. |
| `triageRate(days)`               | Share of events whose `dispatch_reason` is `ephemeral-daemon-triage` (i.e. triage drove an ephemeral spawn) vs. all events.                                                                          |
| `avgConfidenceAndFallback(days)` | Mean triage confidence plus fallback counts by reason.                                                                                                                                               |
| `triageSpend(days)`              | Cumulative `cost_usd` for triage-reached executions.                                                                                                                                                 |

## Alerts worth having

- **Triage error rate**. `parse-error` + `llm-error` + `timeout` + `circuit-open` above a sustained threshold (e.g. 10% over 15 minutes) signals provider trouble or a regression.
- **Ephemeral spawn failures**. Any `dispatch_reason=ephemeral-spawn-failed` points at RBAC, quota, or control-plane issues. The affected request fails with a tracking-comment infra error.
- **Heartbeat drift**. Daemons missing heartbeats past `HEARTBEAT_TIMEOUT_MS` get evicted — sustained eviction points at network or resource-floor issues.
- **OOM / crash loops**. Standard infra alerts. The durable idempotency check means a restart won't replay a processed event, but a crash loop still blocks new ones.

## Health probes

| Path       | Purpose                                                                          |
| ---------- | -------------------------------------------------------------------------------- |
| `/healthz` | Liveness. Returns 200 once the HTTP server is bound.                             |
| `/readyz`  | Readiness. Returns 200 once config is validated and the data layer is reachable. |
