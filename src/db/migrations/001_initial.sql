-- 001_initial: Core tables for daemon orchestration platform
--
-- Tables:
--   executions  — tracks every agent execution (inline, shared-runner, ephemeral-job)
--   daemons     — registry of connected daemon instances and their capabilities
--
-- Note: gen_random_uuid() is built-in since Postgres 13 — no uuid-ossp needed.
-- pgvector extension deferred to the migration that first adds vector columns.

CREATE TABLE executions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id     TEXT UNIQUE NOT NULL,
  repo_owner      TEXT NOT NULL,
  repo_name       TEXT NOT NULL,
  entity_number   INTEGER NOT NULL,
  entity_type     TEXT NOT NULL,
  event_name      TEXT NOT NULL,
  trigger_username TEXT NOT NULL,
  triage_model    TEXT,
  triage_result   JSONB,
  execution_model TEXT,
  daemon_id       TEXT,
  dispatch_mode   TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued',
  cost_usd        NUMERIC(10,6),
  duration_ms     INTEGER,
  num_turns       INTEGER,
  context_json    JSONB,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ
);

CREATE TABLE daemons (
  id              TEXT PRIMARY KEY,
  hostname        TEXT NOT NULL,
  platform        TEXT NOT NULL,
  os_version      TEXT NOT NULL,
  capabilities    JSONB NOT NULL,
  resources       JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for common query patterns.
-- Note: delivery_id already has a unique index from the UNIQUE constraint.
CREATE INDEX idx_executions_status ON executions (status);
CREATE INDEX idx_executions_created_at ON executions (created_at);
CREATE INDEX idx_daemons_status ON daemons (status);
