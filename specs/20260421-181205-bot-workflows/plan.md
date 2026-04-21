# Implementation Plan: Definitive Bot Workflows

**Branch**: `20260421-181205-bot-workflows` | **Date**: 2026-04-21 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/20260421-181205-bot-workflows/spec.md`

## Summary

Replace the current ad-hoc `@chrisleekr-bot` comment-trigger model with five named, explicitly contracted workflows (`triage`, `plan`, `implement`, `review`, `ship`) addressable by label **and** comment. A single **workflow registry** (data) drives the label dispatcher, the comment intent-classifier, and the documentation page — no parallel hard-coded lists. Each run is a single job on the existing Valkey-backed queue claimed by a daemon; composite workflows (`ship`) orchestrate via a `steps` field, handing off by enqueuing the next step when the current step completes. Per-run authoritative state lives in a new shared `workflow_runs` table with a JSON `state` column; the tracking comment is a human-readable mirror.

## Technical Context

**Language/Version**: TypeScript 5.9.3 strict mode on Bun ≥1.3.13
**Primary Dependencies**: `octokit` (webhook + GraphQL/REST), `@anthropic-ai/claude-agent-sdk` (multi-turn handlers), `@anthropic-ai/bedrock-sdk` (single-turn intent classification via `src/ai/llm-client.ts`), `@modelcontextprotocol/sdk`, `pino`, `zod`. No new npm dependencies.
**Storage**: PostgreSQL 17 via `Bun.sql` singleton — adds one migration (`005_workflow_runs.sql`). Valkey 8 via Bun built-in `RedisClient` — existing job queue reused unchanged.
**Testing**: `bun test` with coverage gate (`bun test --coverage`), per-file thresholds enforced by `bunfig.toml`.
**Target Platform**: Linux server (single process) + ephemeral daemon K8s Pods. Existing topology.
**Project Type**: Web service (webhook server + daemon worker). Pre-existing; no structural change.
**Performance Goals**: Honour existing SLA — webhook ack within 10 s (FR-027, SC-003); end-to-end `bot:ship` on a small change completes within 30 min wall-clock (SC-001).
**Constraints**: Webhook handler MUST remain non-blocking; all workflow execution MUST be enqueued, never inline (FR-027). Adding a new workflow MUST NOT require a DB migration (FR-025) and MUST NOT require editing the dispatcher or classifier (FR-024).
**Scale/Scope**: Single-tenant repo fleet under the existing `ALLOWED_OWNERS` allowlist; expected load is bounded by maintainer label actions (<100/day) — well within current orchestrator capacity.

## Constitution Check

Evaluated against constitution v1.2.1.

| Principle                             | Status  | Notes                                                                                                                                                                                                                                                                                        |
| ------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I. Strict TypeScript + Bun            | ✅ Pass | All new code in `src/` under existing `strict` config. `bun test` only.                                                                                                                                                                                                                      |
| II. Async Webhook Safety              | ✅ Pass | FR-027 explicitly forbids sync execution in the webhook process. Label events ack within 10 s then enqueue.                                                                                                                                                                                  |
| III. Idempotency & Concurrency        | ✅ Pass | FR-011 + FR-014 + FR-025: idempotency keyed against `workflow_runs`, not in-memory only. Existing concurrency guard in `src/orchestrator/concurrency.ts` applies unchanged.                                                                                                                  |
| IV. Security by Default               | ✅ Pass | Owner allowlist (FR-015) reused. Label events still HMAC-verified by `@octokit/webhooks`. Intent classifier uses the existing sandboxed single-turn adaptor in `src/ai/llm-client.ts` (carve-out in Technology Constraints satisfied — single-turn, no tool loop, guarded by config schema). |
| V. Test Coverage                      | ✅ Pass | New modules (`registry.ts`, `label-mutex.ts`, `intent-classifier.ts`, `workflow-runs` store, handlers) target ≥70% line coverage; intent-classifier (security-adjacent: unauthenticated content drives dispatch) targets ≥90%.                                                               |
| VI. Structured Observability          | ✅ Pass | Every run gets a child logger bound to `{ workflowRunId, workflowName, item, deliveryId }`. Cost + duration logged per handler run via existing executor pattern.                                                                                                                            |
| VII. MCP Server Extensibility         | ✅ Pass | No new MCP servers required — handlers reuse the existing MCP registry. The workflow registry is a separate, plain-data construct; it does not compete with the MCP pattern.                                                                                                                 |
| VIII. Documentation Standards         | ✅ Pass | Authoritative workflow page added at `docs/BOT-WORKFLOWS.md`; doc-sync rule extended in CLAUDE.md (FR-019). Mermaid diagrams use the style rules from `docs/ARCHITECTURE.md`.                                                                                                                |
| Architecture: Single Server Model     | ✅ Pass | No new processes. Daemon already runs handlers via `src/core/pipeline.ts`; this feature adds workflow-specific handler branches, not a new binary.                                                                                                                                           |
| Architecture: Pipeline                | ✅ Pass | Each of the five workflows is a pipeline variant (per Assumptions); stages remain composable.                                                                                                                                                                                                |
| Technology: AI Orchestration Carveout | ✅ Pass | `triage` (both as dispatch workflow and as comment intent-classifier) runs through the existing `src/ai/llm-client.ts` single-turn adaptor when used for classification; multi-turn implementation work continues through `claude-agent-sdk`.                                                |

**Gate result**: Pass. No violations. No entries required in Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/20260421-181205-bot-workflows/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output (registry schema, workflow_runs schema, webhook event contracts)
└── tasks.md             # Phase 2 output (created by /speckit.tasks)
```

