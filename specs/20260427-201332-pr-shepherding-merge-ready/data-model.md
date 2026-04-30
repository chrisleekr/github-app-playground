# Phase 1 Data Model: PR Shepherding to Merge-Ready State

**Date**: 2026-04-27
**Migration**: `src/db/migrations/008_ship_intents.sql` (new — adds 4 tables to existing schema; no modifications to migrations 001–007).

This document models the durable state required by the spec. All tables live in the existing PostgreSQL 17 instance accessed via `Bun.sql`.

---

## Entity-Relationship Diagram

```mermaid
erDiagram
    ship_intents ||--o{ ship_iterations : "has many"
    ship_intents ||--o| ship_continuations : "has at most one"
    ship_intents ||--o{ ship_fix_attempts : "has many"

    ship_intents {
      uuid id PK
      bigint installation_id
      text owner
      text repo
      int pr_number
      text target_base_sha
      text target_head_sha
      text status
      timestamptz deadline_at
      numeric spent_usd
      text created_by_user
      bigint tracking_comment_id
      text tracking_comment_marker
      text terminal_blocker_category
      timestamptz created_at
      timestamptz updated_at
      timestamptz terminated_at
    }

    ship_iterations {
      uuid id PK
      uuid intent_id FK
      int iteration_n
      text kind
      timestamptz started_at
      timestamptz finished_at
      jsonb verdict_json
      text non_readiness_reason
      numeric cost_usd
      uuid runs_store_id
    }

    ship_continuations {
      uuid intent_id PK_FK
      text[] wait_for
      timestamptz wake_at
      jsonb state_blob
      int state_version
      timestamptz updated_at
    }

    ship_fix_attempts {
      uuid intent_id FK
      text signature
      int tier
      int attempts
      timestamptz first_seen_at
      timestamptz last_seen_at
    }
```

---

## Table 1: `ship_intents`

The session ledger. One row per shepherding session. Lifetime: created on `bot:ship` trigger, updated on phase transitions, terminated to a finite state.

| Column                      | Type            | Constraint                      | Notes                                                                                                                                                                                             |
| --------------------------- | --------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                        | `uuid`          | PK, default `gen_random_uuid()` | Session id; appears in tracking-comment marker.                                                                                                                                                   |
| `installation_id`           | `bigint`        | NOT NULL                        | GitHub App installation.                                                                                                                                                                          |
| `owner`                     | `text`          | NOT NULL                        | Repo owner.                                                                                                                                                                                       |
| `repo`                      | `text`          | NOT NULL                        | Repo name.                                                                                                                                                                                        |
| `pr_number`                 | `int`           | NOT NULL                        | PR number.                                                                                                                                                                                        |
| `target_base_sha`           | `text`          | NOT NULL                        | Base ref SHA captured at intent creation. Updated on cascade-retarget per Q2 (round 1).                                                                                                           |
| `target_head_sha`           | `text`          | NOT NULL                        | Head ref SHA at intent creation. Updated as bot/human pushes occur.                                                                                                                               |
| `status`                    | `text`          | NOT NULL                        | One of `SessionStatus` = `SessionTerminalState` ∪ `{'active', 'paused'}`. `active` and `paused` are non-terminal (FR-011 pause/resume cycle); the rest are terminal. CHECK constraint enumerates. |
| `deadline_at`               | `timestamptz`   | NOT NULL                        | Wall-clock cap (FR-012a). Default = `created_at + MAX_WALL_CLOCK_PER_SHIP_RUN`.                                                                                                                   |
| `spent_usd`                 | `numeric(10,4)` | NOT NULL DEFAULT 0              | Running sum of `ship_iterations.cost_usd`. Observability only (FR-012a, SC-007).                                                                                                                  |
| `created_by_user`           | `text`          | NOT NULL                        | Audit: who triggered. Either a GitHub login or a composite-workflow id.                                                                                                                           |
| `tracking_comment_id`       | `bigint`        | NULL                            | Cached id of the canonical tracking comment (FR-006). NULL until first comment posted.                                                                                                            |
| `tracking_comment_marker`   | `text`          | NOT NULL                        | Marker substring `<!-- ship-intent:{id} -->` for restart-safe comment lookup (R10).                                                                                                               |
| `terminal_blocker_category` | `text`          | NULL                            | `BlockerCategory` value when terminated requiring human follow-up; NULL otherwise. CHECK constraint enumerates.                                                                                   |
| `created_at`                | `timestamptz`   | NOT NULL DEFAULT `now()`        |                                                                                                                                                                                                   |
| `updated_at`                | `timestamptz`   | NOT NULL DEFAULT `now()`        | Bumped on every state transition via app-side update.                                                                                                                                             |
| `terminated_at`             | `timestamptz`   | NULL                            | Set when `status` transitions to a terminal value.                                                                                                                                                |

