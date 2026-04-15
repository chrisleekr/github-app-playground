-- 003_dispatch_decisions: Persistent dispatch + triage telemetry
--
-- Adds per-event dispatch-decision columns to `executions` and introduces
-- `triage_results` for the auto-mode probabilistic classifier. Schema
-- matches data-model.md §3 and §4 of the triage-dispatch-modes feature.
--
-- Design notes:
--   * dispatch_target / dispatch_reason are denormalised onto `executions`
--     so the FR-014 aggregate queries (events-per-target, triage rate,
--     avg-confidence-and-fallback, triage-spend) can group by target+date
--     without joining a multi-million-row table against triage_results.
--   * dispatch_mode (from migration 001) is kept for backward compat with
--     pre-feature rows; new code writes dispatch_target. A future migration
--     may consolidate.
--   * Defaults on the new executions columns ('inline' / 'static-default')
--     backfill existing rows so NOT NULL ALTERs succeed without a separate
--     UPDATE pass. These defaults correctly describe historical behaviour:
--     rows written before this migration used the inline pipeline with no
--     triage cascade.
--   * CHECK constraints mirror the DispatchTarget and DispatchReason enums
--     in src/shared/dispatch-types.ts (T007). Keep in sync on future edits.

ALTER TABLE executions
  ADD COLUMN dispatch_target TEXT NOT NULL DEFAULT 'inline'
    CHECK (dispatch_target IN ('inline', 'daemon', 'shared-runner', 'isolated-job')),
  ADD COLUMN dispatch_reason TEXT NOT NULL DEFAULT 'static-default'
    CHECK (dispatch_reason IN (
      'label',
      'keyword',
      'triage',
      'default-fallback',
      'triage-error-fallback',
      'static-default',
      'capacity-rejected',
      'infra-absent'
    )),
  ADD COLUMN triage_confidence NUMERIC(3,2) NULL
    CHECK (triage_confidence IS NULL OR (triage_confidence >= 0 AND triage_confidence <= 1)),
  ADD COLUMN triage_cost_usd   NUMERIC(10,6) NULL
    CHECK (triage_cost_usd IS NULL OR triage_cost_usd >= 0),
  ADD COLUMN triage_complexity TEXT NULL
    CHECK (triage_complexity IS NULL OR triage_complexity IN ('trivial', 'moderate', 'complex'));

CREATE INDEX idx_executions_dispatch_target_created_at
  ON executions (dispatch_target, created_at DESC);

CREATE TABLE triage_results (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id  TEXT UNIQUE NOT NULL,
  mode         TEXT NOT NULL
               CHECK (mode IN ('daemon', 'shared-runner', 'isolated-job')),
  confidence   NUMERIC(3,2) NOT NULL
               CHECK (confidence >= 0 AND confidence <= 1),
  complexity   TEXT NOT NULL
               CHECK (complexity IN ('trivial', 'moderate', 'complex')),
  rationale    TEXT NOT NULL
               CHECK (LENGTH(rationale) >= 1 AND LENGTH(rationale) <= 500),
  cost_usd     NUMERIC(10,6) NOT NULL CHECK (cost_usd >= 0),
  latency_ms   INTEGER NOT NULL CHECK (latency_ms >= 0),
  provider     TEXT NOT NULL
               CHECK (provider IN ('anthropic', 'bedrock')),
  model        TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_triage_results_created_at ON triage_results (created_at DESC);
