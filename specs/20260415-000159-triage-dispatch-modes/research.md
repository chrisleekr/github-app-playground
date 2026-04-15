# Phase 0 Research — Triage and Dispatch Modes

**Date**: 2026-04-15
**Resolves**: all `NEEDS CLARIFICATION` markers from the plan's Technical Context, plus the two `Deferred` items from `/speckit.clarify`.

---

## R1 — Triage model choice

**Decision**: `claude-haiku-3-5` for the triage call on day 1.

**Rationale**:

- The call is a single-turn JSON-constrained classification, not a reasoning task. Haiku 3.5's published accuracy on classification benchmarks is within noise of Sonnet's for short-context multiclass problems.
- Cost per call is ~US$0.001 vs Sonnet at ~US$0.015 — a 15× factor against SC-003 (≤US$5/month at 1,000 events/day × ≤10% triage rate = 100 calls/day → Haiku ≈US$3/month; Sonnet ≈US$45/month).
- Latency budget is 500ms p95 (SC-002). Haiku 3.5 p95 for a 256-token response is reliably under 400ms against the Anthropic API; Sonnet 4.6 is not.
- The Phase 3 plan doc's task table (§3.2) names Sonnet, but the later enhancement section (§Triage Pre-Classifier) explicitly chose Haiku for cost and latency. The enhancement section is the later, more detailed decision — treat it as the authority.

**Alternatives considered**:

- `claude-sonnet-4-6`: rejected on cost and latency. Reserve for the Phase 5 triage-feedback-loop (when few-shot examples expand and accuracy becomes the binding constraint).
- Static rules only (no model): rejected in /speckit.clarify — auto-mode cannot resolve genuinely ambiguous requests without a model.

**Downstream impact**: `MODEL_MAP` in `src/ai/llm-client.ts` aliases `"haiku-3-5"` to the correct provider-specific ID (`"claude-haiku-3-5"` for direct Anthropic, `"anthropic.claude-3-5-haiku-20241022-v1:0"` for Bedrock). Operators can override via `TRIAGE_MODEL` env var without code changes.

---

## R2 — LLM provider path

**Decision**: support both paths from day 1. `createLLMClient(config)` branches on `config.provider`:

- `provider: "anthropic"` → `new Anthropic({ apiKey })` (the existing transitive `@anthropic-ai/sdk`)
- `provider: "bedrock"` → `new AnthropicBedrock({ awsRegion, ... })` (new direct dependency `@anthropic-ai/bedrock-sdk`)

Both SDK clients satisfy a minimal `LLMClient` interface (`messages.create(...)` returning a typed response). `resolveModelId(alias, provider)` picks the provider-specific model ID via `MODEL_MAP`, falling through to the raw value when no alias matches so operators can pin an explicit model ID.

**Rationale**:

- The existing runtime already supports three provider modes for the _agent_ path (Anthropic API key, Claude OAuth token, Bedrock credential chain — see `src/config.ts` and `src/core/executor.ts`). A single provider for non-agent calls would create a second, inconsistent policy.
- Zero-touch for Anthropic: `@anthropic-ai/sdk` is already pulled in transitively by `@anthropic-ai/claude-agent-sdk`. No new runtime dep for that path.
- The Bedrock SDK is a small, Anthropic-maintained package. It avoids forcing operators on Bedrock to maintain a separate code path.

**Alternatives considered**:

- Anthropic-only: rejected — breaks parity with the existing Bedrock-capable agent path and would block operators on AWS-only environments from enabling auto mode.
- Bedrock-only: rejected — Daisy's homelab runs direct Anthropic; the default local-dev path would need a secondary config.
- Use `@anthropic-ai/claude-agent-sdk` for the triage call: rejected — the agent SDK is built for multi-turn tool-using loops, not single-turn JSON classification. Pulling in a full agent turn just to emit one JSON object would violate SC-002 (latency) and waste tokens.

