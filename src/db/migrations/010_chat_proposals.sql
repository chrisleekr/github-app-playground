-- Migration 010: chat_proposals — proposal state machine for the
-- `chat-thread` scoped intent (propose → confirm →
-- execute UX for freeform conversations on PRs and issues).
--
-- A row is inserted whenever the chat-thread executor emits
-- `mode: "propose-action"` or `mode: "propose-workflow"` and the bot
-- posts an unambiguous "react 👍 on this comment to confirm" reply.
-- The row holds the typed payload that will execute on approval; the
-- LLM never re-authors the payload at approval time, preserving the
-- "human consented to the exact thing in the proposal comment"
-- invariant.
--
-- Two approval paths flip status from 'awaiting' → 'approved':
--   1. Reaction-poll: src/orchestrator/proposal-poller.ts scans
--      awaiting rows on a 60–120s cadence (or piggybacks on the next
--      webhook in the same target) and lists reactions on
--      `proposal_comment_id`. Any +1 by a non-bot user wins.
--   2. Comment-classify: when a follow-up comment arrives in the same
--      thread, the chat-thread executor passes the pending proposal
--      to the classifier and emits `mode: "approve-pending"` or
--      `mode: "decline-pending"`.
--
-- Idempotency: the partial unique index `idx_chat_proposals_one_awaiting`
-- enforces "one awaiting proposal per (owner, repo, target_number,
-- thread_id)". Inserting a second awaiting proposal in the same scope
-- requires the executor to first transition the prior row to
-- 'superseded'.

CREATE TABLE chat_proposals (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    owner                   TEXT NOT NULL,
    repo                    TEXT NOT NULL,
    target_type             TEXT NOT NULL CHECK (target_type IN ('issue', 'pr')),
    target_number           INT NOT NULL CHECK (target_number > 0),

    -- NULL for issue/PR top-level proposals; the REST review-comment id
    -- (stringified) for review-thread proposals. Mirrors the
    -- `CanonicalCommand.thread_id` semantics in
    -- `src/shared/ship-types.ts` — the REST id, not the GraphQL node id.
    thread_id               TEXT NULL,

    -- The bot's own comment that says "react 👍 on this comment to
    -- confirm". The reaction-poller lists reactions on THIS id; any 👍
    -- on a different comment is intentionally ignored.
    proposal_comment_id     BIGINT NOT NULL,

    -- Discriminator + payload pair. `proposal_kind` is one of:
    --   action:create-issue
    --   action:resolve-thread
    --   action:add-label
    --   action:cross-link
    --   workflow:triage|plan|implement|review|resolve|ship
    -- The payload schema is enforced at the application layer
    -- (src/db/queries/proposals-store.ts) — Postgres only stores it.
    proposal_kind           TEXT NOT NULL,
    payload                 JSONB NOT NULL,

    -- The human who triggered the original ask. Used to gate
    -- approval-by-comment classification (any maintainer with PR
    -- access can confirm, but the original asker's intent is the
    -- primary signal).
    asker_login             TEXT NOT NULL,

    -- Set when status transitions to 'approved' / 'declined' /
    -- 'superseded' / 'expired'. NULL while 'awaiting'.
    approver_login          TEXT NULL,

    status                  TEXT NOT NULL CHECK (status IN (
        'awaiting',
        'approved',
        'executed',
        'declined',
        'expired',
        'superseded'
    )),

    -- 24h TTL by default (configurable via CHAT_THREAD_PROPOSAL_TTL_HOURS).
    -- Reactions arriving after this point are logged-but-ignored.
    expires_at              TIMESTAMPTZ NOT NULL,

    -- Per-thread cost cap accounting (CHAT_THREAD_MAX_COST_USD).
    -- Carried on the proposal row because the proposal's identity is
    -- the natural per-thread budget anchor — there is no separate
    -- thread-state table.
    cumulative_cost_usd     NUMERIC(10,4) NOT NULL DEFAULT 0,
    turn_count              INT NOT NULL DEFAULT 0 CHECK (turn_count >= 0),

    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One awaiting proposal per (owner, repo, target_number, thread_id).
-- Postgres treats NULLs as distinct in unique indexes, so issue/PR
-- top-level proposals (thread_id IS NULL) need the COALESCE workaround
-- to share the same uniqueness scope.
CREATE UNIQUE INDEX idx_chat_proposals_one_awaiting
    ON chat_proposals (owner, repo, target_number, COALESCE(thread_id, ''))
    WHERE status = 'awaiting';

-- Reactor-poll lookup: "find every pending proposal for this target".
CREATE INDEX idx_chat_proposals_pending_target
    ON chat_proposals (owner, repo, target_number)
    WHERE status = 'awaiting';

-- Expiry sweep: "find every awaiting proposal that has aged out".
CREATE INDEX idx_chat_proposals_expires_at
    ON chat_proposals (expires_at)
    WHERE status = 'awaiting';

-- Touch updated_at on any row change. Same trigger pattern as
-- workflow_runs (migration 005) and ship_intents (migration 008).
CREATE OR REPLACE FUNCTION chat_proposals_bump_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_chat_proposals_bump_updated_at
    BEFORE UPDATE ON chat_proposals
    FOR EACH ROW EXECUTE FUNCTION chat_proposals_bump_updated_at();
