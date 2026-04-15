# Shared-Runner Internal HTTP Contract

**Endpoint**: `POST /internal/run`
**Exposure**: ClusterIP-only Kubernetes Service, not reachable from outside the cluster.
**Owner**: the shared-runner Deployment (same Docker image as the webhook server, launched with `INTERNAL_RUNNER=true`).
**Consumer**: `src/k8s/shared-runner-dispatcher.ts` in the webhook-server pod.

---

## Authentication

| Header             | Required    | Notes                                                                                                    |
| ------------------ | ----------- | -------------------------------------------------------------------------------------------------------- |
| `X-Internal-Token` | yes         | Shared secret. Compared constant-time against env `INTERNAL_RUNNER_TOKEN`. Missing / wrong → 401.        |
| `Content-Type`     | yes         | MUST be `application/json`.                                                                              |
| `X-Request-Id`     | recommended | If present, the runner reuses it as the pino child-logger request-id; otherwise the delivery id is used. |

No other auth. TLS is provided by the service mesh (Phase 6) — Phase 3 runs over HTTP in cluster.

---

## Request body

```json
{
  "deliveryId": "e7f5b8a0-...",
  "botContext": {
    "eventType": "issue_comment.created",
    "owner": "chrisleekr",
    "repo": "github-app-playground",
    "issueNumber": 42,
    "commentId": 1234567890,
    "triggerText": "@chrisleekr-bot please review",
    "labels": ["bot:shared"],
    "installationId": 98765432,
    "...": "remainder of BotContext shape — unchanged from Phase 1"
  },
  "maxTurns": 30,
  "allowedToolsOverride": null,
  "traceFields": {
    "dispatchReason": "triage",
    "triageConfidence": 0.92,
    "triageComplexity": "moderate"
  }
}
```

| Field                  | Required | Notes                                                                                                                                                                                                                                                                  |
| ---------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deliveryId`           | yes      | GitHub webhook delivery id. Doubles as the idempotency key inside the runner.                                                                                                                                                                                          |
| `botContext`           | yes      | The full `BotContext` shape. Validated by the same Zod schema used by the inline pipeline.                                                                                                                                                                             |
| `maxTurns`             | yes      | Derived from triage complexity via the configured map, or `DEFAULT_MAXTURNS`.                                                                                                                                                                                          |
| `allowedToolsOverride` | no       | Optional array that replaces the default allow-list. Normally `null`. **MUST NOT** include any `Bash(docker:*)` / `Bash(sh:*)` tools — the shared runner rejects the request with 400 if such tools are present, because the shared runner has no container isolation. |
| `traceFields`          | no       | Echoed into the pino log for the execution; not used for control flow.                                                                                                                                                                                                 |

---

## Responses

### 200 OK — execution completed

```json
{
  "ok": true,
  "executionId": "a1b2c3d4-...",
  "costUsd": 0.0214,
  "durationMs": 18342,
  "turns": 6,
  "status": "success"
}
```

### 4xx — request invalid

| Status | Cause                                                                              | Body shape                                                                                  |
| ------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `400`  | Zod validation failure on `botContext` or forbidden tool in `allowedToolsOverride` | `{ ok: false, error: "validation", details: [...] }`                                        |
| `401`  | Missing / wrong `X-Internal-Token`                                                 | `{ ok: false, error: "unauthorized" }`                                                      |
| `409`  | Duplicate `deliveryId` already in flight inside this runner instance               | `{ ok: false, error: "duplicate", executionId: "..." }`                                     |
| `429`  | Runner at its local concurrency ceiling                                            | `{ ok: false, error: "at-capacity" }` (dispatcher retries with backoff once, then surfaces) |

### 500 — internal error

```json
{
  "ok": false,
  "error": "internal",
  "executionId": "a1b2c3d4-...",
  "message": "sanitised one-line error message"
}
```

### 504 — wall-clock timeout (10 min default)

```json
{ "ok": false, "error": "timeout", "executionId": "a1b2c3d4-..." }
```

---

## Idempotency

The runner maintains its own in-memory delivery-id dedupe map. A request whose delivery id is already in flight (same runner instance) returns `409`. A completed delivery id returns its cached `{executionId, costUsd, ...}` for up to 60s after completion, then is evicted.

Across restarts, idempotency falls back to the outer router's durable tracking-comment check — the dispatcher never retries a runner call on a new instance without first re-consulting that gate.

---

## Health

`GET /healthz` and `GET /readyz` are served by the same process on the same port. Reuse of the existing endpoints satisfies plan §Open Questions > Shared runner `/healthz`.

---

## Observability

Every request logs at the runner, before and after execution, with fields:

```json
{
  "level": "info",
  "deliveryId": "...",
  "dispatchReason": "...",
  "triageConfidence": 0.92,
  "triageComplexity": "moderate",
  "maxTurns": 30,
  "turns": 6,
  "costUsd": 0.0214,
  "durationMs": 18342,
  "status": "success"
}
```

Matches the dispatcher-side log, enabling end-to-end correlation by `deliveryId` (constitution §VI).