**Constraints**:

- `CHECK (status IN ('active', 'paused', 'merged_externally', 'ready_awaiting_human_merge', 'deadline_exceeded', 'human_took_over', 'aborted_by_user', 'pr_closed'))`
- `CHECK (terminal_blocker_category IS NULL OR terminal_blocker_category IN ('design-discussion-needed', 'manual-push-detected', 'iteration-cap', 'flake-cap', 'merge-conflict-needs-human', 'permission-denied', 'stopped-by-user', 'unrecoverable-error'))`
- `CHECK ((status IN ('active', 'paused')) = (terminated_at IS NULL))` — non-terminal status iff not terminated. `active` and `paused` are both in-flight states; either NULLifies `terminated_at`.
- **Partial unique index**: `CREATE UNIQUE INDEX ship_intents_one_active_per_pr ON ship_intents (owner, repo, pr_number) WHERE status IN ('active', 'paused');` — enforces FR-007a (one in-flight session per PR; index name retained for migration history continuity even though `paused` is now also covered).

**Indexes**:

- `idx_ship_intents_active` on `(installation_id, status)` WHERE `status IN ('active', 'paused')` — supports reactor lookup by `(installation_id, owner, repo, pr_number)`. Covers both in-flight statuses because terminal external events (PR close/merge, foreign push, bot:abort-ship) MUST still terminate paused intents (FR-010 + state machine above); only the cancellation flag silences mid-iteration mutations during pause, not the reactor's terminal-transition path. Index name retained for migration history.
- `idx_ship_intents_pr` on `(installation_id, owner, repo, pr_number, created_at DESC)` — supports "list recent sessions for this PR" operator queries.

**State transitions**:

```text
[create]   →   active
active     ↔   paused                       (FR-011: bot:stop pauses → active; bot:resume from paused → active. Reversible any number of times within the wall-clock cap.)
active     →   ready_awaiting_human_merge   (probe verdict ready, terminal action complete)
active     →   merged_externally            (PR merged via webhook pull_request.closed merged=true)
active     →   pr_closed                    (PR closed without merge)
active     →   deadline_exceeded            (now() > deadline_at)
active     →   human_took_over              (FR-010: third-party push detected)
active     →   aborted_by_user              (bot:abort-ship terminal action)
paused     →   merged_externally            (PR merged externally while paused)
paused     →   pr_closed                    (PR closed externally while paused)
paused     →   deadline_exceeded            (deadline fires while paused; pause does not extend the cap)
paused     →   human_took_over              (FR-010: third-party push detected during pause)
paused     →   aborted_by_user              (bot:abort-ship terminal action while paused)
```

No transitions out of any terminal state (terminal is absorbing). A new `bot:ship` invocation creates a new row, never reuses an existing id.

---

## Table 2: `ship_iterations`

Audit trail. One row per session iteration. Lifetime: insert-only.

| Column                 | Type            | Constraint                                         | Notes                                                                                                 |
| ---------------------- | --------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `id`                   | `uuid`          | PK, default `gen_random_uuid()`                    |                                                                                                       |
| `intent_id`            | `uuid`          | NOT NULL FK → `ship_intents(id)` ON DELETE CASCADE |                                                                                                       |
| `iteration_n`          | `int`           | NOT NULL                                           | 1-based per intent. UNIQUE `(intent_id, iteration_n)`.                                                |
| `kind`                 | `text`          | NOT NULL                                           | One of `probe`, `resolve`, `review`, `branch-refresh`. CHECK enumerates.                              |
| `started_at`           | `timestamptz`   | NOT NULL DEFAULT `now()`                           |                                                                                                       |
| `finished_at`          | `timestamptz`   | NULL                                               | NULL while in-progress; set on completion.                                                            |
| `verdict_json`         | `jsonb`         | NULL                                               | For `probe` kind: full snapshot per FR-024 (R9). NULL for non-probe kinds.                            |
| `non_readiness_reason` | `text`          | NULL                                               | For `probe` kind: NULL if `ready`, else the `NonReadinessReason` value. CHECK enumerates if not NULL. |
| `cost_usd`             | `numeric(10,4)` | NOT NULL DEFAULT 0                                 | For agent-invoking kinds: per-invocation cost. 0 for `probe` (no agent).                              |
| `runs_store_id`        | `uuid`          | NULL                                               | FK to existing `runs-store` row for resolve/review/branch-refresh; NULL for `probe`.                  |

