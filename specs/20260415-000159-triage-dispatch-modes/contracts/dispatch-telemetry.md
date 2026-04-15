# Dispatch Telemetry Contract

**Purpose**: define the shape of the dispatch-decision and triage-result telemetry so operator dashboards and the FR-014 aggregate queries can be written against a stable contract.

---

## 1. Structured log — dispatch decision

Emitted once per webhook, after the router has chosen a target and before the workload is dispatched. Pino level: `info`.

```json
{
  "level": "info",
  "time": "2026-04-15T00:05:17.124Z",
  "msg": "dispatch decision",
  "deliveryId": "e7f5b8a0-...",
  "owner": "chrisleekr",
  "repo": "github-app-playground",
  "eventType": "issue_comment.created",
  "dispatchTarget": "shared-runner",
  "dispatchReason": "triage",
  "triageInvoked": true,
  "triageConfidence": 0.92,
  "triageComplexity": "moderate",
  "triageModel": "haiku-3-5",
  "triageProvider": "anthropic",
  "triageLatencyMs": 327,
  "triageCostUsd": 0.00094
}
```

Fields `triage*` are absent when `triageInvoked` is `false`.

## 2. Structured log — triage failure

Emitted when triage was attempted but the response was unusable (timeout, parse error, unknown mode, circuit-open). Pino level: `warn`. Always paired with a subsequent "dispatch decision" log whose `dispatchReason` is `triage-error-fallback`.

```json
{
  "level": "warn",
  "msg": "triage failed",
  "deliveryId": "e7f5b8a0-...",
  "reason": "timeout | parse-error | unknown-mode | circuit-open | provider-error",
  "latencyMs": 5000,
  "provider": "anthropic",
  "model": "haiku-3-5",
  "circuitState": "open | half-open | closed"
}
```

## 3. Database — `executions` extension

See data-model.md §4. New columns are denormalised for fast aggregate queries.

## 4. Database — `triage_results`

See data-model.md §3. One row per triage _success_ (parse succeeded and mode was in-enum). Triage failures do NOT produce a row — they only produce the warn log in §2 above.

## 5. Operator aggregate queries (FR-014)

### 5.1 Events per dispatch target, last 30 days

```sql
SELECT dispatch_target, COUNT(*) AS events
FROM executions
WHERE created_at >= NOW() - INTERVAL '30 days'
GROUP BY dispatch_target
ORDER BY events DESC;
```

### 5.2 Triage invocation rate (auto-mode only)

```sql
SELECT
  DATE(created_at) AS day,
  COUNT(*) FILTER (WHERE dispatch_reason IN ('triage', 'default-fallback', 'triage-error-fallback')) AS triaged,
  COUNT(*) AS total,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE dispatch_reason IN ('triage', 'default-fallback', 'triage-error-fallback'))
    / NULLIF(COUNT(*), 0), 2) AS triage_pct
FROM executions
WHERE created_at >= NOW() - INTERVAL '30 days'
GROUP BY day
ORDER BY day DESC;
```

### 5.3 Average triage confidence + fallback rate

```sql
SELECT
  AVG(confidence) AS avg_confidence,
  COUNT(*) FILTER (WHERE confidence < 1.0) * 1.0 / NULLIF(COUNT(*), 0) AS sub_threshold_rate
FROM triage_results
WHERE created_at >= NOW() - INTERVAL '30 days';
```

### 5.4 Total triage spend

```sql
SELECT SUM(cost_usd) AS total_triage_spend_usd
FROM triage_results
WHERE created_at >= NOW() - INTERVAL '30 days';
```

These four queries cover FR-014's required aggregates. Each runs in milliseconds against the planned indexes (`executions (dispatch_target, created_at DESC)`, `triage_results (created_at DESC)`).
