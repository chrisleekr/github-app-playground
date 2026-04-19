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
| `triage_fallback_reason` | Only present on triage fallbacks — one of the five values in [Triage](TRIAGE.md#fallback-reasons).    |
| `confidence`             | Triage confidence (0–1), only when the decision came from triage.                                     |
| `heavy`                  | Triage binary signal (`true`/`false`) — only on triage-success.                                       |
| `rationale`              | Free-text rationale from the triage LLM. Only on triage-success.                                      |
| `cost_usd`               | Agent-reported total cost from the SDK. Present on completed executions.                              |

## Dispatch reasons

Canonical source: `src/shared/dispatch-types.ts`. Four values, all landing on `dispatch_target=daemon`.

| Reason                      | When the router sets it                                                                                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `persistent-daemon`         | Routed to an existing persistent daemon. The default, hot path. Also used on cooldown — when a scale-up was warranted but blocked by the cooldown window. |
| `ephemeral-daemon-triage`   | Triage returned `heavy=true` and an ephemeral daemon Pod was spawned to claim the job.                                                                    |
| `ephemeral-daemon-overflow` | Queue length ≥ `EPHEMERAL_DAEMON_SPAWN_QUEUE_THRESHOLD` and an ephemeral daemon Pod was spawned to drain the overflow.                                    |
| `ephemeral-spawn-failed`    | A spawn was required but the K8s API call failed. The job is rejected with a tracking-comment infra error.                                                |

## Aggregate reporting

When `DATABASE_URL` is set, helpers in `src/db/queries/dispatch-stats.ts` expose the most operator-relevant aggregates. Call them from an internal admin endpoint, a scheduled job, or `bun repl`:

| Helper                           | Returns                                                                                                                                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eventsPerTarget(days)`          | Count of executions grouped by `dispatch_target`. Post-collapse this is always a single `daemon` row — useful only as a liveness counter; query `dispatch_reason` directly for the per-reason split. |
| `triageRate(days)`               | Share of events that hit triage vs. short-circuited.                                                                                                                                                 |
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
