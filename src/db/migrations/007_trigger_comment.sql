-- Migration 007: persist the user's trigger comment on workflow_runs and executions.
--
-- Required so the orphan/disconnect cleanup path (which has no live BotContext)
-- can update the right tracking comment and add a failure reaction (👀 → ❌)
-- when a daemon dies mid-job. Also lets every workflow stage update the same
-- trigger-comment reaction set throughout its lifecycle (eyes → rocket →
-- hooray → confused).
--
-- Both columns are NULL because label-triggered workflows (e.g. bot:ship via
-- issues.labeled) have no originating comment to react on. No backfill — the
-- reaction lifecycle only matters for jobs dispatched after this migration.

ALTER TABLE workflow_runs
    ADD COLUMN trigger_comment_id BIGINT NULL,
    ADD COLUMN trigger_event_type TEXT NULL
        CHECK (trigger_event_type IN ('issue_comment', 'pull_request_review_comment'));

ALTER TABLE executions
    ADD COLUMN trigger_comment_id BIGINT NULL,
    ADD COLUMN trigger_event_type TEXT NULL
        CHECK (trigger_event_type IN ('issue_comment', 'pull_request_review_comment'));