**Constraints**:

- `CHECK (kind IN ('probe', 'resolve', 'review', 'branch-refresh'))`
- `CHECK (non_readiness_reason IS NULL OR non_readiness_reason IN ('failing_checks', 'open_threads', 'changes_requested', 'behind_base', 'mergeable_pending', 'pending_checks', 'human_took_over', 'review_barrier_deferred'))`
- `CHECK ((kind = 'probe') OR (verdict_json IS NULL AND non_readiness_reason IS NULL))` — verdict columns only meaningful for probe rows.
- `UNIQUE (intent_id, iteration_n)`

**Indexes**:

- `idx_ship_iterations_intent` on `(intent_id, iteration_n DESC)` — supports "show me the last N iterations" operator queries.
- `idx_ship_iterations_probe_verdict` on `(intent_id, kind, finished_at DESC)` WHERE `kind = 'probe'` — supports the future reconciler scan (R9).

---

## Table 3: `ship_continuations`

Mutable per-intent continuation state. Lifetime: created on first yield, updated on each yield, deleted on terminal transition.

| Column          | Type          | Constraint                                    | Notes                                                                                                        |
| --------------- | ------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `intent_id`     | `uuid`        | PK, FK → `ship_intents(id)` ON DELETE CASCADE | One continuation per intent (R7).                                                                            |
| `wait_for`      | `text[]`      | NOT NULL                                      | Subset of `{'ci', 'coderabbit', 'review', 'mergeable', 'rebase'}`. What signals could trigger an early-wake. |
| `wake_at`       | `timestamptz` | NOT NULL                                      | Scheduled tickle wake time (R1).                                                                             |
| `state_blob`    | `jsonb`       | NOT NULL                                      | StateBlobV1 shape (R5); validated by Zod on read.                                                            |
| `state_version` | `int`         | NOT NULL                                      | Mirror of `state_blob.v` for SQL-side queryability (R5).                                                     |
| `updated_at`    | `timestamptz` | NOT NULL DEFAULT `now()`                      | Bumped on every persist.                                                                                     |

**Constraints**:

- `CHECK (state_version >= 1)`

**Indexes**:

- `idx_ship_continuations_wake` on `(wake_at)` — supports the cron tickle's `WHERE wake_at <= now()` scan in DB form (Valkey sorted set is the primary; Postgres is the durable mirror per restart-safety).

**Valkey mirror**: `ZADD ship:tickle <wake_at_ms> <intent_id>` keeps a duplicate of `wake_at` in Valkey for fast scans (R1). On boot, the scheduler reconciles by `SELECT intent_id, wake_at FROM ship_continuations WHERE wake_at <= now() + interval '5 minutes'` and seeds the sorted set. Postgres is the source of truth; Valkey is the cache.

---

## Table 4: `ship_fix_attempts`

Per-`(intent, signature)` retry ledger. Lifetime: insert/upsert as fix attempts occur.

| Column          | Type          | Constraint                                         | Notes                                                   |
| --------------- | ------------- | -------------------------------------------------- | ------------------------------------------------------- |
| `intent_id`     | `uuid`        | NOT NULL FK → `ship_intents(id)` ON DELETE CASCADE |                                                         |
| `signature`     | `text`        | NOT NULL                                           | Output of `deriveSignature` (R4).                       |
| `tier`          | `int`         | NOT NULL                                           | 1 or 2 (R4 tier discriminator). CHECK `tier IN (1, 2)`. |
| `attempts`      | `int`         | NOT NULL DEFAULT 0                                 | Incremented on each new attempt against this signature. |
| `first_seen_at` | `timestamptz` | NOT NULL DEFAULT `now()`                           | When this signature first appeared in this session.     |
| `last_seen_at`  | `timestamptz` | NOT NULL DEFAULT `now()`                           | Bumped on each attempt.                                 |
|                 |               | PRIMARY KEY `(intent_id, signature)`               |                                                         |

