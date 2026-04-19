-- Migration 004: collapse dispatch targets to daemon-only
--
-- Post-refactor the webhook has a single execution protocol (daemon). K8s is an
-- auto-scaling mechanism for ephemeral daemons, not a distinct target. Targets
-- `inline`, `shared-runner`, and `isolated-job` are removed. Reasons are
-- replaced with the four values that describe routing outcomes in the new
-- world: `persistent-daemon`, `ephemeral-daemon-triage`,
-- `ephemeral-daemon-overflow`, `ephemeral-spawn-failed`.
--
-- Historical rows are rewritten so the CHECK constraints can be tightened
-- without orphaning audit history. Legacy rejection reasons (`capacity-rejected`,
-- `infra-absent`) map to `ephemeral-spawn-failed` — they were the prior
-- equivalents of a spawn refusal — so rejection telemetry survives.

BEGIN;

ALTER TABLE executions DROP CONSTRAINT IF EXISTS executions_dispatch_target_check;
ALTER TABLE executions DROP CONSTRAINT IF EXISTS executions_dispatch_reason_check;
ALTER TABLE executions DROP CONSTRAINT IF EXISTS executions_dispatch_mode_check;
ALTER TABLE triage_results DROP CONSTRAINT IF EXISTS triage_results_mode_check;

-- Mirror the open-ended guard used for executions.dispatch_reason below:
-- rewrite any row whose target/mode is not already 'daemon', regardless of
-- whether it comes from the documented legacy set. Without this, a stray
-- value from an operator backfill or an older-branch deploy would survive
-- the UPDATE and fail the CHECK (= 'daemon') added later in this file,
-- aborting the whole transaction.
UPDATE executions SET dispatch_target = 'daemon'
 WHERE dispatch_target IS DISTINCT FROM 'daemon';
UPDATE executions SET dispatch_mode = 'daemon'
 WHERE dispatch_mode IS DISTINCT FROM 'daemon';

-- Rewrite any reason not already in the post-collapse set. Keeping this
-- unconditional (rather than enumerating legacy values) defends against
-- rows written by an older migration, an operator backfill, or an app
-- version mid-deploy — any of which would otherwise fail the ADD
-- CONSTRAINT below and abort the whole transaction. Rejection-like
-- legacy reasons preserve their telemetry by mapping to
-- `ephemeral-spawn-failed`; everything else maps to the neutral
-- `persistent-daemon` bucket (historical jobs that did run).
UPDATE executions SET dispatch_reason = CASE
  WHEN dispatch_reason IN ('capacity-rejected', 'infra-absent') THEN 'ephemeral-spawn-failed'
  ELSE 'persistent-daemon'
END
 WHERE dispatch_reason NOT IN (
  'persistent-daemon',
  'ephemeral-daemon-triage',
  'ephemeral-daemon-overflow',
  'ephemeral-spawn-failed'
);

-- Mirror the open-ended guard used for executions.dispatch_reason above:
-- any row with a legacy/unknown mode must be rewritten, otherwise the
-- ADD CONSTRAINT triage_results_mode_check below would abort the whole
-- transaction on a single stray value.
UPDATE triage_results SET mode = 'daemon'
 WHERE mode IS DISTINCT FROM 'daemon';

-- Triage shape change: drop complexity (no longer produced), add heavy.
ALTER TABLE triage_results DROP COLUMN IF EXISTS complexity;
ALTER TABLE triage_results ADD COLUMN IF NOT EXISTS heavy BOOLEAN;

-- `executions.triage_complexity` was a denorm of triage_results.complexity.
-- No longer populated; drop to keep the schema truthful.
ALTER TABLE executions DROP COLUMN IF EXISTS triage_complexity;

ALTER TABLE executions
  ADD CONSTRAINT executions_dispatch_target_check CHECK (dispatch_target = 'daemon'),
  ADD CONSTRAINT executions_dispatch_mode_check CHECK (dispatch_mode = 'daemon'),
  ADD CONSTRAINT executions_dispatch_reason_check CHECK (
    dispatch_reason IN (
      'persistent-daemon',
      'ephemeral-daemon-triage',
      'ephemeral-daemon-overflow',
      'ephemeral-spawn-failed'
    )
  );
ALTER TABLE triage_results
  ADD CONSTRAINT triage_results_mode_check CHECK (mode = 'daemon');

COMMIT;
