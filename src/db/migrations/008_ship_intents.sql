-- Migration 008: PR shepherding to merge-ready (`bot:ship` workflow).
--
-- Adds the four tables that back `src/workflows/ship/*`:
--   ship_intents       — session ledger; one row per `bot:ship` session
--   ship_iterations    — insert-only audit trail; one row per probe/resolve/review/branch-refresh
--   ship_continuations — mutable per-intent yield state (StateBlobV1, R5)
--   ship_fix_attempts  — per-(intent, signature) retry ledger (FR-013, R4)
--
-- Constraints mirror the literal-union types in `src/shared/ship-types.ts`
-- (SessionStatus, BlockerCategory) and `src/workflows/ship/verdict.ts`
-- (NonReadinessReason). Both layers MUST be updated together — the
-- application Zod enum and the SQL CHECK enumeration are dual-validated
-- at every boundary per data-model.md §"Application-layer types".
--
-- Idempotency: this migration is wrapped in the runner's transaction
-- (src/db/migrate.ts) and recorded in `_migrations`; re-running is a
-- no-op. We use plain `CREATE TABLE` (not `IF NOT EXISTS`) to match the
-- 001/002/003/005 conventions and surface drift early.

CREATE TABLE ship_intents (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    installation_id             BIGINT NOT NULL,
    owner                       TEXT NOT NULL,
    repo                        TEXT NOT NULL,
    pr_number                   INT NOT NULL,
    target_base_sha             TEXT NOT NULL,
    target_head_sha             TEXT NOT NULL,
    status                      TEXT NOT NULL,
    deadline_at                 TIMESTAMPTZ NOT NULL,
    spent_usd                   NUMERIC(10,4) NOT NULL DEFAULT 0,
    created_by_user             TEXT NOT NULL,
    tracking_comment_id         BIGINT,
    tracking_comment_marker     TEXT NOT NULL,
    terminal_blocker_category   TEXT,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    terminated_at               TIMESTAMPTZ,
    -- SessionStatus enum: SessionTerminalState ∪ {'active', 'paused'}.
    -- 'active' and 'paused' are non-terminal (FR-011 pause/resume cycle).
    CONSTRAINT ship_intents_status_check CHECK (status IN (
        'active',
        'paused',
        'merged_externally',
        'ready_awaiting_human_merge',
        'deadline_exceeded',
        'human_took_over',
        'aborted_by_user',
        'pr_closed'
    )),
    -- BlockerCategory: NULL when the terminal state is self-explanatory
    -- (e.g. deadline_exceeded), or one of the enumerated categories.
    CONSTRAINT ship_intents_blocker_category_check CHECK (
        terminal_blocker_category IS NULL OR terminal_blocker_category IN (
            'design-discussion-needed',
            'manual-push-detected',
            'iteration-cap',
            'flake-cap',
            'merge-conflict-needs-human',
            'permission-denied',
            'stopped-by-user',
            'unrecoverable-error'
        )
    ),
    -- Non-terminal status iff not terminated. 'active' and 'paused' are
    -- both in-flight; either one NULLifies terminated_at.
    CONSTRAINT ship_intents_terminated_at_check CHECK (
        (status IN ('active', 'paused')) = (terminated_at IS NULL)
    )
);

-- FR-007a: at most one in-flight session per (owner, repo, pr_number).
-- Index name retained for migration history continuity even though
-- 'paused' is now also covered (per data-model.md §"Constraints").
CREATE UNIQUE INDEX ship_intents_one_active_per_pr
    ON ship_intents (owner, repo, pr_number)
    WHERE status IN ('active', 'paused');

-- Reactor lookup: covers both in-flight statuses because terminal external
-- events (PR close/merge, foreign push, bot:abort-ship) MUST still be able
-- to terminate paused intents (FR-010 + state machine).
CREATE INDEX idx_ship_intents_active
    ON ship_intents (installation_id, status)
    WHERE status IN ('active', 'paused');

-- "List recent sessions for this PR" operator queries.
CREATE INDEX idx_ship_intents_pr
    ON ship_intents (installation_id, owner, repo, pr_number, created_at DESC);

CREATE TABLE ship_iterations (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    intent_id               UUID NOT NULL REFERENCES ship_intents(id) ON DELETE CASCADE,
    iteration_n             INT NOT NULL,
    kind                    TEXT NOT NULL,
    started_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at             TIMESTAMPTZ,
    verdict_json            JSONB,
    non_readiness_reason    TEXT,
    cost_usd                NUMERIC(10,4) NOT NULL DEFAULT 0,
    runs_store_id           UUID,
    CONSTRAINT ship_iterations_kind_check CHECK (kind IN (
        'probe', 'resolve', 'review', 'branch-refresh'
    )),
    -- NonReadinessReason enum (mirrors src/workflows/ship/verdict.ts).
    CONSTRAINT ship_iterations_non_readiness_reason_check CHECK (
        non_readiness_reason IS NULL OR non_readiness_reason IN (
            'failing_checks',
            'open_threads',
            'changes_requested',
            'behind_base',
            'mergeable_pending',
            'pending_checks',
            'human_took_over'
        )
    ),
    -- Verdict columns are only meaningful for probe rows.
    CONSTRAINT ship_iterations_verdict_only_on_probe_check CHECK (
        kind = 'probe' OR (verdict_json IS NULL AND non_readiness_reason IS NULL)
    ),
    UNIQUE (intent_id, iteration_n)
);

CREATE INDEX idx_ship_iterations_intent
    ON ship_iterations (intent_id, iteration_n DESC);

CREATE INDEX idx_ship_iterations_probe_verdict
    ON ship_iterations (intent_id, kind, finished_at DESC)
    WHERE kind = 'probe';

CREATE TABLE ship_continuations (
    intent_id       UUID PRIMARY KEY REFERENCES ship_intents(id) ON DELETE CASCADE,
    wait_for        TEXT[] NOT NULL,
    wake_at         TIMESTAMPTZ NOT NULL,
    state_blob      JSONB NOT NULL,
    state_version   INT NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ship_continuations_state_version_check CHECK (state_version >= 1)
);

-- Cron tickle reconciliation scan (R1): also a Postgres-side
-- WHERE wake_at <= now() lookup if Valkey is unavailable.
CREATE INDEX idx_ship_continuations_wake
    ON ship_continuations (wake_at);

CREATE TABLE ship_fix_attempts (
    intent_id       UUID NOT NULL REFERENCES ship_intents(id) ON DELETE CASCADE,
    signature       TEXT NOT NULL,
    tier            INT NOT NULL,
    attempts        INT NOT NULL DEFAULT 0,
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (intent_id, signature),
    CONSTRAINT ship_fix_attempts_tier_check CHECK (tier IN (1, 2))
);
