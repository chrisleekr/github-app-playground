---
description: "Task list for ship-iteration-wiring feature"
---

# Tasks: Ship Iteration Wiring

**Input**: Design documents from `/specs/20260429-212559-ship-iteration-wiring/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Test tasks are included because Constitution Principle V (NON-NEGOTIABLE) requires unit tests for security-critical and core-pipeline modules, and FR-020 requires integration tests for the daemon WS round-trip and tickle re-entry.

**Organization**: Tasks are grouped by user story. US1 is the MVP — once it ships, the iteration loop works for any PR whose remediation fits the existing legacy pipeline. US2 unlocks paused intents. US3 wires the four scoped daemon executors.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no incomplete-task dependencies)
- **[Story]**: Maps to user story from spec.md (US1, US2, US3); omitted in Setup/Foundational/Polish phases

## Path conventions

Single-project Bun layout per `plan.md`. Source under `src/`, tests co-located as `*.test.ts` plus integration tests under `tests/integration/`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Extend the shared type system so subsequent phases can compile.

- [ ] T001 [P] Document the `workflow_runs.context_json.shipIntentId` convention in `src/shared/workflow-types.ts` as a JSDoc note on the existing `WorkflowRunRef` interface (no struct change; this is a convention contract per research.md Q1).
- [ ] T002 [P] Add a `ShipIntentContextSchema` Zod schema in `src/workflows/ship/intent.ts` (or a new `src/workflows/ship/workflow-context.ts` if `intent.ts` is at line-count limit) that types and validates `{ shipIntentId: string }` for use at insert/read sites.
- [ ] T003 [P] Introduce a `kind` discriminator on `QueuedJob` in `src/orchestrator/job-queue.ts` and convert it to a Zod-validated discriminated union with five variants: `legacy` (existing shape), `workflow-run` (existing — moves the current `workflowRun?` field under this variant), and the four new `scoped-*` variants per `contracts/job-kinds.md`. **This is a non-trivial refactor**: every existing producer (orchestrator dispatcher, ephemeral-daemon scaler, all webhook event handlers that call `enqueueJob`) and every existing consumer (`src/daemon/job-executor.ts`, queue-worker, history) MUST be updated to set/read the new `kind` field. Today's implicit "presence of `workflowRun` ⇒ workflow-run path" check becomes an explicit `kind === "workflow-run"` switch.
- [ ] T004 [P] Extend WS message Zod schemas in `src/shared/ws-messages.ts` with `scoped-job-offer` and `scoped-job-completion` (per `contracts/ws-messages.md`); add `scoped-kind-unsupported` to the reject-reason enum.
- [ ] T005 Co-locate Zod schema unit tests in `src/shared/ws-messages.test.ts` — round-trip parse/serialize for each new message kind plus rejection of malformed payloads.

**Checkpoint**: Types compile, schemas validate; no behavior change yet.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Wire the daemon-side dispatch surface so Phase 3+ executors have a place to plug in. Splits the `job-executor` switch and adds the orchestrator-side completion cascade scaffold.

**⚠️ CRITICAL**: All user-story tasks below depend on this phase.

- [ ] T006 Extend `src/daemon/job-executor.ts` to switch on `JobKind` and route `scoped-*` kinds to a new private `runScopedJob` function that throws `not implemented` for each kind (placeholder filled in US3). Keep existing `legacy` and `workflow-run` paths unchanged.
- [ ] T007 Add a `handleWorkflowRunCompletion` cascade hook in `src/workflows/orchestrator.ts` that, on every completed `workflow_runs` row, reads `context_json.shipIntentId`. If present AND the intent is non-terminal, executes `ZADD ship:tickle 0 <intent>` via the existing Valkey client. No-op otherwise.
- [ ] T008 [P] Add a structured-logging `event` namespace constant to `src/workflows/ship/log-fields.ts` covering `ship.iteration.*`, `ship.tickle.*`, `ship.scoped.*.daemon.*` (no functional code; log-key contract for Phase 3+).
- [ ] T009 Co-locate test for cascade hook in `src/workflows/orchestrator.test.ts` (or extend the existing test file) — verifies that completion of a workflow run carrying `shipIntentId` triggers the ZADD; completion without it does not; completion of a terminal intent does not.

**Checkpoint**: Daemon dispatcher compiles with stub branches; orchestrator cascade fires under unit test; no scoped executor exists yet.

---

## Phase 3: User Story 1 — Iteration loop drives a non-ready PR to merge-ready (Priority: P1) 🎯 MVP

**Goal**: When a probe returns a non-ready verdict, the bot inserts a `workflow_runs` row carrying `shipIntentId`, enqueues a daemon job, and on completion early-wakes the intent so the loop continues.

**Independent Test**: Open a PR with one unresolved review thread; comment `@chrisleekr-bot-dev ship`; observe at least one `workflow_runs` row inserted with `shipIntentId`, observe daemon completion triggers a `ship.tickle.*` event for that intent, observe the intent eventually transitioning to terminal-ready. (Quickstart S2.)

### Tests for User Story 1 ⚠️

> **Write these tests FIRST, ensure they FAIL before implementation.**

- [ ] T010 [P] [US1] Unit tests for the iteration handler in `src/workflows/ship/iteration.test.ts` — covers: cap exceeded → terminal:halted:cap; deadline exceeded → terminal:halted:deadline; non-ready verdict with valid action → workflow_runs row inserted + job enqueued + ship_iterations row appended; verdict missing required field → throws.
- [ ] T011 [US1] Integration test in `tests/integration/ship-iteration-loop.test.ts` — full round-trip: seed an active intent, simulate a non-ready probe, assert the queued job has `workflowRun.workflowName` set and `context_json.shipIntentId` matches the seeded intent.

### Implementation for User Story 1

- [ ] T012 [US1] Create `src/workflows/ship/iteration.ts` with exported `runIteration({ intent, probeVerdict, db, valkey, log })` that: (a) re-evaluates cap/deadline (transition terminal if exceeded); (b) selects exactly one next action from the verdict (one-action-per-iteration per research.md Q4); (c) inserts a `workflow_runs` row via the existing helper, embedding `shipIntentId` in `context_json`; (d) enqueues via `enqueueJob({ workflowRun: ... })`; (e) appends to `ship_iterations`; (f) emits `event=ship.iteration.enqueued` log line.
- [ ] T013 [US1] Replace the `"iteration loop pending US2"` log block in `src/workflows/ship/session-runner.ts` (the non-ready branch around the existing log statement) with a call to `runIteration` from T012.
- [ ] T014 [US1] Add cap and deadline accessors (helpers) reading `config.maxShipIterations` (env: `MAX_SHIP_ITERATIONS`) and `config.maxWallClockPerShipRun` (env: `MAX_WALL_CLOCK_PER_SHIP_RUN`). Place in `src/workflows/ship/intent.ts` if no equivalent exists; if cap/deadline accessors already exist there, reuse them. The iteration handler MUST read from a single source of truth — no duplicated cap-comparison logic.
- [ ] T015 [US1] Verify the orchestrator cascade from T007 actually fires on iteration-driven runs by extending `tests/integration/ship-iteration-loop.test.ts` with a "completion → tickle ZADD" assertion that uses a Valkey test double or an isolated test database.
- [ ] T016 [US1] Add JSDoc to all exports in `iteration.ts` per Constitution Principle VIII; include `@param`, `@returns`, `@throws` for any error paths.

**Checkpoint**: User Story 1 fully functional — `bot:ship` on a non-ready PR drives at least one iteration through the existing daemon pipeline and re-enters via tickle on completion. (US2 makes the _paused_ re-entry work; US1 only requires the early-wake `score=0` path.)

---

## Phase 4: User Story 2 — Paused intents wake and resume on schedule (Priority: P2)

**Goal**: Tickle scheduler runs in the webhook server; paused intents whose `due_at` has elapsed (or that were early-woken in US1's cascade) get re-entered exactly once. Cap and deadline are checked at resume time.

**Independent Test**: Manually `ZADD ship:tickle 0 <intent>` on a paused intent; observe the scheduler's tick loop fires `onDue`, the resume handler loads the intent, re-probes, and either advances or re-pauses with an updated `due_at`. (Quickstart S3.)

### Tests for User Story 2 ⚠️

- [ ] T017 [P] [US2] Unit tests for `resumeShipIntent` in `src/workflows/ship/session-runner.test.ts` — covers: terminal intent → no-op (no enqueue, no `due_at` write); cap/deadline tripped → terminal transition; ready verdict → terminal:ready; non-ready verdict → calls runIteration; awaiting verdict → re-pause with new `due_at`.
- [ ] T018 [US2] Integration test in `tests/integration/ship-tickle-resume.test.ts` — boot `createTickleScheduler` against a test Valkey + Postgres, seed a paused intent, ZADD with `score=0`, await one tick, assert exactly one `runIteration`-equivalent side-effect occurred.

### Implementation for User Story 2

- [ ] T019 [US2] Add `resumeShipIntent({ intentId, octokitFactory, log })` to `src/workflows/ship/session-runner.ts` — loads intent + last continuation + runs probe → branches to `runIteration` (active) or persists new `due_at` (re-pause) or transitions terminal (cap/deadline/ready). Skips terminal intents cleanly.
- [ ] T020 [US2] Wire `createTickleScheduler` startup in `src/app.ts` after orchestrator init and before HTTP listen: pass `valkey: requireValkeyClient()` and an `onDue: (intent_id) => resumeShipIntent({ intentId: intent_id })` callback. Then `await tickleScheduler.start()` — this single call performs the boot reconciliation against `ship_continuations` AND begins the periodic scan (verified in `src/workflows/ship/tickle-scheduler.ts`; do NOT call any separate reconcile method, none is exposed). The `sql` and `intervalMs` deps default to the global config and may be omitted.
- [ ] T021 [US2] Wire graceful shutdown in `src/app.ts` to call `tickleScheduler.stop()` before HTTP drain on `SIGTERM`/`SIGINT`.
- [ ] T022 [US2] Add a startup log line `event=ship.tickle.started` so the quickstart pre-flight check (S0) can verify the scheduler is running.
- [ ] T023 [US2] Add JSDoc to `resumeShipIntent` and the new boot-wiring helpers per Constitution VIII.

**Checkpoint**: User Story 2 fully functional — paused intents re-enter via the tickle loop AND the orchestrator cascade from T007 (early-wake) drives multi-iteration ship sessions to completion across `awaiting:*` waits.

---

## Phase 5: User Story 3 — Scoped commands execute deterministically against a PR (Priority: P3)

**Goal**: The four scoped commands (`bot:rebase`, `bot:fix-thread`, `bot:explain-thread`, `bot:open-pr` actionable) execute via daemon-side executors instead of posting "not yet wired" notices.

**Independent Test**: Each verb tested in isolation per quickstart S4–S9. Each executor produces the documented user-visible behavior and emits the documented `ship.scoped.*.daemon.*` log events.

### Tests for User Story 3 ⚠️

- [ ] T024 [P] [US3] Unit tests for `scoped-rebase-executor` in `src/daemon/scoped-rebase-executor.test.ts` — covers: closed PR → refuse; up-to-date → no push; clean merge → push (no force); conflict → abort + path list; ALWAYS clean up temp dir (verified via spy).
- [ ] T025 [P] [US3] Unit tests for `scoped-fix-thread-executor` in `src/daemon/scoped-fix-thread-executor.test.ts` — covers: agent with diff → push + thread reply + thread resolve; agent with no diff → reply "no change required" without commit; agent writes outside thread scope → halt without push.
- [ ] T026 [P] [US3] Unit tests for `scoped-explain-thread-executor` in `src/daemon/scoped-explain-thread-executor.test.ts` — covers: read-only behavior (no push, no thread resolve); agent reply posted on thread; write-tool denylist enforced.
- [ ] T027 [P] [US3] Unit tests for `scoped-open-pr-executor` in `src/daemon/scoped-open-pr-executor.test.ts` — covers: branch created from default; PR opened linking issue; agent produces no diff → halt without empty branch.
- [ ] T028 [US3] Integration test in `tests/integration/scoped-rebase-roundtrip.test.ts` — full WS round-trip: orchestrator enqueues `scoped-rebase`, daemon receives offer, accepts, completes, reports outcome. Validates `contracts/ws-messages.md` end-to-end for at least one scoped kind (FR-020).

### Implementation for User Story 3

- [ ] T029 [P] [US3] Create `src/daemon/scoped-rebase-executor.ts` per `contracts/job-kinds.md#scoped-rebase`. Deterministic git only; uses existing clone helper from `src/core/pipeline.ts`; never invokes Agent SDK. Returns `RunMergeResult` consumed by `src/workflows/ship/scoped/rebase.ts`'s policy layer.
- [ ] T030 [P] [US3] Create `src/daemon/scoped-fix-thread-executor.ts` per `contracts/job-kinds.md#scoped-fix-thread`. Reuses `resolve-review-thread` MCP server; agent prompt scoped to `filePath:startLine-endLine`.
- [ ] T031 [P] [US3] Create `src/daemon/scoped-explain-thread-executor.ts` per `contracts/job-kinds.md#scoped-explain-thread`. Read-only — no clone, agent denylist excludes `Edit`/`Write`/`Bash` mutations.
- [ ] T032 [P] [US3] Create `src/daemon/scoped-open-pr-executor.ts` per `contracts/job-kinds.md#scoped-open-pr`. Replaces the throw inside the `createBranchAndPr` callback site in `src/workflows/ship/scoped/dispatch-scoped.ts`.
- [ ] T033 [US3] Replace the `runScopedJob` placeholder in `src/daemon/job-executor.ts` (T006) with the real switch that dispatches to the four executors from T029–T032. Each branch enforces idempotency by checking the existing tracking-comment durable layer before side-effects (per `contracts/job-kinds.md` Idempotency).
- [ ] T033b [US3] Wire the **server-side `scoped-job-completion` handler** in `src/orchestrator/connection-handler.ts` (verified by grep: this file already owns the existing job-accept and result-handling paths via `getPendingOffer(offerId)` / `removePendingOffer(offerId)`). Add a new branch in the inbound WS message router that, on receiving `scoped-job-completion`: (a) validates the payload via the Zod discriminated union from T004; (b) calls `getPendingOffer(msg.id)` to retrieve the originating offer context; (c) invokes the matching policy module's comment-formatter (`src/workflows/ship/scoped/rebase.ts`'s outcome → comment for `scoped-rebase`; analogous for the other three) to post the user-facing reply on the PR/issue/thread; (d) calls `removePendingOffer(msg.id)`. Without this bridge, the daemon executors run but the maintainer never sees the reply — quickstart S4–S9 will fail. Co-locate a unit test in `src/orchestrator/connection-handler.test.ts` asserting one Octokit comment-create call per completion kind.
- [ ] T034 [US3] In `src/workflows/ship/scoped/dispatch-scoped.ts`, replace the four `"not yet wired"` notice paths and the throw in the `createBranchAndPr` callback with `enqueueJob({ kind: 'scoped-*', ... })` calls that emit `event=ship.scoped.*.enqueued` log lines. Locate the sites by symbol (the four notice strings + the `createBranchAndPr` callback definition), not by line number.
- [ ] T035 [US3] Read `scripts/check-no-destructive-actions.ts`, confirm its scan glob covers `src/daemon/scoped-*-executor.ts`, extend the glob if the four new executor files would otherwise fall outside coverage, and run `bun run scripts/check-no-destructive-actions.ts` to confirm a clean exit. Document any glob change in the PR body.
- [ ] T036 [US3] Add JSDoc to all exports in T029–T032 per Constitution VIII; include `@throws` for halt conditions.