**Constitution note**: §Technology Constraints > AI Orchestration says "Direct LLM API calls outside the agent SDK are forbidden." The triage call is a _non-agent_ call (single-turn, no tool use, no agent loop), so the constraint as written doesn't literally apply — but this feature must add an explicit carve-out. Action: propose a one-line §Technology Constraints amendment in the PR: _"Non-agent single-turn inference (classification, embedding, summarisation) MAY use the raw Anthropic / Bedrock SDKs via the `src/ai/llm-client.ts` adaptor. Multi-turn tool-using flows MUST continue to use `@anthropic-ai/claude-agent-sdk`."_ This is a PATCH-level clarification, not a principle change.

---

## R3 — `@kubernetes/client-node` dependency

**Decision**: add `@kubernetes/client-node` as a direct dependency. Initialise once at module load time via `kc.loadFromCluster()` when running in-cluster (`process.env.KUBERNETES_SERVICE_HOST` is set), else `kc.loadFromDefault()` for local development with `kubectl` access. Use `BatchV1Api` and `CoreV1Api` only; no Informer / watch machinery in this feature.

**Rationale**:

- This is the officially-maintained Kubernetes TypeScript client, typing coverage is complete, and it handles in-cluster auth (ServiceAccount token rotation) without bespoke code.
- Job spawning is the only cluster API needed in Phase 3. The client-node package is small enough (and tree-shakes well enough) that pulling only `BatchV1Api` + `CoreV1Api` does not materially bloat the image.
- Plan doc §3.5 already specifies this dep.

**Alternatives considered**:

- Hand-rolled HTTPS calls to the Kubernetes API server: rejected — re-implements ServiceAccount token loading, kube-ca cert trust, and retry/backoff.
- Kubernetes CLI shell-out: rejected — requires `kubectl` in the image and loses type safety.

**In-cluster RBAC**: needed — `Role` granting `batch/jobs: create, get, list, watch, delete` in the Job namespace. That `Role` plus its `RoleBinding` are deferred to Phase 6 (helm-charts repo). Local dev does not exercise this path.

---

## R4 — Pending isolated-job queue in Valkey

**Decision**: use a single Redis list per isolated-job pool, `dispatch:isolated-job:pending`. Enqueue via `RPUSH`; drain via `LPOP`. Maximum length enforced with `LLEN` check before `RPUSH`; reject (not silently drop) if full. Queue-position display in the tracking comment uses `LRANGE` once at enqueue time — no live-streaming.

Each entry is a JSON blob:

```json
{
  "deliveryId": "...",
  "enqueuedAt": "2026-04-15T00:00:00.000Z",
  "botContextKey": "valkey:bot-context:<deliveryId>",
  "triageResult": { ... } | null,
  "source": { "owner": "...", "repo": "...", "issueOrPrNumber": 42 }
}
```

`botContextKey` references a separate Valkey key holding the full `BotContext` (gzipped JSON, 1h TTL). We split to keep the list entries small.

**Rationale**:

- Reuses the existing Bun `RedisClient` singleton from Phase 2 — no new transport.
- FIFO is the only semantic we need; Redis lists are the idiomatic primitive.
- One queue scope (isolated-job only) — daemon target has its own Phase 2 queue; shared-runner is HTTP-synchronous and cannot queue here.

**Queue length default**: `PENDING_ISOLATED_JOB_QUEUE_MAX=20`. This equates to ~20×3min = 1h of pending work at the configured default `MAX_CONCURRENT_ISOLATED_JOBS=3`. Both are operator-configurable via env.

**Alternatives considered**:

- Postgres-backed queue: rejected — adds DB load for a short-lived, restart-tolerant queue.
- Kubernetes-side queue (Jobs in Pending state): deferred — covered as the alternative path in /speckit.clarify Q4 Option A. The user chose Option B (application-level visible queue) for UX clarity.
- Sorted sets with priority: rejected for Phase 3. FIFO is sufficient; priority can be a follow-up without changing the outer schema.

