# Phase 0 Research: Definitive Bot Workflows

All Technical Context fields resolved — no NEEDS CLARIFICATION markers remain. Each decision below locks one question so Phase 1 design can proceed without revisiting it.

## 1. Registry representation: TypeScript const vs YAML/JSON data file

**Decision**: A plain TypeScript `const` object in `src/workflows/registry.ts` typed against a Zod schema, exporting both the parsed registry and narrow types (`WorkflowName`, `RegistryEntry`).

**Rationale**:

- Zero runtime parse cost, IDE-navigable (F12 from handler to registry).
- Zod schema enforces the FR-022 shape (name, label, context, prior, steps, handler) at startup per Constitution IV — config validated fail-fast.
- Handler reference can be a direct import, giving the compiler end-to-end type checking between registry entry and handler signature. A YAML/JSON file would force string-keyed lookup and lose that.
- Adding a new workflow still satisfies FR-024: one registry entry + one handler file + one doc section.

**Alternatives considered**:

- **YAML/JSON + dynamic import**: rejected — handler reference becomes a string, losing type safety; adds parse step on every cold start; Bun's test runner does not hot-reload YAML changes the way it does TS.
- **Decorator-based auto-discovery** (`@Workflow(...)` on each handler class): rejected — hides the "single authoritative list" the spec explicitly demands (FR-022) behind runtime discovery. Makes docs generation and static analysis harder. Also pulls in reflection metadata, increasing surface area for no clear gain.

## 2. `workflow_runs` schema: one row per run, JSON state

**Decision**: One table, columns `id UUID PK`, `workflow_name TEXT NOT NULL`, `target_type TEXT CHECK IN ('issue','pr')`, `target_owner TEXT`, `target_repo TEXT`, `target_number INT`, `parent_run_id UUID NULL REFERENCES workflow_runs(id)`, `parent_step_index INT NULL`, `status TEXT CHECK IN ('queued','running','succeeded','failed')`, `state JSONB NOT NULL DEFAULT '{}'::jsonb`, `tracking_comment_id BIGINT NULL`, `created_at TIMESTAMPTZ`, `updated_at TIMESTAMPTZ`. Unique index on `(workflow_name, target_owner, target_repo, target_number)` **partial** `WHERE status IN ('queued','running')` to enforce FR-011 idempotency at the database layer. (The `status` column gates the partial predicate, not the uniqueness key — including it in the key would allow two in-flight rows with different statuses, which is exactly what we must prevent.)

**Rationale**:

- Satisfies FR-025 verbatim: adding a new workflow writes a new `workflow_name` value; no migration.
- Composite runs (`ship`) are represented by a parent row plus child step rows linked via `parent_run_id`. `parent_step_index` records which entry in `steps` the child corresponds to — gives the orchestrator a deterministic "what's next" lookup (FR-028) without reading back the registry at hand-off time.
- Partial unique index is narrow on purpose: finished runs (success or failure) do not block a re-run; only in-flight duplicates are rejected. Matches FR-011's "unless the maintainer explicitly requests a re-run" clause.
- JSONB (not JSON) so we can GIN-index later if any workflow grows inspectable state. No index needed in v1.

**Alternatives considered**:

- **Per-workflow table**: rejected by the spec clarification itself — violates FR-025.
- **`completed_at TIMESTAMPTZ NULL` instead of `status` enum**: rejected — `status` cleanly distinguishes `queued` (enqueued but not yet claimed) from `running` (claimed) from terminal states, which the idempotency guard and the dashboard both need.
- **Event log (append-only) instead of mutable row**: rejected for v1 — introduces projection complexity for no current ask. Can be layered later if audit becomes a requirement.

## 3. Label-mutex mechanism

**Decision**: Implemented in `src/workflows/label-mutex.ts`. On every `issues.labeled` / `pull_request.labeled` event whose added label matches `^bot:[a-z]+$`, the handler:

1. Lists current labels via `octokit.rest.issues.listLabelsOnIssue`.
2. For each existing label matching `^bot:[a-z]+$` **other than** the just-applied one, issues `octokit.rest.issues.removeLabel`.
3. Tags each removal with a structured log (`{ removed: "bot:plan", kept: "bot:ship", reason: "bot-label-mutex" }`).
4. Proceeds to dispatch after the removals complete.

**Rationale**:

- GitHub's webhook delivers one `labeled` event per label addition, so we observe exactly the moment of transition — no polling.
- Removing via REST fires additional `unlabeled` events, which the `issues.ts` handler ignores (they are informational only; no dispatch decision is derived from label removal). This keeps the guard idempotent.
- Keeps FR-014 a single localised concern rather than a rule scattered across every workflow handler.

**Alternatives considered**:

- **Reject the new label and demand the maintainer remove the old one first**: rejected — friction for no benefit; the spec explicitly says "newest applied wins".
- **Add a GitHub branch-protection-style API guard**: not available — GitHub has no native "one label from a set" constraint.
- **Store the mutex in the DB instead of on the label itself**: rejected — the label is the UI surface the maintainer interacts with; a DB-only guard would leave stale labels visible, confusing maintainers.

## 4. Intent classifier: reuse `src/ai/llm-client.ts`

