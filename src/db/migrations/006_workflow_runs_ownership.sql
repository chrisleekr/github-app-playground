-- Migration 006: workflow_runs ownership for heartbeat-based liveness reaping.
--
-- Replaces the time-threshold daemon reaper with a process-liveness reaper
-- that flips abandoned in-flight rows to 'failed' the moment the owning
-- orchestrator or daemon stops heartbeating in Valkey.
--
-- Reaper liveness oracle:
--   owner_kind = 'orchestrator' -> Valkey key `orchestrator:{owner_id}:alive`
--   owner_kind = 'daemon'       -> Valkey key `daemon:{owner_id}`
--
-- Pre-existing rows have NULL owner_kind/owner_id and are deliberately
-- ignored by the reaper (no NOT NULL backfill so the migration stays
-- non-destructive on running fleets).

ALTER TABLE workflow_runs
    ADD COLUMN owner_kind TEXT NULL CHECK (owner_kind IN ('orchestrator', 'daemon')),
    ADD COLUMN owner_id   TEXT NULL;

-- Reaper hot path: scan only in-flight rows that have an owner. The partial
-- predicate keeps the index tiny and the planner happy on a table that will
-- otherwise be dominated by terminal rows.
CREATE INDEX idx_workflow_runs_owner_inflight
    ON workflow_runs (owner_kind, owner_id)
    WHERE status IN ('queued', 'running') AND owner_kind IS NOT NULL;
