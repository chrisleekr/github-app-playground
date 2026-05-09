-- Migration 011: comment_cache + target_cache — local conversation
-- cache for the `chat-thread` scoped intent. Read by
-- src/db/queries/conversation-store.ts; written through by webhook
-- handlers on every issue_comment / pull_request_review_comment /
-- issues / pull_request action.
--
-- Why a cache: the chat-thread executor reads the full conversation
-- history on every turn so the LLM sees the user's earlier asks +
-- prior bot replies + any other commenters. Without a cache, every
-- turn fetches via Octokit (paginated listComments + listReviewComments).
-- Hot-thread conversations would burn rate-limit budget on context
-- the bot has already seen via the same webhook deliveries.
--
-- The cache is a write-through projection of GitHub state — GitHub
-- remains the source of truth. The conversation-store invalidates on
-- `edited` (UPDATE body, updated_at = payload.comment.updated_at —
-- GitHub's clock, not ours, to preserve correct ordering) and
-- soft-deletes on `deleted` (deleted_at = now()).

-- ─── comment_cache ────────────────────────────────────────────────
CREATE TABLE comment_cache (
    owner               TEXT NOT NULL,
    repo                TEXT NOT NULL,
    target_type         TEXT NOT NULL CHECK (target_type IN ('issue', 'pr')),
    target_number       INT NOT NULL CHECK (target_number > 0),

    -- The REST comment id. Unique per (owner, repo) — comment ids are
    -- not globally unique across GitHub but they are unique within a
    -- repository.
    comment_id          BIGINT NOT NULL,

    -- Surface discriminator: 'issue-comment' or 'review-comment'. Top-
    -- level PR conversation lives on 'issue-comment' (GitHub conflates
    -- issue and PR conversation comments at the API level).
    surface             TEXT NOT NULL CHECK (surface IN ('issue-comment', 'review-comment')),

    -- For review-comment: the parent comment id when this is a reply.
    -- NULL for top-level review comments and all issue comments.
    in_reply_to_id      BIGINT NULL,

    author_login        TEXT NOT NULL,
    -- 'User' | 'Bot' | 'Mannequin'. Webhook payload's
    -- comment.user.type. The bot self-trigger guard is enforced at
    -- the webhook layer, not here — we cache bot replies too because
    -- the conversation history includes them.
    author_type         TEXT NOT NULL,

    body                TEXT NOT NULL,

    -- review-comment only; NULL for issue-comment.
    path                TEXT NULL,
    line                INT NULL,
    diff_hunk           TEXT NULL,

    -- GitHub timestamps (NOT wall-clock). Edits use payload.comment.updated_at
    -- so two edits arriving out-of-order resolve correctly to the last
    -- GitHub-side edit.
    created_at          TIMESTAMPTZ NOT NULL,
    updated_at          TIMESTAMPTZ NOT NULL,

    -- Soft delete (set on `deleted` action). Read path filters these.
    deleted_at          TIMESTAMPTZ NULL,

    -- Wall-clock timestamp of last cache-write — used for stale-cache
    -- safety. Distinct from `updated_at` (GitHub's edit time).
    fetched_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (owner, repo, comment_id)
);

-- Lookup all comments on a target ordered by created_at — the read
-- pattern the conversation-store uses to assemble conversation history.
CREATE INDEX idx_comment_cache_target_chrono
    ON comment_cache (owner, repo, target_type, target_number, created_at);

-- Lookup all replies to a specific review-comment thread.
CREATE INDEX idx_comment_cache_thread
    ON comment_cache (owner, repo, in_reply_to_id)
    WHERE in_reply_to_id IS NOT NULL;

-- ─── target_cache ─────────────────────────────────────────────────
-- The issue/PR body itself. Separate table because it has different
-- semantics (one row per issue/PR, no reply structure, hosts metadata
-- like state and base/head SHA for PR-state-aware routing).
CREATE TABLE target_cache (
    owner           TEXT NOT NULL,
    repo            TEXT NOT NULL,
    target_type     TEXT NOT NULL CHECK (target_type IN ('issue', 'pr')),
    target_number   INT NOT NULL CHECK (target_number > 0),

    title           TEXT NOT NULL,
    body            TEXT NOT NULL,
    state           TEXT NOT NULL,  -- 'open' | 'closed' | 'merged' (PR)
    author_login    TEXT NOT NULL,

    -- PR-only metadata; NULL for issues. Used by the chat-thread
    -- executor's <pr_state> block to give the LLM PR context like
    -- base/head, draft status.
    is_draft        BOOLEAN NULL,
    base_ref        TEXT NULL,
    head_ref        TEXT NULL,

    created_at      TIMESTAMPTZ NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL,
    fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (owner, repo, target_type, target_number)
);

-- Touch fetched_at on cache writes (writes go through UPSERT in
-- conversation-store, which sets fetched_at explicitly — no trigger
-- needed here).
