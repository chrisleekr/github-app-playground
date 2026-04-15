# Implementation Plan: Triage and Dispatch Modes

**Branch**: `20260415-000159-triage-dispatch-modes` | **Date**: 2026-04-15 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/20260415-000159-triage-dispatch-modes/spec.md`

## Summary

Phase 3 of the GitHub App Daemon rollout. The webhook router currently dispatches every triggered event through the inline pipeline (or, since PR #14, optionally to a Phase 2 daemon pool). This feature adds two more execution targets — an in-cluster **shared-runner** Deployment and an ephemeral **isolated-job** (Kubernetes Job with Docker-in-Docker) — plus an **auto** meta-mode that routes each ambiguous request via a cheap single-turn classification call. Label overrides (`bot:shared`, `bot:job`) and a deterministic keyword classifier remain the free, fast happy path; triage only fires for genuinely ambiguous events in auto mode.

Primary technical approach: introduce an `src/ai/llm-client.ts` provider adaptor (Anthropic direct + Bedrock) for non-agent inference; add `src/orchestrator/triage.ts` for the LLM call and `src/k8s/` for static classification, shared-runner HTTP forwarding, and Kubernetes Job spawning. Extend `src/webhook/router.ts` with a real dispatch branch (replacing the Phase 1 error guard), extend `src/core/prompt-builder.ts` `resolveAllowedTools()` to unlock container tooling in job mode, and add a Valkey-backed pending queue for isolated-job capacity back-pressure. Schema extensions land via a new SQL migration against the existing `executions` table.

## Technical Context

**Language/Version**: TypeScript 5.9.3 (strict mode with `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `useUnknownInCatchVariables`) on Bun ≥1.3.8.
**Primary Dependencies**: existing — `octokit`, `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`, `pino`, `zod`, Bun built-in `WebSocket` + `RedisClient`. New — `@anthropic-ai/bedrock-sdk` (for the LLMClient Bedrock path) and `@kubernetes/client-node` (for in-cluster Job spawning). `@anthropic-ai/sdk` is already a transitive dep of `claude-agent-sdk`.
**Storage**: PostgreSQL 17 via `Bun.sql` singleton (existing `executions` + `daemons` tables from migration `001_initial.sql`); Valkey 8 (Redis-compatible) via Bun built-in `RedisClient` for the new pending isolated-job queue and the existing Phase 2 job queue / daemon registry.
**Testing**: `bun test` only (Jest, Vitest forbidden by constitution §I/§Technology Constraints). Unit tests co-located as `*.test.ts`; integration tests exercise router → classifier → triage → dispatch with mocked GitHub API and Claude Agent SDK.
**Target Platform**: Linux container (amd64/arm64) deployed to Kubernetes. Local dev via Docker Compose (`bun run dev:deps`). The isolated-job target requires an in-cluster K8s deployment; local dev falls back to the configured default per FR-018.
**Project Type**: Single web-service (HTTP webhook server) plus a worker sub-process (the existing daemon). No new processes in this phase — the shared-runner is the same image with `INTERNAL_RUNNER=true`, matching constitution §Architecture Constraints > Single Server Model.
**Performance Goals**: Webhook acknowledgement ≤10s (constitution §II). Triage adds ≤500ms p95 to the acknowledgement-to-tracking-comment path (SC-002). ≥90% of auto-mode events are resolved without triage (SC-001). Concurrent isolated-jobs bounded by `MAX_CONCURRENT_ISOLATED_JOBS` (configurable).
**Constraints**: Rollback-safe — setting `agentJobMode=inline` restores Phase 1 behaviour with zero data migration (FR-015). No silent downgrade between targets (FR-018). No automatic retry on isolated-job failure (FR-021). Triage provider outage cannot exceed US$1/hour in error-path cost (SC-005) — implemented via rate-limited circuit breaker.
**Scale/Scope**: Existing envelope — ≤1,000 webhook events/day in the near term. Triage spend budget ≤US$5/month at that volume (SC-003). Expected triage invocation rate ≤10% of events (SC-001).

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-evaluated after Phase 1 design._

