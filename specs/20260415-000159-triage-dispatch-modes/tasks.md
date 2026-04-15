---
description: "Task list for the Triage and Dispatch Modes feature"
---

# Tasks: Triage and Dispatch Modes

**Feature**: `20260415-000159-triage-dispatch-modes`
**Input**: design documents under `/specs/20260415-000159-triage-dispatch-modes/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md (all present)

**Tests**: Constitution §V (Test Coverage — NON-NEGOTIABLE) requires tests for every new module. All test tasks in this file are therefore **mandatory**, not optional. Security-critical modules (response parsing, config validation, circuit breaker) require ≥90% line coverage; all other new modules ≥70%.

**Organization**: tasks are grouped by user story from `spec.md` so each story can be shipped as an incremental, independently testable PR.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on other incomplete tasks).
- **[Story]**: `[US1]` / `[US2]` / `[US3]` / `[US4]` maps to the user stories in `spec.md`.
- File paths are absolute to repository root.

## Path Conventions

Single-project TypeScript/Bun layout at repository root. All new source under `src/`, all tests under the existing test-colocation pattern (`*.test.ts` adjacent to source, integration tests under `tests/integration/`).

---

## Phase 0: Constitution Prerequisite (BLOCKING for Phase 4 / US2)

**Purpose**: the plan introduces `src/ai/llm-client.ts`, a direct-LLM path that conflicts with constitution §Technology Constraints > AI Orchestration ("Direct LLM API calls outside the agent SDK are forbidden"). The constitution PATCH amendment flagged in `research.md` R2 MUST land as a **standalone, prior PR** — not bundled with feature work — per constitution §Amendment Procedure. Until this phase merges, no task that introduces direct-LLM code (T029, T033, T034) may start.

- [ ] T000 Propose and land the PATCH-level constitution amendment (a one-line carve-out under §Technology Constraints > AI Orchestration permitting a single cheap non-agent classification call for dispatch triage, subject to the circuit-breaker and budget guardrails in FR-020 / SC-003 / SC-005). Update `Sync Impact Report` in `.specify/memory/constitution.md`, bump to v1.2.1, and merge as its own PR. **Blocks**: Phase 4 (US2) and T033 in particular.

**Checkpoint**: constitution amended and merged to `main`. Only then may Phase 4 code be authored.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: pull in the two new runtime dependencies and wire them through the project's type-check / lint / test pipeline.

- [ ] T001 Add `@anthropic-ai/bedrock-sdk` and `@kubernetes/client-node` to `dependencies` in `package.json`, then `bun install` to refresh the lockfile. Commit the lockfile change.
- [ ] T002 [P] Add `bun add --dev @types/node` check (required by `@kubernetes/client-node`'s Node type imports) — only if not already present in `package.json` devDependencies.
- [ ] T003 Run `bun run check` on a clean working tree to confirm the baseline (typecheck + lint + format + test) is green before any feature code lands.

**Checkpoint**: dependencies installed, baseline green.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: everything every user story depends on — config schema, DB schema, enum vocabularies, and the router scaffolding stories plug into. No user story can start until this phase completes.

**⚠️ CRITICAL**: do not start US1–US4 tasks until Phase 2 is merged.

- [ ] T004 Extend the Zod config schema in `src/config.ts` with the 16 new env vars listed in `data-model.md` §7, including the `superRefine` cross-field rules (auto ⇒ default ≠ inline; shared-runner ⇒ URL+token present; isolated-job ⇒ KUBERNETES_SERVICE_HOST or KUBECONFIG warning). Defaults (canonical source: `data-model.md` §Config Surface): `TRIAGE_CONFIDENCE_THRESHOLD=1.0`, `MAX_CONCURRENT_ISOLATED_JOBS=3`, `PENDING_ISOLATED_JOB_QUEUE_MAX=20`, `TRIAGE_MAXTURNS_TRIVIAL=10`, `TRIAGE_MAXTURNS_MODERATE=30`, `TRIAGE_MAXTURNS_COMPLEX=50`, `DEFAULT_MAXTURNS=30` (per FR-008a).
- [ ] T005 [P] Unit tests for the new config schema — every new env var's default, every cross-field `superRefine` failure path, and the startup-warning path for missing K8s auth — in `src/config.test.ts`. Security-critical → must hit ≥90% line coverage.
- [ ] T006 Create `src/db/migrations/003_dispatch_decisions.sql` per `data-model.md` §3–§4 and `research.md` R10: extend `executions` with five columns, create `triage_results` table, add the two indexes. Advisory lock pattern from migration 001 reused; finally-block unlock required.
- [ ] T007 [P] Add `DispatchTarget` and `DispatchReason` string-literal unions plus their Zod enum schemas and runtime guards in a new file `src/shared/dispatch-types.ts`. Export named only.
- [ ] T008 [P] Unit tests for the enum guards in `src/shared/dispatch-types.test.ts`.
- [ ] T009 Extend `src/core/tracking-comment.ts` with a `renderDispatchReasonLine(reason, target)` helper that produces the one-line human-readable "why here?" string required by SC-007. No triage/queue rendering yet — those land in US2 / US3.
- [ ] T010 [P] Unit tests for `renderDispatchReasonLine` in `src/core/tracking-comment.test.ts` covering every `DispatchReason` value.
- [ ] T011 Refactor `src/webhook/router.ts`: replace the Phase-1 non-inline error-guard with a `decideDispatch(ctx): Promise<DispatchDecision>` scaffolding function that currently only returns `{ target: "inline", reason: "static-default", maxTurns: DEFAULT_MAXTURNS }` — plus a `dispatch(ctx, decision)` switch with a single `case "inline"` branch calling the existing inline pipeline. Other branches throw a typed `NotImplementedError` so story work can light them up one at a time.
- [ ] T012 [P] Unit test for the router scaffolding in `src/webhook/router.test.ts`: verifies inline path is taken, verifies `NotImplementedError` surface for the three unimplemented targets.
- [ ] T013 Emit the "dispatch decision" pino info log from `decideDispatch` per `contracts/dispatch-telemetry.md` §1 (minus the triage fields, which US2 adds). Write once, before `dispatch(...)` is invoked.

**Checkpoint**: router takes inline path, new DB schema applied, enums in place. `AGENT_JOB_MODE=inline` (the default) runs identically to pre-feature; setting it to `daemon`/`shared-runner`/`isolated-job`/`auto` surfaces `NotImplementedError` cleanly.

---

## Phase 3: User Story 1 — Deterministic routing by explicit signal (Priority: P1) 🎯 MVP

**Story goal**: label overrides and deterministic keyword rules route the majority of real traffic to the correct execution target without invoking any paid model.

**Independent test**: per `spec.md` US1 independent-test paragraph. Happy-path smoke tests 3.1 (`bot:shared` forcing shared-runner) and a local-only variant of 3.2 (`docker` keyword → isolated-job rejection when infra absent) from `quickstart.md`.

### Tests for User Story 1

- [ ] T014 [P] [US1] Contract test for the shared-runner `POST /internal/run` endpoint in `tests/contract/shared-runner-internal.test.ts` covering all request/response shapes documented in `contracts/shared-runner-internal.md` (200, 400 validation, 400 forbidden-tools, 401, 409, 429, 500, 504).
- [ ] T015 [P] [US1] Unit tests for the static classifier (see T017) in `src/k8s/classifier.test.ts` — every label-override case, every keyword rule, every event-type heuristic, plus the "ambiguous" default. Exhaustive case table.
- [ ] T016 [US1] Integration test for the US1 dispatch cascade in `tests/integration/router.us1-dispatch.test.ts` with GitHub API and Claude Agent SDK mocked. Covers US1 acceptance scenarios 1–4.

### Implementation for User Story 1

- [ ] T017 [P] [US1] Implement the static classifier in `src/k8s/classifier.ts`: pure function `classifyStatic(ctx: BotContext): StaticClassification` returning `{outcome:"clear", mode:"shared-runner"|"isolated-job"} | {outcome:"ambiguous"}`. Label precedence first (`bot:job`/`bot:shared`), then keyword rules (`docker`/`compose`/`dind`), then event-type heuristic, else `ambiguous`. Pure, no I/O.
- [ ] T018 [P] [US1] Implement the shared-runner dispatcher in `src/k8s/shared-runner-dispatcher.ts`: `dispatchToSharedRunner(ctx, decision): Promise<ExecutionSummary>` that issues `POST /internal/run` with `X-Internal-Token`, awaits the documented response, throws typed errors on 4xx/5xx, and records the execution row.
- [ ] T019 [P] [US1] Implement the isolated-job spawner in `src/k8s/job-spawner.ts`: `spawnIsolatedJob(ctx, decision): Promise<ExecutionSummary>` using `@kubernetes/client-node` `BatchV1Api.createNamespacedJob` with the Pod spec from `research.md` R8 (DinD sidecar, emptyDir, `backoffLimit:0`, `ttlSecondsAfterFinished`, `activeDeadlineSeconds`). Lazy-load `kc.loadFromCluster()` vs `loadFromDefault()` per R3. No queue / capacity bound yet — that's US3.
- [ ] T020 [P] [US1] Implement the isolated-job entrypoint in `src/k8s/job-entrypoint.ts`: reads `AGENT_CONTEXT_B64`, decodes the `BotContext`, invokes the existing inline pipeline with the expanded tool allow-list, writes the execution row, exits 0/1.
- [ ] T021 [US1] Extend `resolveAllowedTools()` in `src/core/prompt-builder.ts` with the job-mode branch from `research.md` R5: detect via `AGENT_JOB_MODE === "isolated-job"` or `AGENT_CONTEXT_B64` set; add `Bash(docker:*, docker-compose:*, npm:*, npx:*, bun:*, bunx:*, make:*, sh:*, bash:*, cp:*, mv:*)`. (Uses the canonical `DispatchTarget` enum value from T007 — `"isolated-job"` is not a valid value.)
- [ ] T022 [P] [US1] Unit tests for `resolveAllowedTools` branching in `src/core/prompt-builder.allowed-tools.test.ts` — inline, daemon, shared-runner, isolated-job scenarios × with-and-without `daemonCapabilities`.
- [ ] T023 [US1] Wire `decideDispatch` in `src/webhook/router.ts` to call `classifyStatic` and map its outcome to `DispatchDecision.target`/`reason`. For non-auto modes, respect `AGENT_JOB_MODE`. Short-circuit triage entirely (US2 will re-enable it).
- [ ] T024 [US1] Wire `dispatch(ctx, decision)` switch branches for `"daemon"` (delegate to existing Phase 2 dispatcher), `"shared-runner"` (call `dispatchToSharedRunner`), and `"isolated-job"` (call `spawnIsolatedJob`). Remove the corresponding `NotImplementedError`s.
- [ ] T025 [US1] Graceful-rejection path: when `isolated-job` is chosen but **K8s auth is absent** (neither `KUBERNETES_SERVICE_HOST` nor a usable `KUBECONFIG` resolves — `INTERNAL_RUNNER_URL` gates the shared-runner target, not this one), the dispatcher writes a rejection execution row with `dispatch_reason = "infra-absent"` (canonical enum from T007 / FR-010), posts the explanation to the tracking comment per FR-018 third sentence, and does NOT silently downgrade.
- [ ] T026 [P] [US1] JSDoc: every exported function touched in T017–T025 has `@param`/`@returns`/`@throws` per constitution §VIII. Reviewers will reject PR otherwise.

**Checkpoint**: label-forced and keyword-forced dispatch works end-to-end against shared-runner and (where infrastructure is available) isolated-job. Auto mode and triage still return `NotImplementedError` — that's US2's job. US1 can ship as an MVP PR here.

---

## Phase 4: User Story 2 — Probabilistic triage for ambiguous requests (Priority: P2)

**Story goal**: in auto mode, ambiguous events get a cheap single-turn classification whose result is threshold-gated and surfaced in the tracking comment. Triage failures fall back safely to the configured default target.

**Independent test**: `quickstart.md` scenarios 3.3 (auto-mode triage) and 3.4 (triage outage circuit breaker).

### Tests for User Story 2

- [ ] T027 [P] [US2] Contract test for the triage response schema in `tests/contract/triage-response.test.ts`: load `contracts/triage-response.schema.json`, validate a golden set of valid and invalid responses using the matching Zod schema, ensure parse-failure cases are rejected.
- [ ] T028 [P] [US2] Unit tests for the circuit breaker in `src/utils/circuit-breaker.test.ts`: closed→open on 5 consecutive failures, open→half-open after 60s cooldown, half-open→closed on success, half-open→open on failure. Security-critical → ≥90% coverage.
- [ ] T029 [P] [US2] Unit tests for the LLM provider adaptor in `src/ai/llm-client.test.ts`: `resolveModelId` alias fallthrough, `createLLMClient` provider branching (Anthropic vs Bedrock), with all I/O stubbed.
- [ ] T030 [P] [US2] Unit tests for the triage engine in `src/orchestrator/triage.test.ts`: happy-path parse, timeout → fallback, malformed-JSON → fallback, unknown-mode → fallback, sub-threshold → fallback, confidence edge cases (exactly threshold, 0.0, 1.0).
- [ ] T031 [US2] Integration test for US2 in `tests/integration/router.us2-triage.test.ts` with the LLM client mocked — covers US2 acceptance scenarios 1–4 and SC-005 (outage continues to serve traffic via default target).
- [ ] T031a [P] [US2] FR-019 cross-mode idempotency integration test in `tests/integration/router.idempotency.test.ts`: for each dispatch mode (`inline`, `daemon`, `shared-runner`, `isolated-job`, `auto`), replay the same `X-GitHub-Delivery` header twice back-to-back and once after a simulated process restart (in-memory `Map` cleared, durable tracking-comment check still present). Assert: (a) exactly one `executions` row per delivery, (b) exactly one `triage_results` row per delivery in auto mode (no double-billing), (c) no duplicate dispatch in any mode.
- [ ] T031b [P] [US2] SC-002 perf budget test in `tests/integration/triage-latency.test.ts`: drive 100 auto-mode events through the router with a deterministic-latency stub LLM client (fixed 50 ms response) and assert that the triage path added latency (from `decideDispatch` entry to tracking-comment update) stays under 500 ms at p95. Not a real perf benchmark — a budget regression guard so future refactors don't silently introduce blocking work on the triage path.

### Implementation for User Story 2

- [ ] T032 [P] [US2] Implement the minimal circuit breaker in `src/utils/circuit-breaker.ts` per `research.md` R7: three-state machine, consecutive-failure counter, 60s cooldown, latency cap.
- [ ] T033 [P] [US2] Implement the LLM provider adaptor in `src/ai/llm-client.ts` per `research.md` R2: `LLMClient` interface, `MODEL_MAP` with `"haiku-3-5"` aliases for both providers, `createLLMClient(config)` branching, `resolveModelId(alias, provider)`.
- [ ] T034 [US2] Implement the triage engine in `src/orchestrator/triage.ts`: `triageRequest(ctx): Promise<TriageResult | { outcome: "fallback", reason }>`. Wraps the LLM call in the circuit breaker, enforces `TRIAGE_TIMEOUT_MS`, validates the response via the Zod schema from `data-model.md` §3, applies `TRIAGE_CONFIDENCE_THRESHOLD` gating. Writes the `triage_results` row on success (parse+mode-known), logs warn on failure, never throws.
- [ ] T035 [US2] Extend `decideDispatch` in `src/webhook/router.ts` with the auto-mode triage branch per `quickstart.md` Mermaid flow: idempotency → mode check → label → static → triage → confidence gate → dispatch. Triage only fires when mode is `auto` AND static classification is `ambiguous` (FR-003, FR-017).
- [ ] T036 [US2] Extend the dispatch-decision log (T013) with triage fields per `contracts/dispatch-telemetry.md` §1: `triageInvoked`, `triageConfidence`, `triageComplexity`, `triageModel`, `triageProvider`, `triageLatencyMs`, `triageCostUsd` when triage ran.
- [ ] T037 [US2] Extend `src/core/tracking-comment.ts` with `renderTriageSection(triageResult)` producing the `<details>` collapsible block per `research.md` R6. Integrated into `createTrackingComment()`/`updateTrackingComment()`.
- [ ] T038 [US2] Apply `complexity → maxTurns` mapping (FR-008a) in the router right after the triage decision settles — `DispatchDecision.maxTurns` is set from `TRIAGE_MAXTURNS_{TRIVIAL,MODERATE,COMPLEX}` or `DEFAULT_MAXTURNS` when complexity is unknown/triage skipped.
- [ ] T039 [P] [US2] JSDoc pass on all functions added in T032–T038 per constitution §VIII.

**Checkpoint**: auto mode works end-to-end. Ambiguous events produce a triage call, honour the confidence threshold, gracefully degrade on provider outage via the circuit breaker, and render the rationale in the tracking comment. US2 can ship as a second PR.

---

## Phase 5: User Story 3 — Isolated execution back-pressure + capacity (Priority: P2)

**Story goal**: isolated-job target enforces a concurrency ceiling with a Valkey-backed FIFO pending queue; queue position is visible in the tracking comment; wall-clock budget terminates long-running jobs; no silent downgrade at capacity.

**Independent test**: `spec.md` US3 independent-test paragraph. Additional smoke test: post 5 `bot:job` requests with `MAX_CONCURRENT_ISOLATED_JOBS=2` set, confirm the 3rd–5th queue with visible positions and drain as capacity frees.

### Tests for User Story 3

- [ ] T040 [P] [US3] Unit tests for the pending queue in `src/k8s/pending-queue.test.ts` (Valkey mocked via the existing test double): enqueue when below max, reject when at max, FIFO dequeue, position-at-enqueue correctness, bot-context-key TTL expiry behaviour.
- [ ] T041 [P] [US3] Unit tests for the in-flight capacity tracker in the same file or adjacent (`SADD`/`SREM`/`SCARD` semantics).
- [ ] T042 [US3] Integration test for US3 in `tests/integration/router.us3-capacity.test.ts` with Valkey + k8s client mocked — covers US3 acceptance scenarios 1–4 (isolated-job tool allow-list, clean teardown, wall-clock termination, graceful rejection when infra entirely absent).

### Implementation for User Story 3

- [ ] T043 [P] [US3] Implement `src/k8s/pending-queue.ts` per `research.md` R4 and `data-model.md` §6: `enqueuePending(entry)`, `dequeuePending()`, `getPosition(deliveryId)`, `inFlightCount()`. Reuses the existing Bun `RedisClient` singleton. Zod-validated entries.
- [ ] T044 [US3] Wire the queue into the isolated-job branch in `src/webhook/router.ts`: before `spawnIsolatedJob`, check `inFlightCount()` against `MAX_CONCURRENT_ISOLATED_JOBS`; if at capacity, enqueue and return. A background drainer (single interval or Valkey keyspace notification) dequeues when in-flight drops.
- [ ] T045 [US3] Add `renderQueuePosition(position, max)` and integrate into `src/core/tracking-comment.ts` so queued requests show `⏳ Queued (position N of M on isolated-job pool). Waiting for capacity…`. Dequeue transitions the comment state back to `running`.
- [ ] T046 [US3] Enforce the Job's `activeDeadlineSeconds` handling in `src/k8s/job-spawner.ts`: wrap the Job-watch promise in a wall-clock timeout; on timeout, delete the Job, emit the "timed out" tracking-comment update, write the execution row with `status="timeout"`, release the in-flight slot.
- [ ] T047 [US3] Cleanup guarantees: on normal completion, failure, OR timeout, the spawner MUST `delete bot-context:<deliveryId>` and `SREM dispatch:isolated-job:in-flight <deliveryId>` in a `finally` block. Orphan Jobs are additionally swept by `ttlSecondsAfterFinished`. Add a unit test that simulates each exit path.
- [ ] T048 [US3] No-retry policy (FR-021): on isolated-job mid-run failure, the spawner records the failure with exit reason + log link, updates the tracking comment, and does NOT re-dispatch. Explicit integration test.
- [ ] T049 [P] [US3] JSDoc pass on functions added in T043–T048.

**Checkpoint**: isolated-job target has correct back-pressure. SC-001/SC-002 still hold (queue ops are sub-millisecond). US3 can ship as a third PR.

---

## Phase 6: User Story 4 — Operator visibility and cost accountability (Priority: P3)

**Story goal**: operators can introspect dispatch decisions per event and in 30-day aggregate. Triage cost and confidence are accounted per event.

**Independent test**: `spec.md` US4 independent-test paragraph — processes a mixed batch, runs the four FR-014 aggregate queries from `contracts/dispatch-telemetry.md` §5, every column accounts for every event.

### Tests for User Story 4

- [ ] T050 [P] [US4] DB integration test in `tests/integration/telemetry-aggregates.test.ts`: seed a mix of `executions` + `triage_results` rows via the real migration, run the four queries from `contracts/dispatch-telemetry.md` §5, assert expected shapes.

### Implementation for User Story 4

- [ ] T051 [US4] Implement `src/db/queries/dispatch-stats.ts` exporting the four aggregate queries as typed functions (`eventsPerTarget(days)`, `triageRate(days)`, `avgConfidenceAndFallback(days)`, `triageSpend(days)`). Thin wrappers over `Bun.sql` — no new types beyond the return rows.
- [ ] T052 [US4] Update the execution-record write path in `src/orchestrator/history.ts` to persist the three new denormalised triage columns (`triage_confidence`, `triage_cost_usd`, `triage_complexity`) whenever a `TriageResult` is present on the `DispatchDecision`. Do NOT write them when triage didn't run.
- [ ] T053 [P] [US4] Verify every dispatch decision produces the structured log described in `contracts/dispatch-telemetry.md` §1–§2 — add a `tests/integration/telemetry-logs.test.ts` that drives every `DispatchReason` value through the router and asserts log field presence.
- [ ] T054 [P] [US4] JSDoc pass on the new query functions.

**Checkpoint**: operator dashboards have a stable contract. SC-003 and SC-004 measurable.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T055 [P] Add the Mermaid dispatch-cascade diagram from `quickstart.md` §Dispatch cascade to `docs/dispatch-flow.md` (create the `docs/` folder if absent). Validate via `bun run format` and the Mermaid lint step per constitution §VIII.
- [ ] T056 Verify that the constitution amendment (T000, Phase 0) has been merged to `main` and that plan.md §Constitution Check row "AI Orchestration" has been updated to cite the new carve-out. If either is missing, this feature cannot ship. (The amendment itself is T000, landed in a separate prior PR — NOT here.)
- [ ] T057 [P] Update `CLAUDE.md` "Active Technologies" section with the two new deps and the new dispatch-mode taxonomy (the automated `update-agent-context.sh` pass already touched this file — this task is a human review/cleanup of that output).
- [ ] T058 Run `bun run check` on the full feature branch — typecheck, lint, format, test. Address any regressions. Per constitution §Development Workflow > Quality Gate this MUST be green before the final PR merges.
- [ ] T059 Run the full `quickstart.md` §3 smoke-test sequence end-to-end against `bun run dev:deps` Docker Compose. Report results in the PR description — any deviation from the expected observations is a release blocker.
- [ ] T060 [P] Coverage verification: `bun test --coverage` — confirm security-critical modules (T005 config parser, T028 circuit breaker, T030 triage parser, T027 triage contract) are at ≥90% line coverage; all other new modules at ≥70%.

---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 0 (Constitution Prerequisite)**: standalone prior PR. BLOCKS Phase 4 (and any task authoring direct-LLM code: T029, T033, T034).
- **Phase 1 (Setup)**: independent of Phase 0 — can start immediately (the two new deps are not yet used).
- **Phase 2 (Foundational)**: depends on Phase 1. BLOCKS all user stories.
- **Phase 3 (US1)**: depends on Phase 2. Ships the MVP. Does NOT depend on Phase 0 (no direct-LLM code here).
- **Phase 4 (US2)**: depends on Phase 2 **AND Phase 0**. Independent of US1 at the file level, but integration tests will assume US1 lands first for realism.
- **Phase 5 (US3)**: depends on Phase 2 + US1 (US3 enhances the isolated-job path US1 establishes).
- **Phase 6 (US4)**: depends on Phase 2 + US1 + US2 (needs both dispatch-decision and triage-result rows to aggregate over).
- **Phase 7 (Polish)**: depends on all desired user stories.

### User story dependencies (fine-grained)

- **US1 (P1)** — the MVP. Establishes every dispatch target at a basic level. Shippable on its own with `AGENT_JOB_MODE ∈ {inline, daemon, shared-runner, isolated-job}` (non-auto).
- **US2 (P2)** — adds auto mode. Depends on US1's target dispatchers being callable (so triage has somewhere to route).
- **US3 (P2)** — adds capacity/queue to the isolated-job path US1 established. Does NOT depend on US2.
- **US4 (P3)** — observability. Depends on US1+US2 so there's data to aggregate.

### Within each user story

- Tests (T0xx that are `[P] [USx]`) and implementation tasks in the same story are written against the same file tree; the tests are co-located per constitution §V. Co-locate, don't TDD-first-fail unless the task-writer chooses to.
- Models/schemas before services; services before router wiring; router wiring before integration tests.

### Parallel opportunities

- T002/T007/T008/T009/T010 can all run in parallel inside Phase 2 (different files).
- US1 implementation T017/T018/T019/T020 are all different files, no cross-deps until T023 stitches them — fully parallelisable.
- US2 T032/T033 are independent; T034 depends on both.
- US3 T043 is independent of the isolated-job spawner extensions in T046; T044/T047 depend on T043.
- Phase 7 polish tasks (T055/T057/T060) are file-independent and can run in parallel.

---

## Parallel Example: User Story 1

```bash
# Once Phase 2 is merged, start these in parallel (different files, no cross-deps):
Task: "Implement static classifier in src/k8s/classifier.ts"                        # T017
Task: "Implement shared-runner dispatcher in src/k8s/shared-runner-dispatcher.ts"   # T018
Task: "Implement isolated-job spawner in src/k8s/job-spawner.ts"                    # T019
Task: "Implement isolated-job entrypoint in src/k8s/job-entrypoint.ts"              # T020

