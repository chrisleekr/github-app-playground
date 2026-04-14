-- 002_repo_knowledge: Unified persistent memory for repo knowledge
--
-- Single table for all repo-scoped knowledge: environment variables, setup notes,
-- architecture learnings, conventions, gotchas. Daemons are stateless — the
-- orchestrator queries this table and ships relevant entries in job:payload.
--
-- Memory eviction: LRU with pinned override.
--   - Pinned entries always included regardless of age.
--   - Non-pinned: top 5 by GREATEST(updated_at, last_read_at) DESC.
--   - last_read_at bumped on every dispatch to keep active memories alive.
--
-- Categories:
--   env_var       — "KEY=value" pairs written to .env (excluded from prompt)
--   setup         — build/test/install commands
--   architecture  — code structure, key abstractions
--   conventions   — coding style, patterns
--   env           — environment requirements (what's needed, not values)
--   gotchas       — common pitfalls, known issues

CREATE TABLE repo_memory (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_owner   TEXT NOT NULL,
  repo_name    TEXT NOT NULL,
  category     TEXT NOT NULL,
  content      TEXT NOT NULL,
  pinned       BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_repo_memory_repo ON repo_memory (repo_owner, repo_name);
CREATE INDEX idx_repo_memory_category ON repo_memory (repo_owner, repo_name, category);

-- Prevent duplicate env_var keys per repo.
-- split_part extracts the key portion from "KEY=value" content.
CREATE UNIQUE INDEX idx_repo_memory_env_unique
  ON repo_memory (repo_owner, repo_name, split_part(content, '=', 1))
  WHERE category = 'env_var';