**Checkpoint**: User Story 3 fully functional — all four scoped commands execute end-to-end. Quickstart S4–S9 all pass.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, retrospective bookkeeping on the merged spec, and end-to-end validation against `@chrisleekr-bot-dev`.

- [ ] T037 [P] Update `docs/BOT-WORKFLOWS.md` with a "Bridge architecture" section describing how the new ship-intents lifecycle bridges to the existing `workflow_runs` daemon pipeline. Include one Mermaid diagram (per Constitution VIII) showing: comment → intent → iteration → workflow_runs → daemon → completion → tickle → resume.
- [ ] T038 [P] Update `docs/OBSERVABILITY.md` with the new `event` keys (`ship.iteration.*`, `ship.tickle.*`, `ship.scoped.*.daemon.*`) and what each indicates.
- [ ] T039 [P] Retrospectively annotate the misclassified entries in `specs/20260427-201332-pr-shepherding-merge-ready/tasks.md` for tasks T021, T046, T070, T071, T082, T083, T085, T088, T092. Leave the existing `[x]` checkbox in place (universal Markdown renders only `[ ]`/`[x]`); append `(superseded by specs/20260429-212559-ship-iteration-wiring/tasks.md TXX)` to each line, citing the specific replacement task. (FR-022.)
- [ ] T040 Run `bun run check` (typecheck + lint + format + test) — must pass with zero errors before quickstart execution. Re-run after any fix.
- [ ] T041 Verify SC-007 holds: `grep -rn "not yet wired" src/` returns zero matches. Verify SC-003: `bun run scripts/check-no-destructive-actions.ts` exits 0.
- [ ] T041b Verify FR-019 (no new npm dependencies) by running `git diff origin/main -- package.json` and confirming the `dependencies` and `devDependencies` blocks are unchanged. Any addition MUST be flagged in the PR description with justification per Constitution Development Workflow §"Dependency Additions". `bun.lock` changes that are pure transitive churn from existing deps are acceptable.
- [ ] T042 Execute `quickstart.md` scenarios S1–S11 against `@chrisleekr-bot-dev` via ngrok. Record pass/fail + observed behavior for each scenario in a worksheet attached to the PR description. SC-004 requires all 11 to pass.
- [ ] T043 Final review of feature against spec.md success criteria SC-001 through SC-007; for any gap, file a follow-up issue rather than masking with a workaround (per quickstart on-failure guidance).

