# Implementation Plan: PR Shepherding to Merge-Ready State

**Branch**: `20260427-201332-pr-shepherding-merge-ready` | **Date**: 2026-04-27 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/20260427-201332-pr-shepherding-merge-ready/spec.md`

## Summary

Drive a PR from "triggered for shepherding" to a typed `MergeReadiness.ready === true` verdict — or terminate cleanly with one of a finite set of reasons — without holding a daemon job slot during waits, surviving daemon restarts mid-flight, and yielding cleanly to human hand-off. The current `bot:ship` composite (review → resolve loop bounded by `REVIEW_RESOLVE_MAX_ITERATIONS`) terminates on a soft signal ("agent reports no further findings") and silently allows premature `ready` declarations, stale CI/reviewer state, and per-iteration honor-system retry caps that compound across the loop.

The technical approach combines three architectures (per spec adoption of architecture proposal 2026-04-26 §8): **S1** event-driven GitHub-webhook reactor, **S3** continuation-passing via scheduled re-entry, **S5** decomposed merge-readiness probe primitive plus reactive driver. None stands alone; together they cover each other's weaknesses. The agent never self-declares `ready` — only the probe (pure GraphQL, ~$0, ms-latency) computes the conjunction. Every wait yields the daemon slot and persists a continuation; resumption is via either a matching webhook event (early-wake) or a scheduled tickle (backstop against missed webhooks). Phased delivery P1–P7 lets each phase ship and stop early if not justified by observed pain.

## Technical Context

**Language/Version**: TypeScript 5.9.3 strict mode (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `useUnknownInCatchVariables`) on Bun ≥1.3.12 (single-sourced via `.tool-versions`).
**Primary Dependencies**: `octokit` (webhook + REST + GraphQL), `@anthropic-ai/claude-agent-sdk` (multi-turn agent flows in `resolve` / `branch-refresh`), `@modelcontextprotocol/sdk` (new `resolve-review-thread` MCP server in P7), `pino` (structured logs), `zod` (config + WebSocket message schemas + state-blob versioning), `@kubernetes/client-node` (existing — no new ephemeral spawning required for this feature), Bun built-in `WebSocket` + `RedisClient`. **No new npm dependencies.**
**Storage**: PostgreSQL 17 via `Bun.sql` singleton — adds one new migration `008_ship_intents.sql` introducing four tables (`ship_intents`, `ship_iterations`, `ship_continuations`, `ship_fix_attempts`). Valkey 8 via Bun built-in `RedisClient` — reused for cron-tickle scheduling (sorted set keyed by `wake_at` epoch ms), webhook-reactor early-wake fan-out, and per-intent cancellation flag. No new Valkey schemas beyond one sorted-set key (`ship:tickle`), one hash key (`ship:reactor:pr-index`), and one per-intent flag key (`ship:cancel:{intent_id}`).
**Testing**: `bun test` (Constitution I + V). Co-located `*.test.ts` for new modules; `bun test --coverage` enforces ≥90% on probe + signature ledger + continuation persistence (security/correctness-critical) and ≥70% on reactor / cron-tickle / abort handler.
**Target Platform**: Linux server (existing Docker image, `linux/amd64` + `linux/arm64`). Webhook server + daemon worker share the same image and codebase per Constitution > Architecture Constraints > Single Server Model. New cron-tickle runs as a small in-process scheduler inside the webhook server (no separate process; uses Bun timers + Valkey sorted-set-as-priority-queue).
**Project Type**: web service (existing Bun HTTP server with WebSocket-attached daemon workers).
**Performance Goals**:

- Probe: <100 ms p95 (one GraphQL + minimal post-processing; no agent invocation).
- Cron tickle: scheduler scan <50 ms p95 even at 1000 active intents.
- Webhook reactor early-wake latency: webhook-arrival → continuation re-enqueue ≤ 500 ms p95.
- Spec SC-002: median wall-clock trigger → terminal `ready` < 30 minutes (for sessions that reach ready).
- Spec FR-020: zero held daemon slots during waits — verified by absence of long-running `resolve` invocations holding slots > `AGENT_TIMEOUT_MS`.

**Constraints**:

- Webhook 200-OK ≤ 10 s (Constitution II) — reactor early-wake must be fully async.
- `AGENT_TIMEOUT_MS` ≤ 60 min per agent invocation (existing) — no change; sessions span many invocations.
- `MAX_WALL_CLOCK_PER_SHIP_RUN` (new env, default 4 h, override-per-invocation) — per-session cap, FR-012a.
- `MAX_SHIP_ITERATIONS` (new env, default 50) — iteration-count cap that pairs with the wall-clock cap, FR-012. Checked at the start of each iteration; on cap fire the intent transitions to `human_took_over` + `BlockerCategory='iteration-cap'`.
- `SHIP_FORBIDDEN_TARGET_BRANCHES` (new env, comma-separated, default empty) — branches the bot must refuse to shepherd against, FR-015.
- Single-active-intent-per-PR enforced via partial unique index `(owner, repo, pr_number) WHERE status = 'active'` — FR-007a.
- Idempotency (Constitution III) — re-trigger of `bot:ship` while session active returns "already in progress" without side-effect; tracking-comment re-find is by stable marker (FR-006/007).
- No held slots during waits (FR-020) — agent invocations must be fire-and-forget from the session's perspective; the session writes a continuation and exits its current daemon job.

**Scale/Scope**:

- Initial: single-tenant (one installation = one user/org).
- Active intents: budget for up to 100 concurrent without DB hot-spotting (single-row-per-PR design + indexed status filter).
- Phased delivery (P1 → P7) explicitly modular: stop early if a later phase isn't justified by observed pain.

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

| Principle                         | Compliance                      | Notes                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| I. Strict TypeScript + Bun        | PASS                            | No new languages or runtimes; all new modules under `src/workflows/ship/`, `src/db/queries/`, `src/mcp/servers/` follow existing strict TS conventions. Zero `any`.                                                                                                                                                                                                                                                |
| II. Async Webhook Safety          | PASS                            | Webhook reactor (P4) only enqueues lookups by PR id; matching active intents and re-enqueueing continuations happen async after 200 OK. No new long-running webhook handler logic.                                                                                                                                                                                                                                 |
| III. Idempotency + Concurrency    | PASS — strengthened             | FR-007a (single-active intent per PR via partial unique index) plus FR-007 (durable continuation state) are stronger than the existing fast-map idempotency. Re-trigger while active is rejected with "already in progress."                                                                                                                                                                                       |
| IV. Security by Default           | PASS                            | Reuses installation-token path via existing `octokit` App; no new secrets. New `resolve-review-thread` MCP server (P7) inherits the existing MCP scope-isolation pattern. State-blob payloads in `ship_continuations.state_blob` include only PR/SHA/iteration metadata — no secrets.                                                                                                                              |
| V. Test Coverage (NON-NEGOTIABLE) | PASS — high-priority targets    | Probe is correctness-critical (false-ready → broken `main`); ≥90% line coverage. Signature ledger + continuation persist/resume ≥90%. Reactor + cron-tickle + abort handler ≥70%. Existing `resolve.ts` + `review.ts` are wrapped, not rewritten — coverage carries over.                                                                                                                                          |
| VI. Structured Observability      | PASS — strengthened             | FR-016 emits structured logs/metrics per session (trigger, phase transitions, iteration count, terminal state, cost). FR-024 persists full probe-input snapshot per iteration in `ship_iterations.verdict_json` for offline reconciliation. SC-007 surfaces USD per session in tracking comment.                                                                                                                   |
| VII. MCP Server Extensibility     | PASS — new server               | P7 adds `resolve-review-thread` MCP server (single responsibility: GraphQL `resolveReviewThread` mutation). Registered through existing `src/mcp/registry.ts`; receives installation token via initialization parameters per Constitution VII.                                                                                                                                                                     |
| VIII. Documentation Standards     | PASS — multi-doc update planned | Same-commit doc updates (per Constitution VIII): `docs/BOT-WORKFLOWS.md` (ship workflow rewrite), `docs/CONFIGURATION.md` (new env vars), `docs/ARCHITECTURE.md` (continuation + reactor flow with Mermaid), new `docs/SHIP.md` (operator-facing). All exported symbols in new `src/workflows/ship/*.ts` get JSDoc. Mermaid diagrams in `ARCHITECTURE.md` and `SHIP.md` follow Constitution VIII validation rules. |

**Verdict: PASS — no constitution violations. Complexity Tracking section omitted.**

## Project Structure

### Documentation (this feature)

```text
specs/20260427-201332-pr-shepherding-merge-ready/
├── plan.md              # This file (/speckit-plan output)
├── spec.md              # /speckit-specify + 2× /speckit-clarify
├── research.md          # Phase 0 output (this command)
├── data-model.md        # Phase 1 output (this command)
├── quickstart.md        # Phase 1 output (this command)
├── contracts/           # Phase 1 output (this command)
│   ├── probe-graphql-query.md      # Merge-readiness probe GraphQL query
│   ├── resolve-thread-mutation.md  # GraphQL resolveReviewThread mutation contract
│   ├── webhook-event-subscriptions.md  # Which webhook events the reactor consumes
│   ├── bot-commands.md             # bot:ship / bot:abort-ship command syntax
│   └── mcp-resolve-thread-server.md # MCP tool contract for P7
├── checklists/
│   └── requirements.md  # Spec quality checklist (already complete)
└── tasks.md             # /speckit-tasks output (NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
src/
├── workflows/
│   ├── handlers/
│   │   ├── ship.ts              # MODIFIED: replace in-process loop with intent lifecycle
│   │   ├── resolve.ts           # MODIFIED: emit fix-attempt signature; remove iteration concept
│   │   ├── review.ts            # UNCHANGED
│   │   └── branch-refresh.ts    # MODIFIED: emit base-ref-snapshot event
│   └── ship/                    # NEW directory — shepherding session subsystem
│       ├── intent.ts            # P2: intent lifecycle (create, list-active, transition, terminate)
│       ├── probe.ts             # P1: MergeReadiness probe — pure GraphQL, no agent
│       ├── verdict.ts           # P1: MergeReadiness type + NonReadinessReason discriminated union
│       ├── continuation.ts      # P3: persist + resume continuation state
│       ├── tickle-scheduler.ts  # P3: cron tickle (Valkey sorted-set priority queue)
│       ├── webhook-reactor.ts   # P4: dispatch matching webhook events to active intents
│       ├── fix-attempts.ts      # P5: signature ledger
│       ├── signature.ts         # P5: deterministic root-cause signature derivation
│       ├── deadline.ts          # P5: wall-clock cap enforcement
│       ├── abort.ts             # P6: bot:abort-ship command + cooperative cancellation token
│       ├── tracking-comment.ts  # FR-006: single canonical tracking comment per session
│       ├── flake-tracker.ts     # FR-014/014a: targeted re-run + flake annotation
│       ├── review-barrier.ts    # FR-023: generic review-latency barrier — "any non-bot review on current head SHA OR margin elapsed". No reviewer list.
│       ├── trigger-router.ts    # FR-027: single entry point routing literal/NL/label surfaces into one CanonicalCommand record
│       ├── nl-classifier.ts     # FR-025/025a: single-turn Bedrock LLM intent classifier with mention-prefix gate
│       └── label-trigger.ts     # FR-026/026a: deterministic label-name parser + label self-removal after acting
├── db/
│   ├── migrations/
│   │   └── 008_ship_intents.sql # NEW: 4 tables (ship_intents, ship_iterations, ship_continuations, ship_fix_attempts)
│   └── queries/
│       └── ship.ts              # NEW: typed Bun.sql query helpers for ship_* tables
├── mcp/
│   └── servers/
│       └── resolve-review-thread.ts  # P7: GraphQL resolveReviewThread as MCP tool
├── webhook/
│   └── events/                  # MODIFIED: existing event handlers gain reactor-fan-out call
│       ├── pull_request.ts      # MODIFIED: synchronize event → reactor
│       ├── pull_request_review.ts            # MODIFIED: → reactor
│       ├── pull_request_review_comment.ts    # MODIFIED: → reactor
│       ├── check_run.ts         # NEW or MODIFIED: completed → reactor
│       └── check_suite.ts       # NEW or MODIFIED: completed → reactor
├── config.ts                    # MODIFIED: Zod schema gains MAX_WALL_CLOCK_PER_SHIP_RUN, MAX_SHIP_ITERATIONS, CRON_TICKLE_INTERVAL_MS, REVIEW_BARRIER_SAFETY_MARGIN_MS, MERGEABLE_NULL_BACKOFF_MS_LIST, FIX_ATTEMPTS_PER_SIGNATURE_CAP, SHIP_FORBIDDEN_TARGET_BRANCHES, SHIP_USE_TRIGGER_SURFACES_V2 (gates FR-025/026 NL + label paths). Reuses existing TRIGGER_PHRASE for FR-025a mention-prefix gate.
└── shared/
    └── ship-types.ts            # NEW: SessionTerminalState + BlockerCategory enums shared between server and daemon

test/
└── workflows/ship/              # mirrors src/workflows/ship/
    ├── probe.test.ts            # ≥90% coverage required
    ├── verdict.test.ts          # ≥90%
    ├── intent.test.ts           # ≥70%
    ├── continuation.test.ts     # ≥90% (restart-safety property)
    ├── webhook-reactor.test.ts  # ≥70%
    ├── fix-attempts.test.ts     # ≥90% (signature determinism)
    ├── tracking-comment.test.ts # ≥70%
    ├── flake-tracker.test.ts    # ≥70%
    ├── tickle-scheduler.test.ts # ≥70%
    ├── trigger-router.test.ts   # ≥90% (FR-027 surface parity)
    ├── nl-classifier.test.ts    # ≥90% (FR-025/025a mention-prefix gate)
    └── label-trigger.test.ts    # ≥90% (FR-026/026a label self-removal)

docs/
├── SHIP.md                      # NEW: operator-facing — what bot:ship does, how to monitor, how to abort
├── BOT-WORKFLOWS.md             # MODIFIED: ship workflow rewritten (intent lifecycle, continuation, terminal states)
├── ARCHITECTURE.md              # MODIFIED: add reactor + continuation flow Mermaid
└── CONFIGURATION.md             # MODIFIED: document new env vars
```

**Structure Decision**: Single-project layout (per Constitution > Single Server Model). All new code lives under `src/workflows/ship/` (new directory) plus targeted modifications to existing `src/workflows/handlers/`, `src/webhook/events/`, `src/mcp/servers/`, `src/db/migrations/`, `src/config.ts`. The ship/ subdirectory cleanly bounds the new subsystem so future maintainers can read it as a single coherent module.

## Phased Delivery

Mirroring spec adoption of architecture proposal §11. Each phase is independently shippable; stop early if a later phase is not justified by observed pain.

| Phase | Deliverable                                                                                                                                                                                                                                                                                             | Spec FRs                                         | Justification                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| P1    | `MergeReadiness` type + verdict module + `bot:merge-ready-probe` handler. Modify `ship` handler terminal condition to use probe verdict. Verdict snapshot written to `ship_iterations.verdict_json` from day one (FR-024).                                                                              | FR-002, FR-014, FR-022, FR-024, _partial_ FR-021 | Immediately fixes "stops on no findings" bug. Highest value, smallest risk. Probe is testable in isolation. |
| P2    | `ship_intents` + `ship_iterations` tables (migration `008`). Intent lifecycle module. `ship` handler emits intent state transitions. Still uses in-process loop.                                                                                                                                        | FR-007a, FR-016, _full_ FR-024                   | Foundation for P3+. Exposes longitudinal state to operators via DB.                                         |
| P3    | `ship_continuations` table. Cron tickle scheduler. Replace in-process `ship` loop with continuation re-entry. Daemon slots released during waits.                                                                                                                                                       | FR-007, FR-020, FR-021                           | Frees daemon slots; survives restart. The architectural payload of the feature.                             |
| P4    | Webhook reactor: `check_run.completed`, `check_suite.completed`, `pull_request_review`, `pull_request_review_comment`, `pull_request.synchronize` events early-wake matching intents. Reviewer barrier (FR-023) generic across configured reviewer logins; no reviewer-specific names anywhere in code. | FR-010, FR-022, FR-023                           | Reactivity; near-zero latency on relevant changes. Cron tickle remains as backstop.                         |
| P5    | `ship_fix_attempts` ledger. Signature derivation module. Wall-clock cap enforcement (`MAX_WALL_CLOCK_PER_SHIP_RUN`). USD telemetry written to tracking comment.                                                                                                                                         | FR-012, FR-012a, FR-013                          | Discipline + observability.                                                                                 |
| P6    | `bot:abort-ship` user command. Cooperative cancellation token across all ship/ handlers.                                                                                                                                                                                                                | FR-011                                           | Operator override safety valve.                                                                             |
| P7    | `resolve-review-thread` MCP server (GraphQL `resolveReviewThread` mutation). Wire into resolve handler.                                                                                                                                                                                                 | FR-005                                           | Closes the structural under-counting gap (resolved-thread count is currently unverifiable).                 |

**Phase ordering rationale**: P1 alone fixes the immediate "premature ready" bug with one new file (probe) + one terminal-condition change. P2 is the data foundation. P3 is the architecture payload (continuation + slot release). P4 makes it reactive. P5 adds discipline. P6 adds the safety valve. P7 closes the verifiability gap. P7 could ship before P1 if the unverified-resolution gap proves more painful than the premature-ready bug — defer that ordering decision to whichever evidence surfaces first.

## Complexity Tracking

> No constitution violations. Section omitted.

## Stop Condition

This file ends after Phase 1 planning. `/speckit-tasks` is the next command and produces `tasks.md`. Implementation begins with `/speckit-implement` against the resulting tasks.

---

**Phase 0 output**: [research.md](./research.md)
**Phase 1 outputs**: [data-model.md](./data-model.md), [quickstart.md](./quickstart.md), [contracts/](./contracts/)