---

## R5 — `resolveAllowedTools()` job-mode extension

**Decision**: detect job mode via `process.env.AGENT_JOB_MODE === "isolated-job"` OR `process.env.AGENT_CONTEXT_B64 !== undefined` (per plan §Job Mode). Branch tool allow-list:

- **Base (all targets)**: `Edit, MultiEdit, Glob, Grep, LS, Read, Write`, git operations, plus existing baseline `Bash(cat:*, ls:*, find:*, grep:*, sed:*, curl:*, chmod:*, mkdir:*)`.
- **Job-mode only**: `Bash(docker:*), Bash(docker-compose:*), Bash(npm:*), Bash(npx:*), Bash(bun:*), Bash(bunx:*), Bash(make:*), Bash(sh:*), Bash(bash:*), Bash(cp:*), Bash(mv:*)`.

Rationale for the split: the extended set assumes pod-level isolation with emptyDir volumes (no shared state between runs). Inline / shared-runner / daemon targets share a filesystem across requests (or at minimum share the pod), so `docker:*` and `sh:*` would be dangerous.

**Existing constraint**: `resolveAllowedTools()` already receives `daemonCapabilities` as a parameter (per memory: _feedback_allowed_tools_capabilities.md_). The job-mode branch is additive to that.

---

## R6 — Tracking-comment rendering for triage + queue position

**Decision**: extend `src/core/tracking-comment.ts` with two rendering helpers:

- `renderTriageSection(triageResult)` → Markdown collapsible `<details>` block containing chosen mode, confidence (to 2 dp), complexity, and the one-sentence rationale. Omitted when triage didn't run.
- `renderDispatchStatus(state)` where `state` is `"running" | "queued" | "failed" | "success"`. For `queued`, the message reads `⏳ Queued (position N of M on isolated-job pool). Waiting for capacity…` and is updated on dequeue.

Both extend the existing `createTrackingComment()` / `updateTrackingComment()` functions. No new comment type — continues to use the existing idempotency-anchor comment.

---

## R7 — Triage-provider circuit breaker

**Decision**: `src/utils/circuit-breaker.ts` — a minimal three-state breaker (`closed → open → half-open → closed`):

- `closed` (normal): requests pass through. A consecutive-failure counter increments on error.
- Trip to `open` after 5 consecutive failures **or** after any single response >10s (whichever comes first). While `open`, `triageRequest(ctx)` short-circuits and returns `{ outcome: "circuit-open" }`, which the router treats identically to a triage error — fall through to the configured default target. No tokens spent.
- After a 60-second cooldown, transition to `half-open`: the next triage call is allowed. Success → `closed`. Failure → back to `open` with cooldown reset.

Observability: every state transition logs at `warn` level with `{state, reason, consecutiveFailures}`. SC-005 compliance follows from the breaker — at most one call per 60 seconds during an outage, so at US$0.001/call, the error-path cost cap is ~US$0.06/hour, well under the US$1/hour budget.

**Alternatives considered**:

- `opossum` or similar library: rejected — the full circuit-breaker semantics we need are ~40 LOC, and the existing constitution discourages new runtime deps without justification.
- Rate-limit only (no open/closed states): rejected — doesn't free the breaker automatically when the provider recovers without code intervention.

---

## R8 — Isolated-job Pod spec

**Decision**: Kubernetes `Job` with:

