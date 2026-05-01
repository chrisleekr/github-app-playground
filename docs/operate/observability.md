# Observability

Structured JSON logs via [pino](https://getpino.io) are the primary signal. Every dispatch decision and every pipeline step carries a `deliveryId` so you can reconstruct a request end-to-end from a single log query. When `DATABASE_URL` is configured, the same information is persisted to `executions` and `triage_results` for aggregate reporting.

## Log redaction

The root pino instance at `src/logger.ts:174` is the canonical chokepoint for secret scrubbing — every child logger inherits its `redact.paths` list and its custom `err` serializer, so individual call sites do not need to remember to scrub. Two layers run on every emitted line:

1. **Path-based redaction** (`src/logger.ts:17`) — pino replaces matching field values with `[Redacted]` before the JSON is serialised. Paths covered: `authorization` and its `*.authorization` / `headers.authorization` / `*.headers.authorization` / `req.headers.authorization` / `request.headers.authorization` variants; the webhook signature header `x-hub-signature-256` (also wildcard-prefixed); `response.data.token`; and the named credential fields `token`, `installationToken`, `privateKey`, `webhookSecret`, `anthropicApiKey`, `claudeCodeOauthToken`, `daemonAuthToken`, `awsSecretAccessKey`, `awsSessionToken`, `awsBearerTokenBedrock`, `*.password`.

2. **`err` serializer scrubbing** (`src/logger.ts:113`) — defers to pino's `stdSerializers.err` and then runs the result's `message`, `stack`, `request.headers.*`, and `response.data` through `redactGitHubTokens` (`src/utils/sanitize.ts:77`) plus an inline credential-URL scrubber that mirrors `redactValkeyUrl` (`src/orchestrator/valkey.ts:64`). This catches free-text leakage that path-based rules cannot match — notably an Octokit `RequestError` whose `err.request.headers.authorization` sits 4 segments below the log root, and `ghs_…` installation tokens echoed inside `err.message` / `err.stack`.

The serializer operates on a copy, so the original Error instance is never mutated.

If you add a new secret-bearing config field to `src/config.ts`, add its property name to `REDACT_PATHS` in the same PR. The point helpers `redactGitHubTokens` and `redactValkeyUrl` remain in place for their non-log call sites (prompt sanitisation and the Valkey startup info log respectively); the logger config is the system-wide default.

## Common log fields

| Field                                | Meaning                                                                                               |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `deliveryId`                         | `X-GitHub-Delivery` header — stable across every log line for a single webhook.                       |
| `event`                              | GitHub event name (`pull_request`, `issue_comment`, …) or canonical event key for ship workflow logs. |
| `repo`                               | `owner/name` of the triggering repo.                                                                  |
| `dispatch_target`                    | Always `daemon` (singleton — kept as a field for DB/log stability).                                   |
| `dispatch_reason`                    | Why the job landed where it did. See [Dispatch reasons](#dispatch-reasons).                           |
| `isEphemeral`                        | Present on daemon-originating log lines. `true` if emitted by an ephemeral daemon.                    |
| `triage_fallback_reason`             | Only present on triage fallbacks — see [`runbooks/triage.md`](runbooks/triage.md).                    |
| `confidence`, `heavy`, `rationale`   | Triage outputs on success.                                                                            |
| `cost_usd`                           | Agent-reported total cost from the SDK.                                                               |
| `workflowRunId`, `workflowName`      | UUID of the `workflow_runs` row + workflow name. Stable per run.                                      |
| `intentWorkflow`, `intentConfidence` | Intent-classifier verdict and confidence for comment triggers.                                        |

## Ship workflow log fields

The shepherding lifecycle emits structured pino lines validated against the canonical Zod schema in `src/workflows/ship/log-fields.ts`. Field names and types are pinned so emitters cannot drift.

| Field                       | Type                                                                            | When present                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `event`                     | string (e.g. `ship.intent.transition`, `ship.probe.run`, `ship.reactor.fanout`) | Always.                                                                                        |
| `intent_id`                 | UUID                                                                            | Always.                                                                                        |
| `pr`                        | `{owner, repo, number, installation_id}`                                        | Always.                                                                                        |
| `iteration_n`               | non-negative int                                                                | Always (0 on pre-iteration events).                                                            |
| `phase`                     | `probe` \| `fix` \| `reply` \| `wait` \| `terminal`                             | Iteration events.                                                                              |
| `from_status` / `to_status` | session status                                                                  | Transition events only.                                                                        |
| `terminal_blocker_category` | blocker category                                                                | Terminal `human_took_over` transitions.                                                        |
| `non_readiness_reason`      | enum                                                                            | Probe events with non-ready verdict.                                                           |
| `trigger_surface`           | `literal` \| `nl` \| `label`                                                    | Session-start events only.                                                                     |
| `principal_login`           | string                                                                          | Session-start events only.                                                                     |
| `spent_usd_cents`           | non-negative integer                                                            | Always — cumulative session spend in cents (integer to avoid binary-fp drift in aggregations). |
| `wall_clock_ms`             | non-negative integer                                                            | Always — cumulative session wall-clock.                                                        |
| `delta_usd_cents`           | non-negative integer                                                            | Per-event spend (iteration events only).                                                       |
| `delta_ms`                  | non-negative integer                                                            | Per-event wall-clock duration.                                                                 |

The schema is the source of truth. Adding or renaming a field requires updating `src/workflows/ship/log-fields.ts`; the co-located test round-trips a sample through the schema and rejects unknown / mistyped fields.

### Iteration / tickle / scoped event keys

Every shepherding emitter draws its `event` value from the typed `SHIP_LOG_EVENTS` constant in `src/workflows/ship/log-fields.ts`. Operators can grep for these literals deterministically.

| Event key                             | Where it fires                                                                    | What it indicates                                                                             |
| ------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `ship.iteration.enqueued`             | `iteration.runIteration` after `enqueueJob`                                       | A non-ready verdict bridged into the daemon `workflow_runs` pipeline. One row per iteration.  |
| `ship.iteration.terminal_cap`         | `iteration.runIteration` cap check                                                | The intent hit `MAX_SHIP_ITERATIONS`.                                                         |
| `ship.iteration.terminal_deadline`    | `iteration.runIteration` deadline check                                           | The intent's `deadline_at` elapsed.                                                           |
| `ship.tickle.started`                 | `app.ts` boot, after `tickleScheduler.start()`                                    | The cron tickle scheduler is scanning `ship:tickle`.                                          |
| `ship.tickle.due`                     | `orchestrator.onStepComplete` early-wake **or** `session-runner.resumeShipIntent` | An intent is being re-entered. `source` discriminates `workflow_run_completion` vs scheduler. |
| `ship.tickle.skip_terminal`           | `orchestrator.onStepComplete` early-wake                                          | The hook found a `shipIntentId` but the intent is already terminal; the ZADD was skipped.     |
| `ship.scoped.<verb>.enqueued`         | `dispatch-scoped.ts` after `enqueueJob`                                           | A scoped command (`rebase`, `fix_thread`, `explain_thread`, `open_pr`) was enqueued.          |
| `ship.scoped.<verb>.daemon.completed` | `connection-handler.handleScopedJobCompletion` and the executor                   | Daemon reported `succeeded`.                                                                  |
| `ship.scoped.<verb>.daemon.failed`    | Same                                                                              | Daemon reported `halted` or `failed`. `reason` carries the structured halt reason.            |

### Querying example (Datadog / Loki)

```text
event:"ship.intent.transition" to_status:"human_took_over" terminal_blocker_category:"flake-cap"
| count by pr.repo
```

## Dispatch reasons

Canonical source: `src/shared/dispatch-types.ts`. Four values; all land on `dispatch_target=daemon`.

| Reason                      | When the router sets it                                                                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `persistent-daemon`         | Routed to an existing persistent daemon. The default, hot path. Also used during cooldown when a scale-up was warranted but blocked by the cooldown window. |
| `ephemeral-daemon-triage`   | Triage returned `heavy=true` and an ephemeral daemon Pod was spawned.                                                                                       |
| `ephemeral-daemon-overflow` | Queue length ≥ `EPHEMERAL_DAEMON_SPAWN_QUEUE_THRESHOLD` **and** the persistent pool has zero free slots; a spawn drains the overflow.                       |
| `ephemeral-spawn-failed`    | A spawn was required but the K8s API call failed. The job is rejected with a tracking-comment infra error.                                                  |

## Aggregate reporting

When `DATABASE_URL` is set, helpers in `src/db/queries/dispatch-stats.ts` expose the most operator-relevant aggregates:

| Helper                           | Returns                                                                                                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eventsPerTarget(days)`          | Count of executions grouped by `dispatch_target`. Post-collapse this is always a single `daemon` row — query `dispatch_reason` directly for the per-reason split. |
| `triageRate(days)`               | Share of events whose `dispatch_reason` is `ephemeral-daemon-triage`.                                                                                             |
| `avgConfidenceAndFallback(days)` | Mean triage confidence plus fallback counts by reason.                                                                                                            |
| `triageSpend(days)`              | Cumulative `cost_usd` for triage-reached executions.                                                                                                              |

Call them from an internal admin endpoint, a scheduled job, or `bun repl`.

## Alerts worth having

- **Triage error rate.** `parse-error` + `llm-error` + `timeout` + `circuit-open` above a sustained threshold (e.g. 10 % over 15 minutes) signals provider trouble or a regression.
- **Ephemeral spawn failures.** Any `dispatch_reason=ephemeral-spawn-failed` points at RBAC, quota, or control-plane issues.
- **Heartbeat drift.** Daemons missing heartbeats past `HEARTBEAT_TIMEOUT_MS` get evicted; sustained eviction points at network or resource-floor issues.
- **OOM / crash loops.** Standard infra alerts. Durable idempotency means a restart will not replay a processed event.
- **Ship terminal-blocker rate.** A spike in `ship.intent.transition` events with `to_status:human_took_over` and `terminal_blocker_category:flake-cap` points at PR-flake regressions, not bot misbehaviour.

## Health probes

| Path       | Purpose                                                                                              |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| `/healthz` | Liveness — returns 200 once the HTTP server is bound.                                                |
| `/readyz`  | Readiness — 200 once config is validated and the data layer is reachable; flips to 503 on `SIGTERM`. |