**Checkpoint**: Feature complete; PR ready for merge.

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately.
- **Foundational (Phase 2)**: Depends on Setup. Blocks all user stories.
- **US1 (Phase 3)**: Depends on Foundational. MVP — ships the core iteration loop.
- **US2 (Phase 4)**: Depends on Foundational. Can technically start in parallel with US1, but US2 integration test reuses pieces from US1, so sequential is recommended unless multi-developer.
- **US3 (Phase 5)**: Depends on Foundational. Independent of US1/US2 — can ship in parallel.
- **Polish (Phase 6)**: Depends on US1, US2, US3 all complete (specifically T042 — quickstart — requires all features wired).

### Within each user story

- Tests written and failing → implementation → tests pass.
- Models/types before services; services before integration.
- JSDoc updates land in the same commit as the implementation (Constitution VIII).

### Parallel opportunities

- **Phase 1**: T001, T002, T003, T004 are independent files → all `[P]`. T005 depends on T004.
- **Phase 2**: T008 is an independent file. T006 + T007 + T009 can run in parallel if T009's test only needs the cascade hook compiled.
- **US1**: T010 (test) + T012 (impl) target different concerns; T013 depends on T012; T011 + T015 are integration tests against the same file but at different lines, so sequence them.
- **US3**: T024–T027 (tests) all `[P]`; T029–T032 (executors) all `[P]` — four independent files. T033 depends on all four. T033b is in a different file (orchestrator WS handler) and depends only on T004 (Zod schemas) — can run in parallel with T029–T032. T034 is in a different file — can start once the four executors compile.
- **Polish**: T037, T038, T039 all `[P]` — three different files.