| Principle                         | Compliance | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I. Strict TypeScript + Bun        | ✅         | No new runtimes. Strict mode retained. All new modules under `src/` follow the existing `moduleResolution: "bundler"` convention.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| II. Async Webhook Safety          | ✅         | Dispatch remains post-acknowledgement. Triage, classification, shared-runner POST, and Job spawn all run after HTTP 200. `MAX_CONCURRENT_ISOLATED_JOBS` + Valkey pending queue replace the in-memory semaphore for the isolated path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| III. Idempotency + Concurrency    | ✅         | Existing two-layer idempotency (in-memory `Map` + durable tracking-comment check) is applied before any dispatch decision. A retried delivery id uses the existing dedupe before spending any triage tokens (FR-019).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| IV. Security by Default           | ✅         | Zod schemas for triage response, dispatch config, Job context. Shared-runner is ClusterIP-only with an `X-Internal-Token` header (ADR-011). Isolated-job context transmitted only via K8s-scoped env (short-lived installation token, 1-hour TTL). Webhook payload and trigger-comment text pass through existing sanitisation before being embedded in the triage prompt. **AI Orchestration carve-out**: triage uses the raw Anthropic/Bedrock SDK via `src/ai/llm-client.ts` (single-turn, no tools) per the constitution v1.2.1 amendment landed in PR #17. Multi-turn tool-using flows remain on `@anthropic-ai/claude-agent-sdk`. Triple-gated per the amendment: spec contract (`contracts/triage-response.schema.json`), runtime no-tool enforcement inside the adaptor, and fail-fast Zod config validation. Latency (`triageTimeoutMs`) and cost (`triageMaxTokens`) ceilings are enforced by the triage engine + config, not the adaptor itself. |
| V. Test Coverage (NON-NEGOTIABLE) | ✅         | Unit: classifier (deterministic; exhaustive), triage response parser, LLM provider adaptor model resolution, queue back-pressure, tool allow-list branching, circuit breaker. Integration: router → classifier → triage → dispatch with all branches. Security-critical parser paths ≥90%; other new modules ≥70%.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| VI. Structured Observability      | ✅         | Pino child logger per delivery id. Every triage call logs `{deliveryId, mode, confidence, complexity, costUsd, latencyMs, provider, model, reason}`. Every dispatch decision logs `{deliveryId, chosenTarget, reason}`. Cost recorded on the execution record (FR-013).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| VII. MCP Server Extensibility     | ➖ N/A     | No new MCP tools. The Phase 2 `daemon-capabilities` MCP server is untouched.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| VIII. Documentation Standards     | ✅         | JSDoc on every exported symbol. A Mermaid dispatch-cascade diagram lands in `docs/` (and is mirrored in `quickstart.md`). Constitution §VIII compliance verified by the doc-gate checklist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

**Result**: no violations. Complexity Tracking section intentionally empty.

## Project Structure

### Documentation (this feature)

```text
specs/20260415-000159-triage-dispatch-modes/
├── plan.md                      # This file
├── research.md                  # Phase 0 output
├── data-model.md                # Phase 1 output
├── quickstart.md                # Phase 1 output
├── contracts/
│   ├── triage-response.schema.json   # Zod-derived JSON Schema for triage LLM output
│   ├── shared-runner-internal.md     # Internal /internal/run HTTP contract
│   └── dispatch-telemetry.md         # Execution-record extension schema
├── checklists/
│   └── requirements.md          # from /speckit.specify
└── tasks.md                     # /speckit.tasks output (not created here)
```

### Source Code (repository root)

```text
src/
├── ai/
│   └── llm-client.ts                       # NEW — provider adaptor (Anthropic + Bedrock)
├── core/
│   ├── inline-pipeline.ts                  # existing (Phase 1) — unchanged
│   ├── prompt-builder.ts                   # EXTEND — resolveAllowedTools() job-mode branch
│   └── tracking-comment.ts                 # EXTEND — triage reasoning + queue position rendering
├── db/
│   ├── index.ts                            # existing — unchanged
│   ├── migrate.ts                          # existing — unchanged
│   └── migrations/
│       └── 003_dispatch_decisions.sql      # NEW — extends executions, adds dispatch_decisions + triage_results
├── k8s/
│   ├── classifier.ts                       # NEW — deterministic StaticClassification function
│   ├── job-spawner.ts                      # NEW — BatchV1Api Job creation w/ DinD sidecar
│   ├── job-entrypoint.ts                   # NEW — executed inside the ephemeral pod
│   ├── shared-runner-dispatcher.ts         # NEW — POST /internal/run forwarder
│   └── pending-queue.ts                    # NEW — Valkey-backed FIFO for isolated-job capacity
├── orchestrator/
│   ├── triage.ts                           # NEW — single-turn LLM call + response parse + circuit breaker
│   └── (existing Phase 2 modules unchanged — ws-server, registry, dispatcher, history, client)
├── webhook/
│   ├── router.ts                           # EXTEND — replace Phase 1 dispatch-guard error with full cascade
│   └── events/                             # existing — unchanged
├── shared/                                 # existing — unchanged
├── mcp/                                    # existing — unchanged
├── utils/
│   └── circuit-breaker.ts                  # NEW — rate-limited open/half-open state for triage provider
├── config.ts                               # EXTEND — confidence threshold default 1.0, queue-max, complexity→maxTurns map
└── app.ts                                  # existing — no changes expected

tests/
├── unit/
│   ├── ai/llm-client.test.ts
│   ├── k8s/classifier.test.ts
│   ├── k8s/pending-queue.test.ts
│   ├── k8s/shared-runner-dispatcher.test.ts
│   ├── orchestrator/triage.test.ts
│   ├── core/prompt-builder.allowed-tools.test.ts
│   └── utils/circuit-breaker.test.ts
├── integration/
│   └── webhook-router.dispatch-modes.test.ts   # router → classifier → (triage) → dispatch (GitHub API + SDK mocked)
└── contract/
    └── shared-runner-internal.test.ts           # POST /internal/run contract
```

**Structure Decision**: extend the existing single-project layout. All new code lands under `src/ai/`, `src/k8s/`, `src/orchestrator/` (alongside the Phase 2 modules), plus small extensions to `src/core/` and `src/webhook/router.ts`. The shared-runner is the same image invoked with `INTERNAL_RUNNER=true` (ADR-011) — no new project, no microservice decomposition, in line with constitution §Architecture Constraints > Single Server Model.

## Complexity Tracking

> No Constitution Check violations — this table is intentionally empty. New dependencies (`@anthropic-ai/bedrock-sdk`, `@kubernetes/client-node`) are justified in `research.md` and scoped to the single call sites where they are required.