- `backoffLimit: 0` (no k8s retry — idempotency at app layer, per plan)
- `ttlSecondsAfterFinished: 3600` (auto-cleanup after 1h)
- `activeDeadlineSeconds: 1800` (30-min wall clock — matches complexity=complex maxTurns budget × per-turn ceiling)
- **InitContainer** `wait-for-docker`: shells out to `until docker info; do sleep 1; done`
- **Container `claude-agent`**: same image as webhook server, different `command: ["bun", "run", "src/k8s/job-entrypoint.ts"]`; env includes `AGENT_CONTEXT_B64`, `AGENT_JOB_MODE=isolated-job`, forwarded provider creds, and a short-lived GitHub installation token (1h TTL). Mounts a shared emptyDir at `/workspace`.
- **Sidecar `docker`**: `docker:27-dind` image, `privileged: true`, `DOCKER_TLS_CERTDIR=""`, shared emptyDir at `/var/lib/docker`. The `claude-agent` container sets `DOCKER_HOST=tcp://localhost:2375`.
- Resource requests: `cpu: 500m, memory: 1Gi`; limits: `cpu: 2000m, memory: 4Gi` (per plan §Job resource limits).

**Cleanup guarantees**: `ttlSecondsAfterFinished` plus app-side `deleteJob(jobName)` called from `finally` in the spawner when the completion watch resolves. No emptyDir artefact survives; no orphan Job object survives past the TTL.

---

## R9 — Shared-runner internal contract

**Decision**: same Docker image, launched with `INTERNAL_RUNNER=true` and `AGENT_JOB_MODE=inline` env. ClusterIP-only `Service`; authentication via `X-Internal-Token: <shared-secret>` header on POST `/internal/run`. The shared secret is a new Zod-validated env var (`INTERNAL_RUNNER_TOKEN`), mounted from a Kubernetes Secret in Phase 6.

Request/response are spec'd in `contracts/shared-runner-internal.md`. Synchronous HTTP: the shared runner executes the inline pipeline against the supplied `BotContext`, then replies with `{ok: true, executionId, costUsd}` or `{ok: false, error}`. No streaming; the dispatcher on the webhook side awaits the response and writes the execution record.

**Timeout**: 10 minutes at the dispatcher. The runner enforces its own wall-clock via `maxTurns` and the existing inline pipeline's timeouts.

**Health**: reuses existing `/healthz` and `/readyz` endpoints (per plan §Open Questions — Resolved).

---

## R10 — Dispatch-decision + triage-result persistence

**Decision**: one new SQL migration `003_dispatch_decisions.sql`:

1. Add columns to `executions`: `dispatch_target TEXT NOT NULL DEFAULT 'inline'`, `dispatch_reason TEXT NOT NULL DEFAULT 'default'`, `triage_confidence NUMERIC(3,2)`, `triage_cost_usd NUMERIC(10,6)`, `triage_complexity TEXT`.
2. New table `triage_results (id UUID PK, delivery_id TEXT UNIQUE, mode TEXT, confidence NUMERIC(3,2), complexity TEXT, rationale TEXT, cost_usd NUMERIC(10,6), latency_ms INTEGER, provider TEXT, model TEXT, created_at TIMESTAMPTZ DEFAULT now())`. Rows are written once per triage invocation and referenced by `executions.delivery_id`.
3. Indexes: `executions (dispatch_target, created_at DESC)` and `triage_results (created_at DESC)` for the 30-day aggregate queries (FR-014).

Rationale for embedding the summary into `executions` (denormalised) alongside the `triage_results` row: the operator aggregate queries in FR-014 all group by `dispatch_target` and need `triage_confidence` without a join; duplicating three small columns is cheaper than forcing a left-outer join across hundreds of thousands of executions per quarter.

Rollback: dropping the three columns and the `triage_results` table restores the Phase 1 schema. FR-015 is satisfied because the `DEFAULT 'inline'` columns mean existing queries that don't reference them keep working, and the inline dispatch path never reads them.

---

## R-Deferred items from /speckit.clarify — now resolved

- **Triage model**: Haiku 3.5 — see R1.
- **LLM provider path**: both — see R2.
- **Isolated-job concurrency ceiling**: `MAX_CONCURRENT_ISOLATED_JOBS=3` default, operator-configurable.
- **Pending-queue max**: `PENDING_ISOLATED_JOB_QUEUE_MAX=20` default, operator-configurable.

No unresolved `NEEDS CLARIFICATION` markers remain.
