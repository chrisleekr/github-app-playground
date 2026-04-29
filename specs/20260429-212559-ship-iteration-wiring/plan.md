# Implementation Plan: Ship Iteration Wiring

**Branch**: `20260429-212559-ship-iteration-wiring` | **Date**: 2026-04-29 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/20260429-212559-ship-iteration-wiring/spec.md`

## Summary

Close three integration gaps left by the merged PR shepherding spec (PR #77) so that `@chrisleekr-bot ship` actually drives a non-ready PR to merge-ready and so that the four scoped commands (`bot:rebase`, `bot:fix-thread`, `bot:explain-thread`, `bot:open-pr`) execute instead of posting "not yet wired" notices.

The technical approach is a **bridge** to the existing `workflow_runs` daemon pipeline rather than a parallel pipeline inside `src/workflows/ship/`:

1. The new ship-intents iteration handler picks one next action per probe verdict and inserts a `workflow_runs` row (carrying `ship_intent_id` in `context_json`) that the existing `enqueueJob({ workflowRun })` flow already dispatches to a daemon.
2. The webhook reactor cascade (`src/workflows/orchestrator.ts`) writes `ZADD ship:tickle 0 <intent>` on workflow completion so the iteration loop continues without waiting for the next idle tick.
3. `src/app.ts` boot starts the existing `createTickleScheduler` factory (currently defined but never started) with an `onDue(intentId)` callback that invokes a new `resumeShipIntent` in `session-runner.ts`.
4. Four scoped daemon executors live in `src/daemon/` (one file each), each registered as a new `JobKind` consumed by the daemon's job-router. They satisfy the existing scoped-handler callbacks (`runMerge`, `createBranchAndPr`) rather than introducing a new transport.

## Technical Context

**Language/Version**: TypeScript 5.9.3, strict mode (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `useUnknownInCatchVariables`)
**Primary Dependencies**: `octokit`, `@anthropic-ai/claude-agent-sdk` (multi-turn agent flows for fix-thread/explain-thread/open-pr executors), `@modelcontextprotocol/sdk`, `pino`, `zod`, Bun built-in `WebSocket` + `RedisClient`. **No new npm dependencies.**
**Storage**: Postgres 17 via `Bun.sql` singleton — no schema changes; reuses existing `ship_intents`, `ship_iterations`, `ship_continuations`, `workflow_runs` tables. Valkey 8 — reuses existing `ship:tickle` sorted set and `queue:jobs` list.
**Testing**: `bun test` — co-located `*.test.ts` for new modules; integration tests under `tests/integration/` covering daemon WS round-trip and tickle re-entry smoke.
**Target Platform**: Linux server (webhook server) + Linux daemon (persistent or ephemeral K8s Pod).
**Project Type**: Single-process webhook server + WebSocket-connected daemon worker (existing dual-process model under one codebase).
**Performance Goals**: Probe → first-iteration enqueue under 10s on warm server (SC-006); tickle re-entry within one tick interval (SC-002, default 30s); zero "not yet wired" notices remaining (SC-007).
**Constraints**: Webhook 200 OK within 10 seconds (Constitution II); no destructive git flags anywhere (FR-009 inherited from merged spec); concurrent maintainer commands honored at iteration boundaries (Edge Cases).
**Scale/Scope**: Single-tenant local dev (`@chrisleekr-bot-dev` via ngrok) for e2e validation; one ship intent per (owner, repo, pr_number) by existing unique index. Iteration cap and deadline enforced from existing config.

## Constitution Check

Constitution version: **1.2.1** (2026-04-15).

| Principle                      | How this plan complies                                                                                                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I. Strict TypeScript + Bun     | All new files in TypeScript strict mode; no `any`; Bun runtime; `bun test` only.                                                                                                                                           |
| II. Async webhook safety       | Iteration handler enqueues a daemon job and returns; tickle scheduler runs in a background timer with graceful stop. No new code path executes inside the webhook 200 OK window.                                           |
| III. Idempotency + concurrency | Iteration handler uses the existing `ship_iterations` insert-only audit; `workflow_runs` inserts inherit deduplication from the merged spec. Tickle re-entry is single-flight per intent (state check before `onDue`).     |
| IV. Security by default        | No new secrets. New daemon executors clone to temp dirs (existing pattern), clean up on completion. User-content (review threads, issue bodies) treated as untrusted in agent prompts.                                     |
| V. Test coverage               | Co-located `*.test.ts` for each new module; security-critical paths (rebase merge logic, scoped-job routing) target ≥90% line coverage; others ≥70%. Integration tests under `tests/integration/`.                         |
| VI. Structured observability   | All new logs use existing `pino` child loggers; `event` keys follow `ship.iteration.*`, `ship.tickle.*`, `ship.scoped.*.daemon.*` namespaces. No `console.*`. Cost is logged via the existing daemon pipeline (no change). |
| VII. MCP server extensibility  | Reuses existing MCP servers (`resolve-review-thread`, `daemon-capabilities`); no new MCP servers required.                                                                                                                 |
| VIII. Documentation standards  | JSDoc on all new exports; `docs/BOT-WORKFLOWS.md` updated to describe the bridge architecture; one Mermaid diagram added showing the iteration loop + tickle re-entry flow.                                                |

**Technology constraint compliance**:

- AI orchestration: scoped fix-thread, explain-thread, and open-pr executors use `@anthropic-ai/claude-agent-sdk` (multi-turn, tool-using). Rebase executor is deterministic — no agent. No `src/ai/` adaptor introduced.
- HTTP framework: no new framework; existing `octokit` App class.
- Logging: `pino` only.
- Schema validation: `zod` for any new external boundary (e.g., `ws-messages.ts` additions).

**Architecture constraint compliance**:

- Single Server Model: webhook server stays single-process; daemon executors run in the existing daemon process (already permitted as a WebSocket client).
- Pipeline architecture: scoped executors are leaves on the existing pipeline; iteration handler does NOT bypass any pipeline stage.
- Code style: named exports only; one logical concern per file (one executor per file in `src/daemon/`).
- Repository checkout: every executor that touches git clones to a temp dir using the existing `src/core/pipeline.ts` helper or its constituent functions.

**Initial gate**: PASS — no Complexity Tracking entries required.

## Project Structure

### Documentation (this feature)

```text
specs/20260429-212559-ship-iteration-wiring/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output (entity touch points; no new schema)
├── quickstart.md        # Phase 1 output (e2e validation matrix)
├── contracts/
│   ├── ws-messages.md   # New WS message-kind additions
│   └── job-kinds.md     # New JobKind values + payload shapes
└── tasks.md             # Phase 2 output — generated by /speckit-tasks
```

### Source Code (repository root)

```text
src/
├── app.ts                            # MODIFY — start tickle scheduler at boot
├── workflows/
│   ├── orchestrator.ts               # MODIFY — ZADD ship:tickle on completion of runs carrying ship_intent_id
│   └── ship/
│       ├── iteration.ts              # NEW — selects next action; inserts workflow_runs; enqueues daemon job
│       ├── session-runner.ts         # MODIFY — non-ready branch calls runIteration; add resumeShipIntent
│       ├── scoped/
│       │   ├── rebase.ts             # UNCHANGED (callback contract honored)
│       │   ├── fix-thread.ts         # UNCHANGED
│       │   ├── explain-thread.ts     # UNCHANGED
│       │   └── dispatch-scoped.ts    # MODIFY — replace "not yet wired" notices with enqueue
│       └── tickle-scheduler.ts       # UNCHANGED (already correct; just needs to be started)
├── daemon/
│   ├── scoped-rebase-executor.ts        # NEW — deterministic git merge + push
│   ├── scoped-fix-thread-executor.ts    # NEW — Agent SDK mechanical fix
│   ├── scoped-explain-thread-executor.ts # NEW — read-only Agent SDK explanation
│   ├── scoped-open-pr-executor.ts       # NEW — Agent SDK branch + PR scaffold
│   └── job-executor.ts                  # MODIFY — route new JobKinds
├── orchestrator/
│   ├── job-queue.ts                  # MODIFY — extend QueuedJob with scoped-job variants
│   └── connection-handler.ts         # MODIFY — server-side scoped-job-completion handler bridging daemon outcome → policy-layer comment formatter (per T033b)
└── shared/
    ├── ws-messages.ts                # MODIFY — new message kinds for scoped jobs
    └── workflow-types.ts             # MODIFY — JSDoc-only update documenting the `context_json.shipIntentId` convention (research.md Q1: WorkflowRunRef itself does NOT grow a new field)

