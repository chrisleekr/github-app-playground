# Quickstart — Triage and Dispatch Modes

**Audience**: a developer validating the feature locally before opening the PR.
**Prerequisite**: PR #14 merged (Phase 2 daemon + orchestrator shipped) and `bun run dev:deps` healthy (Valkey + Postgres via Docker Compose).

---

## Dispatch cascade — visual

```mermaid
flowchart TD
    Evt["Webhook event<br/>@chrisleekr-bot mentioned"]:::evt
    Idem{Idempotent?<br/>(delivery-id seen?)}:::check
    ModeCfg{AGENT_JOB_MODE}:::check
    Label{Label override?<br/>bot:shared / bot:job}:::check
    Static{Static classifier}:::check
    Triage["Triage call<br/>haiku-3-5, single-turn"]:::work
    Conf{confidence ≥ threshold?}:::check
    Default["Configured default<br/>DEFAULT_DISPATCH_TARGET"]:::result
    Inline["inline pipeline"]:::result
    Daemon["daemon (Phase 2 pool)"]:::result
    Shared["shared-runner<br/>POST /internal/run"]:::result
    Iso["isolated-job<br/>K8s Job + DinD sidecar"]:::result
    Queue{isolated-job capacity?}:::check
    Wait["Enqueue in Valkey<br/>tracking comment shows<br/>position N of M"]:::work

    Evt --> Idem
    Idem -->|no, already processed| Done["ack, skip"]:::muted
    Idem -->|yes, new| ModeCfg
    ModeCfg -->|inline| Inline
    ModeCfg -->|daemon| Daemon
    ModeCfg -->|shared-runner| Shared
    ModeCfg -->|isolated-job| Queue
    ModeCfg -->|auto| Label
    Label -->|bot:shared| Shared
    Label -->|bot:job| Queue
    Label -->|none| Static
    Static -->|clear-shared-runner| Shared
    Static -->|clear-isolated-job| Queue
    Static -->|ambiguous| Triage
    Triage -->|failure / circuit-open| Default
    Triage -->|success| Conf
    Conf -->|no| Default
    Conf -->|yes, mode=daemon| Daemon
    Conf -->|yes, mode=shared-runner| Shared
    Conf -->|yes, mode=isolated-job| Queue
    Queue -->|capacity free| Iso
    Queue -->|at max| Wait
    Wait -.->|slot frees| Iso

    classDef evt fill:#0b5394,stroke:#052b4c,color:#ffffff
    classDef check fill:#b45f06,stroke:#5a2f02,color:#ffffff
    classDef work fill:#38761d,stroke:#1b3a0d,color:#ffffff
    classDef result fill:#351c75,stroke:#1a0d3b,color:#ffffff
    classDef muted fill:#999999,stroke:#555555,color:#ffffff
```

---

## 1. First-run configuration

Create `.env.local` with these new variables on top of the Phase 2 defaults:

```bash
AGENT_JOB_MODE=auto
DEFAULT_DISPATCH_TARGET=shared-runner
TRIAGE_MODEL=haiku-3-5
TRIAGE_CONFIDENCE_THRESHOLD=1.0
TRIAGE_TIMEOUT_MS=5000
TRIAGE_MAXTURNS_TRIVIAL=10
TRIAGE_MAXTURNS_MODERATE=30
TRIAGE_MAXTURNS_COMPLEX=50
DEFAULT_MAXTURNS=30
MAX_CONCURRENT_ISOLATED_JOBS=3
PENDING_ISOLATED_JOB_QUEUE_MAX=20
INTERNAL_RUNNER_URL=http://localhost:7081/internal/run
INTERNAL_RUNNER_TOKEN=devtoken-local
JOB_NAMESPACE=default
JOB_TTL_SECONDS=3600
```

`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` + `ALLOWED_OWNERS` remain as configured for Phase 1/2 — triage uses the same provider chain via the new `src/ai/llm-client.ts` adaptor.

---

## 2. Run the stack locally

```bash
# Terminal 1 — deps
bun run dev:deps

# Terminal 2 — run the migration
bun run src/db/migrate.ts        # applies 003_dispatch_decisions.sql

# Terminal 3 — webhook server (same image used as shared-runner in prod)
bun run dev

# Terminal 4 — shared-runner (same image, INTERNAL_RUNNER=true)
INTERNAL_RUNNER=true AGENT_JOB_MODE=inline PORT=7081 bun run dev

# Terminal 5 — (optional) daemon pool, as set up in Phase 2
bun run src/daemon/main.ts
```