### MVP path

1. Phase 1 → 2 → 3 (US1).
2. **Stop and validate**: run `bun run check` + manual quickstart S1 + S2 against a test PR.
3. If green, Phase 4 (US2) → Phase 5 (US3) → Phase 6.

---

## Implementation Strategy

### MVP first (US1 only)

1. T001–T005 (Setup).
2. T006–T009 (Foundational).
3. T010–T016 (US1).
4. **Validate**: quickstart S1 + S2 manually; `bun run check` green.

### Incremental delivery

After MVP:

5. T017–T023 (US2) → quickstart S3 passes.
6. T024–T036 (US3) → quickstart S4–S9 all pass.
7. T037–T043 (Polish + full e2e).

### Sequential vs. parallel team

This feature is small enough that a single developer can ship it sequentially in 2–3 focused sessions. Parallelism is available within phases (see Parallel Opportunities above) but cross-story parallelism is not the bottleneck — risk is in correctness of the bridge contract, not throughput.

---

## Notes

- `[P]` tasks = different files, no dependencies on incomplete tasks above them.
- `[Story]` label maps to spec.md user stories for traceability.
- Each user story is independently testable (US1 alone delivers the iteration loop value; US2 alone delivers paused-resume; US3 alone delivers the scoped commands).
- Verify tests fail before implementing (Constitution V test-first preference for new features).
- Commit per logical group: one commit per `[US?]` block is a reasonable granularity.
- Stop at any checkpoint to validate independently before continuing.
- Avoid: vague tasks, same-file conflicts within `[P]` groups, cross-story dependencies that break independence.
