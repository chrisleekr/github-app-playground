# Observability

Structured JSON logs via [pino](https://getpino.io) are the primary signal. Every dispatch decision and every pipeline step carries a `deliveryId` so you can reconstruct a request end-to-end from a single log query. When `DATABASE_URL` is configured, the same information is also persisted to the `executions`, `triage_results`, and `dispatch_decisions` tables for aggregate reporting.

## Log fields

| Field                    | What it means                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `deliveryId`             | `X-GitHub-Delivery` header — stable across every log line for a single webhook.                   |
| `event`                  | GitHub event name (`pull_request`, `issue_comment`, …).                                           |
| `repo`                   | `owner/name` of the triggering repo.                                                              |
| `dispatch_target`        | One of `inline`, `daemon`, `shared-runner`, `isolated-job`.                                       |
| `dispatch_reason`        | Why the router chose the target. See below.                                                       |
| `triage_fallback_reason` | Only present on triage fallbacks — one of the six values in [Triage](TRIAGE.md#fallback-reasons). |
| `confidence`             | Triage confidence (0–1), only when the decision came from triage.                                 |
| `complexity`             | `trivial`, `moderate`, or `complex` — only on triage-success.                                     |
| `rationale`              | Free-text rationale from the triage LLM. Only on triage-success.                                  |
| `mode`                   | The `AGENT_JOB_MODE` in effect at decision time.                                                  |
| `cost_usd`               | Agent-reported total cost from the SDK. Present on completed executions.                          |

## Dispatch reasons

Canonical source: `src/shared/dispatch-types.ts`.

| Reason                  | When the router sets it                                       |
| ----------------------- | ------------------------------------------------------------- |
| `label`                 | An explicit `bot:*` label forced the target.                  |
| `keyword`               | A deterministic keyword in the mention body matched.          |
| `triage`                | Auto-mode Haiku call returned a confident classification.     |
| `default-fallback`      | Triage parsed but `confidence < TRIAGE_CONFIDENCE_THRESHOLD`. |
| `triage-error-fallback` | Triage timed out, errored, or the circuit breaker was open.   |
| `static-default`        | Static cascade was ambiguous in a non-auto mode.              |
| `capacity-rejected`     | Isolated-job queue was full; request refused.                 |
| `infra-absent`          | Chosen target's infrastructure is not configured.             |

## Aggregate reporting

When `DATABASE_URL` is set, four helpers in `src/db/queries/dispatch-stats.ts` expose the most operator-relevant aggregates. Call them from an internal admin endpoint, a scheduled job, or `bun repl`:

| Helper                           | Returns                                                |
| -------------------------------- | ------------------------------------------------------ |
| `eventsPerTarget(days)`          | Count of executions per `dispatch_target`.             |
| `triageRate(days)`               | Share of events that hit triage vs. short-circuited.   |
| `avgConfidenceAndFallback(days)` | Mean triage confidence plus fallback counts by reason. |
| `triageSpend(days)`              | Cumulative `cost_usd` for triage-reached executions.   |

## Alerts worth having

- **Triage error rate**. `triage-error-fallback` + `parse-error` + `llm-error` + `timeout` above a sustained threshold (e.g. 10% over 15 minutes) signals provider trouble or a regression.
- **Queue depth**. Pending isolated-job queue length consistently above zero — either raise `MAX_CONCURRENT_ISOLATED_JOBS` or investigate stuck Jobs.
- **Capacity rejections**. Any `dispatch_reason=capacity-rejected` means users are seeing "queue full" errors. Raise `PENDING_ISOLATED_JOB_QUEUE_MAX` or add isolated-job capacity.
- **Heartbeat drift**. Daemons missing heartbeats past `HEARTBEAT_TIMEOUT_MS` get evicted — sustained eviction points at network or resource-floor issues.
- **OOM / crash loops**. Standard infra alerts. The durable idempotency check means a restart won't replay a processed event, but a crash loop still blocks new ones.

## Health probes

| Path       | Purpose                                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| `/healthz` | Liveness. Returns 200 once the HTTP server is bound.                                                     |
| `/readyz`  | Readiness. Returns 200 once config is validated and — in non-inline modes — the data layer is reachable. |