### Source Code (repository root)

```text
src/
├── workflows/                              # NEW — one folder per atomic concern
│   ├── registry.ts                         # FR-022/023/024 — single workflow registry (data + types)
│   ├── label-mutex.ts                      # FR-014 — enforce "one bot:* label per item"
│   ├── intent-classifier.ts                # FR-008/009/010 — triage-as-classifier over comment bodies
│   ├── runs-store.ts                       # FR-025/026 — Bun.sql wrapper over workflow_runs table
│   ├── tracking-mirror.ts                  # FR-012/026 — mirror runs-store state → tracking comment
│   ├── orchestrator.ts                     # FR-006/027/028/029 — enqueue/hand-off logic for composite runs
│   └── handlers/                           # one file per workflow (the handler reference from the registry)
│       ├── triage.ts
│       ├── plan.ts
│       ├── implement.ts
│       ├── review.ts
│       └── ship.ts                         # thin — just enqueues first step via orchestrator
│
├── webhook/events/
│   ├── issues.ts                           # NEW — handles `issues.labeled` (dispatch), `issues.unlabeled` (no-op)
│   └── pull-request.ts                     # EXTEND — handle `pull_request.labeled`; keep existing PR event handling
│
├── db/migrations/
│   └── 005_workflow_runs.sql               # NEW — see data-model.md
│
├── daemon/
│   └── main.ts                             # EXTEND — route claimed jobs by workflow.name to handlers/*
│
└── shared/
    └── workflow-types.ts                   # NEW — WorkflowName, WorkflowRun, RegistryEntry shared w/ daemon

test/
├── workflows/
│   ├── registry.test.ts
│   ├── label-mutex.test.ts
│   ├── intent-classifier.test.ts
│   ├── runs-store.test.ts
│   ├── tracking-mirror.test.ts
│   ├── orchestrator.test.ts                # composite hand-off: success chain, terminal failure, idempotent re-enqueue
│   └── handlers/{triage,plan,implement,review,ship}.test.ts
└── webhook/events/issues.test.ts

docs/
└── BOT-WORKFLOWS.md                        # NEW — derived-or-hand-authored authoritative page (FR-018)
```

**Structure Decision**: Single-project layout preserved (per constitution). The feature introduces one new top-level concern, `src/workflows/`, which owns the registry + orchestration + handlers. Webhook event parsing stays in `src/webhook/events/`. Database schema stays in `src/db/migrations/`. No new processes, no monorepo split.

## Complexity Tracking

No constitution violations — this table is intentionally empty.