tests/
├── integration/
│   ├── ship-iteration-loop.test.ts   # NEW — end-to-end intent → daemon → completion → next iteration
│   └── ship-tickle-resume.test.ts    # NEW — paused intent + ZADD → resume
└── (co-located *.test.ts next to each new file)

specs/20260427-201332-pr-shepherding-merge-ready/
└── tasks.md                           # MODIFY — flip T021/T046/T070/T071/T082/T083/T085/T088/T092 to [~]

docs/
└── BOT-WORKFLOWS.md                   # MODIFY — bridge architecture + Mermaid diagram
```

**Structure Decision**: Single-project Bun service with two entrypoints (webhook server + daemon worker). All changes live under existing top-level directories — no new top-level dir is added.

## Phase 0: Research (output: research.md)

Three open questions resolved during plan generation; details in `research.md`:

1. **How does the existing `workflow_runs` lifecycle correlate completions back to a `ship_intent`?** — Resolved: store `shipIntentId` inside `workflow_runs.context_json` (no schema change) and read it in the orchestrator cascade. Decision A in research.md.
2. **Job kind taxonomy for scoped executors** — Decision: per-executor `JobKind` (`scoped-rebase`, `scoped-fix-thread`, `scoped-explain-thread`, `scoped-open-pr`) for clean dispatch and per-kind metrics, rather than a single umbrella kind with a sub-discriminator.
3. **Where does the tickle scheduler get its `RedisClient` and `Bun.sql` references?** — Decision: same singleton accessors used by the orchestrator; wired in `src/app.ts` at boot in the same lifecycle slot as the orchestrator's `start()`.

## Phase 1: Design & Contracts (output: data-model.md, contracts/, quickstart.md)

### Data model

No new tables. Touch-point summary in `data-model.md`:

- `ship_intents` — read by iteration handler and resume handler; written via existing transition functions.
- `ship_iterations` — append one row per iteration the new code drives.
- `ship_continuations` — read/write the existing state-blob via the existing helper.
- `workflow_runs` — insert one row per iteration; `context_json.shipIntentId` is the correlation key.
- `ship:tickle` (Valkey ZSET) — one entry per paused intent; score is `due_at` epoch ms.
- `queue:jobs` (Valkey LIST) — gains four new payload variants tagged by `JobKind`.

### Contracts

Two contract docs in `contracts/`:

- `ws-messages.md` — additions to `src/shared/ws-messages.ts` for the four scoped job offers.
- `job-kinds.md` — payload schema for each scoped `JobKind` plus the iteration-driven workflow-run payload (which is the existing shape; just documenting the new `shipIntentId` field path).

### Quickstart

`quickstart.md` is the operator-facing playbook for validating the whole feature against `@chrisleekr-bot-dev` via ngrok, covering all 11 e2e scenarios from SC-004.

### Agent context update

`CLAUDE.md` will be updated by the speckit `update-agent-context.sh` script to reference this `plan.md` between the `<!-- SPECKIT START -->` and `<!-- SPECKIT END -->` markers.

## Phase 2: Tasks (output: tasks.md)

Generated by `/speckit-tasks`, NOT by this command. Expected shape (preview only — final task numbering happens in `/speckit-tasks`):

- **Setup tasks** — extend `WorkflowRunRef` (or `context_json` convention), extend `JobKind` enum, extend `ws-messages` schema.
- **US1 tasks** — `iteration.ts` core, `session-runner.ts` non-ready branch swap, orchestrator cascade `ZADD`, integration test.
- **US2 tasks** — `app.ts` boot wiring, `resumeShipIntent` in session-runner, integration test.
- **US3 tasks** — four daemon executors (rebase first as deterministic baseline; then fix-thread, explain-thread, open-pr), `dispatch-scoped.ts` wiring removal of "not yet wired" notices.
- **Cross-cutting tasks** — docs (`docs/BOT-WORKFLOWS.md` + Mermaid), retrospective `tasks.md` flips on the merged spec, e2e quickstart execution.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

No violations. The bridge architecture is the simpler alternative — duplicating clone+Agent SDK glue inside `src/workflows/ship/` would be the higher-complexity path and was rejected in research.md.

## Re-evaluation (post-design)

After Phase 1 design completion, re-evaluating against the constitution:

- All checks remain PASS.
- No new dependencies were introduced.
- No new top-level directories were added.
- Test coverage targets are reachable with co-located unit tests + two integration tests.
- Documentation updates (BOT-WORKFLOWS + Mermaid) are scoped to one file.

**Final gate**: PASS. Ready for `/speckit-tasks`.