**Indexes**:

- Primary key already covers the lookup `(intent_id, signature) → attempts`.
- `idx_ship_fix_attempts_capped` on `(intent_id)` WHERE `attempts >= 3` — supports "is this intent stuck on flake-cap?" queries cheaply.

---

## Migration script (`008_ship_intents.sql`) — outline

The actual migration file is delivered in P2 implementation (per phased delivery in plan.md). Outline of contents:

```sql
-- 008_ship_intents.sql
-- Adds shepherding-session state for the bot:ship workflow.
-- See specs/20260427-201332-pr-shepherding-merge-ready/

CREATE TABLE ship_intents (...);
CREATE UNIQUE INDEX ship_intents_one_active_per_pr ON ship_intents (...) WHERE status IN ('active', 'paused');
CREATE INDEX idx_ship_intents_active ON ship_intents (...) WHERE status IN ('active', 'paused');
CREATE INDEX idx_ship_intents_pr ON ship_intents (...);

CREATE TABLE ship_iterations (...);
CREATE UNIQUE INDEX uq_ship_iterations_intent_n ON ship_iterations (intent_id, iteration_n);
CREATE INDEX idx_ship_iterations_intent ON ship_iterations (...);
CREATE INDEX idx_ship_iterations_probe_verdict ON ship_iterations (...) WHERE kind = 'probe';

CREATE TABLE ship_continuations (...);
CREATE INDEX idx_ship_continuations_wake ON ship_continuations (wake_at);

CREATE TABLE ship_fix_attempts (...);
CREATE INDEX idx_ship_fix_attempts_capped ON ship_fix_attempts (intent_id) WHERE attempts >= 3;
```

All four tables are CASCADE on intent deletion to keep the data model self-cleaning when an intent is hard-deleted (admin operation; not part of normal lifecycle).

---

## Application-layer types (TypeScript)

Defined in `src/shared/ship-types.ts` (new) and `src/workflows/ship/verdict.ts` (new).

```typescript
// src/shared/ship-types.ts
export const SESSION_TERMINAL_STATES = [
  "merged_externally",
  "ready_awaiting_human_merge",
  "deadline_exceeded",
  "human_took_over",
  "aborted_by_user",
  "pr_closed",
] as const;
export type SessionTerminalState = (typeof SESSION_TERMINAL_STATES)[number];

export const BLOCKER_CATEGORIES = [
  "design-discussion-needed",
  "manual-push-detected",
  "iteration-cap",
  "flake-cap",
  "merge-conflict-needs-human",
  "permission-denied",
  "stopped-by-user",
  "unrecoverable-error",
] as const;
export type BlockerCategory = (typeof BLOCKER_CATEGORIES)[number];

// src/workflows/ship/verdict.ts
export const NON_READINESS_REASONS = [
  "failing_checks",
  "open_threads",
  "changes_requested",
  "behind_base",
  "mergeable_pending",
  "pending_checks",
  "human_took_over",
  "review_barrier_deferred",
] as const;
export type NonReadinessReason = (typeof NON_READINESS_REASONS)[number];

export type MergeReadiness =
  | { ready: true; checked_at: string; head_sha: string }
  | {
      ready: false;
      reason: NonReadinessReason;
      detail: string;
      checked_at: string;
      head_sha: string;
    };
```

All three enumerations are SQL `CHECK` constraints AND TS literal-union types AND Zod enums (validated at every boundary).

---

## Validation rules sourced from spec FRs

| FR        | Validation                                                                                                                                          |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-007a   | Partial unique index on `ship_intents (owner, repo, pr_number) WHERE status IN ('active', 'paused')`.                                               |
| FR-024    | NOT NULL on `verdict_json` for `probe` kind enforced by application; CHECK constraint allows NULL because non-probe rows have no verdict.           |
| FR-013    | Application enforces `attempts < FIX_ATTEMPTS_PER_SIGNATURE_CAP` before invoking another fix.                                                       |
| FR-012a   | Wall-clock cap = `deadline_at`; cron tickle terminates intent when `now() > deadline_at`.                                                           |
| Q1 round1 | Single active per PR — partial unique index above.                                                                                                  |
| Q2 round1 | Cascade base ref → update `target_base_sha` in place, write a new `probe` iteration.                                                                |
| Q3 round1 | USD recorded in `spent_usd` and `ship_iterations.cost_usd`; never used as a termination condition.                                                  |
| Q4 round1 | Targeted re-run + flake annotation handled by `flake-tracker.ts`; flake state recorded in `state_blob.flake_history`.                               |
| Q5 round1 | Draft → ready flip happens in the terminal-action code path immediately before transitioning `ship_intents.status` to `ready_awaiting_human_merge`. |