The isolated-job target is NOT exercised locally — local dev sets the app to log a startup warning stating isolated-job dispatches will be rejected (per data-model §7 cross-field validation). Exercising isolated-job end-to-end is a Phase 6 concern.

---

## 3. Happy-path smoke tests

### 3.1 Label-forced shared-runner

1. Attach `bot:shared` to a test PR.
2. Post `@chrisleekr-bot fix this typo`.
3. Expected:
   - Tracking comment shows `Working…` (no triage section, since triage was bypassed).
   - Webhook log: `dispatch decision` with `dispatchReason: "label"`, `dispatchTarget: "shared-runner"`, `triageInvoked: false`.
   - Shared-runner log: single `POST /internal/run` → 200 OK.
   - Postgres: `SELECT dispatch_target, dispatch_reason FROM executions WHERE delivery_id = '<id>';` returns `('shared-runner', 'label')`.
   - `triage_results` is empty for this delivery_id.

### 3.2 Keyword-forced isolated-job (will be rejected locally)

1. Post `@chrisleekr-bot please run docker compose up and validate` on a clean PR (no labels).
2. Expected:
   - Tracking comment ends in a rejection note: `Isolated-job target is not available in this environment; falling back per DEFAULT_DISPATCH_TARGET.` — because local dev has no K8s cluster.
   - Dispatch reason: `triage-error-fallback` is **not** used here — the reason is `static-default` with target `shared-runner`, since the static classifier returned clear-isolated-job but the isolated-job infra is absent. (FR-018 distinguishes "not available at all" from "at capacity.")

### 3.3 Auto-mode triage (ambiguous comment)

1. Set `AGENT_JOB_MODE=auto` and remove any labels from the PR.
2. Post `@chrisleekr-bot can you run the tests against the new service?`.
3. Expected:
   - Tracking comment contains a `<details>` block with chosen mode, confidence, complexity, and rationale.
   - Webhook log: `dispatch decision` with `triageInvoked: true`, `triageProvider: "anthropic"`, a cost < US$0.002, latency < 500ms.
   - If confidence < 1.0 (strict threshold), `dispatchReason` is `default-fallback` and the tracking comment notes the fallback.

### 3.4 Triage provider outage → circuit breaker

1. Set `TRIAGE_TIMEOUT_MS=1` to force every triage call to time out.
2. Post five ambiguous comments in a row.
3. Expected:
   - First 5 emit a `triage failed reason: timeout` warn log and a `dispatchReason: triage-error-fallback` info log.
   - The 6th through 10th emit `triage failed reason: circuit-open` warn logs — no provider call happens.
   - After 60s, one call is allowed (half-open). If it succeeds (reset `TRIAGE_TIMEOUT_MS=5000`), the breaker closes and the next comment triggers a real triage.

---

## 4. Rollback smoke test (FR-015)

1. Flip `AGENT_JOB_MODE=inline`, restart the server.
2. Post any triggering comment.
3. Expected:
   - Webhook log: `dispatch decision` with `dispatchTarget: "inline"`, `dispatchReason: "static-default"`, `triageInvoked: false`.
   - Behaviour identical to Phase 1 — all triage / classifier / shared-runner code paths are skipped.
   - No new migration or data mutation required. Existing events continue to resolve.

---

## 5. Observability tour

```bash
# Tail the dispatch-decision logs
pino-pretty < <(bun run dev 2>&1) | grep -E '(dispatch decision|triage failed)'

# 30-day aggregates (see contracts/dispatch-telemetry.md §5 for full queries)
psql "$DATABASE_URL" -c "SELECT dispatch_target, COUNT(*) FROM executions WHERE created_at >= NOW() - INTERVAL '7 days' GROUP BY dispatch_target ORDER BY COUNT(*) DESC;"

# Inspect pending queue
valkey-cli LRANGE dispatch:isolated-job:pending 0 -1
valkey-cli SMEMBERS dispatch:isolated-job:in-flight
```

---

## 6. What's NOT covered by this quickstart

- End-to-end isolated-job execution against a real K8s cluster (Phase 6).
- Remote daemons reached via Tailscale (Phase 6).
- Triage accuracy feedback loop and similar-issue enrichment (Phase 5).

Those paths exist in the codebase after this feature but cannot be validated without infrastructure beyond the local Docker Compose stack.
