-- Migration 009: extend workflow_runs.status with the 'incomplete' terminal
-- state introduced for issue #93 (resolve handler-side CI re-check).
--
-- 'incomplete' means "agent ran without a pipeline error, but a handler-side
-- post-execution gate found surviving failures" — typically the resolve
-- handler when CI is still red after FIX_ATTEMPTS_CAP=3 fix attempts. It is
-- distinct from 'failed' (true pipeline error) so downstream surfaces — and
-- the orchestrator cascade — can tell a clean-run-but-blocked outcome from a
-- pipeline error.
--
-- Postgres requires CHECK constraints to be dropped and recreated to alter
-- their predicate, so we name the original constraint via the implicit
-- table-name pattern Postgres assigns and rebuild it with the new value.

ALTER TABLE workflow_runs
    DROP CONSTRAINT IF EXISTS workflow_runs_status_check;

ALTER TABLE workflow_runs
    ADD CONSTRAINT workflow_runs_status_check
        CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'incomplete'));