## Scoped commands (FR-029..FR-035) — no schema change

The seven scoped commands defined in FR-029..FR-035 (`bot:fix-thread`, `bot:explain-thread`, `bot:summarize`, `bot:rebase`, `bot:investigate`, `bot:triage`, `bot:open-pr`) deliberately write **no rows** to any `ship_*` table:

- They do not create a `ship_intents` row — they are not sessions and do not consume the FR-007a one-active-per-PR slot.
- They do not append to `ship_iterations` — they have no iteration concept.
- They do not write `ship_continuations` — they hold no daemon slot beyond their own short execution.
- They do not write `ship_fix_attempts` — they have no signature-keyed retry ledger.

The only durable artefacts a scoped command produces are GitHub-side: a comment, a commit, a PR creation, or a label self-removal. This is intentional — adding tables for the scoped commands would replicate session-level bookkeeping that the one-shot lifecycle does not need.

Idempotency for read-only / advisory commands (`bot:summarize`, `bot:investigate`, `bot:triage`, `bot:open-pr`) is enforced via stable HTML-comment markers embedded in their output, distinct from the FR-006 shepherding tracking-comment marker:

| Command           | Marker                                                      | Scope                                          |
| ----------------- | ----------------------------------------------------------- | ---------------------------------------------- |
| `bot:summarize`   | `<!-- bot:summarize:{pr_number} -->`                        | one per PR                                     |
| `bot:investigate` | `<!-- bot:investigate:{issue_number} -->`                   | one per issue                                  |
| `bot:triage`      | `<!-- bot:triage:{issue_number} -->`                        | one per issue                                  |
| `bot:open-pr`     | `<!-- bot:open-pr:{pr_number} -->` left on the source issue | one per source issue (back-link to created PR) |

Re-triggering any of these commands updates the existing marked comment in place rather than posting a duplicate. The marker scheme is read by a GraphQL search of the target's comment list at the start of each invocation.

---

## NL classifier intent enum — widened in P8

The `intent` enum returned by the NL classifier (`src/workflows/ship/nl-classifier.ts`, T028b/T080) widens from 5 entries (`'ship' | 'stop' | 'resume' | 'abort' | 'none'`) to **12 entries** in P8:

```typescript
// post-P8
export type CommandIntent =
  | "ship"
  | "stop"
  | "resume"
  | "abort"
  | "fix-thread"
  | "explain-thread"
  | "summarize"
  | "rebase"
  | "investigate"
  | "triage"
  | "open-pr"
  | "none";
```

Per-event-surface eligibility is enforced inside the classifier — `intent: 'none'` MUST be returned when the source event surface does not match the intent's declared eligibility (per FR-029..FR-035 trigger-surface rules). The event-surface descriptor (`'pull_request_review_comment' | 'issue_comment_pr' | 'issue_comment_issue' | 'pull_request_label' | 'issues_label'`) is part of the classifier input prompt, never inferred by the classifier itself. The Zod schema for the classifier response is updated in lockstep.

---

## `bot:open-pr` meta-issue classifier (FR-035) — separate single-turn call

Distinct from the NL intent classifier above. `bot:open-pr` issues a **second** single-turn Bedrock call (after intent classification confirms `intent: 'open-pr'`) to determine whether the source issue is actionable:

```typescript
// src/workflows/ship/scoped/meta-issue-classifier.ts
export type IssueActionabilityVerdict = {
  actionable: boolean;
  kind: "bug" | "feature" | "tracking" | "meta" | "roadmap" | "discussion" | "unclear";
  reason: string; // one sentence; surfaced to maintainer in non-actionable replies
};
```

When `actionable === false`, the bot replies in the issue with the verdict + `reason` and exits without creating a branch. There is no `--force` override in v1 — the classifier's verdict is final. The classifier reuses `src/ai/llm-client.ts` and is mocked in tests per Constitution V.

End of data model.