**Decision**: `src/workflows/intent-classifier.ts` wraps `src/ai/llm-client.ts` (existing single-turn adaptor) with a classify prompt that returns a JSON object `{ workflow: "triage"|"plan"|"implement"|"review"|"ship"|"unsupported"|"clarify", confidence: number, rationale: string }`. Threshold for auto-dispatch: `confidence >= 0.75`. Below threshold → post clarifying question (FR-009). `unsupported` → refuse politely (FR-010).

**Rationale**:

- Constitution v1.2.1 explicitly permits this: single-turn, no tool loop, guarded by config schema — exact fit for the AI carve-out.
- The existing `src/orchestrator/triage.ts` already uses this pattern for the dispatch-target classifier; we reuse the circuit-breaker, latency, and cost-budget guards already wired there. No new Zod config envelope required beyond an additional `INTENT_CONFIDENCE_THRESHOLD` optional env var (default 0.75).
- Threshold 0.75 chosen to bias toward asking one clarifying question over silently guessing wrong. SC-005 target is 90% correct/refuse/clarify on a labelled set — the threshold will be tuned against the eval set before GA.

**Alternatives considered**:

- **Keyword matching over comment body**: rejected — brittle for "can you ship this?" vs "we already shipped this". Fails SC-005 on any real maintainer prose.
- **Spin up a separate Claude Agent SDK session for intent**: rejected — overkill (multi-turn loop for a one-shot classification) and violates the constitution carve-out scope.

## 5. Queue-backed hand-off: reuse Valkey job queue verbatim

**Decision**: Workflow runs are queued via the existing `src/orchestrator/job-queue.ts`. Each job payload carries `{ workflowRunId, workflowName, target, parentRunId?, parentStepIndex? }`. On step completion inside the daemon (`src/daemon/main.ts`), a post-handler hook calls `src/workflows/orchestrator.ts#onStepComplete(runId)`, which reads the parent via `parent_run_id`, finds the next name in `steps[parentStepIndex + 1]`, creates a child `workflow_runs` row, and enqueues a fresh job. No handler knows or cares about composition.

**Rationale**:

- Keeps the hand-off logic in one place (`orchestrator.ts`). Atomic handlers stay atomic — they can be invoked directly by label or indirectly as a step of `ship` with no code change.
- Reuses the existing queue, daemon claim, and capability-matching code. Zero new infrastructure.
- Satisfies FR-028 literally: "hand-off MUST happen via queue enqueue only — no coordinator, no polling".

**Alternatives considered**:

- **In-memory orchestrator that awaits each step in a single long-running job**: rejected — violates FR-027 (step must be a separately enqueued job) and breaks the 10-s webhook SLA if a retry lands mid-ship.
- **Durable workflow engine (Temporal, Inngest)**: rejected — adds a dependency the spec does not justify and ties the project to an external control plane.

## 6. Handler implementations: derivation strategy

**Decision**:

- `triage` — reuses `src/orchestrator/triage.ts` classifier (single-turn via `src/ai/llm-client.ts`) applied to the issue body instead of the webhook payload. Writes verdict into `workflow_runs.state.verdict` and the tracking comment.
- `plan` — multi-turn Claude Agent SDK session with the existing MCP server set, reading the issue body + prior triage verdict, emitting a structured task-decomposition markdown written to `state.plan` and the tracking comment.
- `implement` — reuses `src/core/pipeline.ts` unchanged. The handler sets the SDK prompt context, lets the existing checkout + agent execution + tracking-comment flow run, and records the resulting PR number in `state.pr_number`.
- `review` — reuses the `pr-auto` skill's contract (CI watch + review-comment validation loop) through a dedicated handler. Stop bounds verbatim from FR-021 (3 CI-fix attempts, 15-min reviewer patience).
- `ship` — thin handler: validates `steps` from registry, creates the parent row, enqueues only the first step. All further orchestration goes through `orchestrator.ts#onStepComplete`.

**Rationale**: Maximises reuse of the existing pipeline, agent, and pr-auto scaffolding. The only net-new AI-facing prose is the `plan` prompt; everything else is wiring and state.

**Alternatives considered**:

- **Write a dedicated pipeline per workflow**: rejected — violates the spec's Assumptions section ("each of the five workflows is a pipeline variant, not a replacement architecture").
- **Implement `review` by shelling out to the `pr-auto` skill**: rejected — the skill is a human-in-the-loop tool in `~/.claude/skills/`; the bot must have its own in-process implementation so it runs inside the daemon without requiring the Claude CLI to be installed.

## 7. Tracking-comment mirroring strategy

**Decision**: `src/workflows/tracking-mirror.ts` exposes a single `setState(runId, state, humanMessage)` function that (a) writes the state column in `workflow_runs`, (b) renders a templated comment body from the row, and (c) updates the tracking comment via the existing `src/core/tracking-comment.ts` helpers, **inside the same transaction where possible**. Both steps happen before the handler returns control to the daemon loop.

**Rationale**: Satisfies FR-026 literally — authoritative state change and mirror update happen in the same unit of work. If the GitHub API call fails, the daemon retries the comment update from the row (reconciliation path), but the row is already correct.

**Alternatives considered**:

- **Write row, enqueue a separate "update tracking comment" job**: rejected — FR-026 demands same-unit-of-work consistency; splitting it creates windows where DB and GitHub diverge.
- **Render comment body from the registry + state in real time on every read**: rejected — the tracking comment is a persisted GitHub object; the mirror must be a snapshot.