# Tests, also in parallel (different test files):
Task: "Contract test for shared-runner /internal/run in tests/contract/..."         # T014
Task: "Unit tests for static classifier in src/k8s/classifier.test.ts"              # T015
```

---

## Implementation Strategy

### MVP first (US1 only — minimum shippable slice)

1. Phase 1 (setup) — ~1 PR or part of the foundational PR.
2. Phase 2 (foundational) — one PR; must pass `bun run check` before merge.
3. Phase 3 (US1) — one PR; label and keyword routing live in production with auto mode disabled.
4. **Stop and validate**: run quickstart §3.1–3.2. If green, this is a shippable MVP.

### Incremental delivery

1. Phase 2 foundational lands → rollback safety verified with `AGENT_JOB_MODE=inline`.
2. Phase 3 US1 lands → label/keyword routing live; still no paid-model calls in production.
3. Phase 4 US2 lands → auto mode enabled behind `TRIAGE_CONFIDENCE_THRESHOLD=1.0`, observe SC-003/SC-004 telemetry for 2 weeks before lowering to 0.75.
4. Phase 5 US3 lands → capacity management; SC-001 confirmed.
5. Phase 6 US4 lands → operator dashboards; close the feedback loop.
6. Phase 7 polish → constitution PATCH, docs, coverage gate.

### Parallel team strategy

With two developers after Phase 2:

- Developer A: US1 (T014–T026), then US3 (T040–T049).
- Developer B: US2 (T027–T039), then US4 (T050–T054).
- Both converge on Phase 7 together.

---

## Task summary

- **Total tasks**: 63 (T000–T060 plus T031a and T031b).
- **Phase 0 — Constitution Prerequisite**: 1 (T000).
- **Phase 1 — Setup**: 3 (T001–T003).
- **Phase 2 — Foundational**: 10 (T004–T013).
- **Phase 3 — US1 (MVP)**: 13 (T014–T026).
- **Phase 4 — US2**: 15 (T027–T039, plus T031a and T031b).
- **Phase 5 — US3**: 10 (T040–T049).
- **Phase 6 — US4**: 5 (T050–T054).
- **Phase 7 — Polish**: 6 (T055–T060).

### Parallel opportunities identified

- Phase 2: 5 [P] tasks (T005, T007, T008, T010, T012).
- US1: 8 [P] tasks (T014, T015, T017, T018, T019, T020, T022, T026).
- US2: 8 [P] tasks (T027, T028, T029, T030, T031a, T031b, T033, T039 — T033 parallel with T032; T034 serialises on both).
- US3: 4 [P] tasks (T040, T041, T043, T049).
- US4: 3 [P] tasks (T050, T053, T054).
- Polish: 3 [P] tasks (T055, T057, T060).

### Independent test criteria per story

| Story | Independent test (drop-in from spec.md + quickstart.md)                                                                                                   |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| US1   | quickstart §3.1 (`bot:shared` → shared-runner), §3.2 (`docker` keyword infra-absent fallback), plus unit coverage of every static-classifier case (T015). |
| US2   | quickstart §3.3 (auto-mode triage with rationale in tracking comment), §3.4 (circuit-breaker outage survival), plus triage-engine unit coverage (T030).   |
| US3   | spec US3 paragraph — dispatch 5× `bot:job` at capacity 2, observe positions 1–3 queued, drain FIFO, no silent downgrade, clean pod teardown.              |
| US4   | spec US4 paragraph — run all four SQL aggregates from `contracts/dispatch-telemetry.md` §5 against a seeded DB, every event accounted for.                |

### Suggested MVP scope

**Phases 1 + 2 + 3 only** (T001–T026). Label and keyword routing ship to production with `AGENT_JOB_MODE` flippable between `inline` / `daemon` / `shared-runner` / `isolated-job`. Auto mode remains disabled until US2 lands — so the MVP has zero paid-model calls.

### Format validation

All 63 tasks above (T000–T060 plus T031a/T031b) follow the strict format:

- `- [ ]` checkbox ✅
- sequential `T001`–`T060` IDs ✅
- `[P]` only on tasks with no in-phase dependencies and disjoint file paths ✅
- `[USn]` on every Phase 3–6 task, never on Setup/Foundational/Polish ✅
- absolute file paths present on every implementation task ✅
