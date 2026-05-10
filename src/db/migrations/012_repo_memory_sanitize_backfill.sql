-- 012_repo_memory_sanitize_backfill: re-sanitize legacy repo_memory rows
--
-- Closes the cross-session indirect-prompt-injection window described in
-- issue #112. Before this migration, save_repo_memory persisted free-form
-- attacker-controllable strings verbatim, and the orchestrator re-injected
-- them into every future agent prompt as trusted-looking data. Going forward
-- the MCP server and saveRepoLearnings sanitize on write; this migration
-- handles rows that were already poisoned.
--
-- Scope: non-env_var rows only. env_var entries are KEY=value with a
-- constrained shape; sanitizing them risks corrupting legitimate values
-- (e.g. URLs whose query strings include zero-width-adjacent text).
--
-- Coverage parity with src/utils/sanitize.ts sanitizeRepoMemoryContent:
--   1. Strip HTML comments (the most-cited write-side injection vector).
--   2. Strip BMP invisibles: zero-width, BOM, soft-hyphen, bidi controls,
--      line/paragraph separators (U+2028/U+2029).
--   3. Strip NUL bytes (DB / JSON desync).
--   4. Collapse CR/LF/U+2028/U+2029 runs to a single space (line-shape
--      break-out vector).
--   5. Redact every GitHub token shape that redactGitHubTokens covers:
--      ghp_ / gho_ / ghs_ / ghr_ / github_pat_.
--   6. Trim surrounding whitespace.
--
-- This SQL pass is intentionally narrower than the TypeScript helper in two
-- specific ways: (a) no markdown alt-text / link-title / hidden-attribute
-- strip, (b) no Unicode TAG block (U+E0000..U+E007F) strip — Postgres ARE
-- in 17 does not range over the supplementary plane in a single
-- bracket-expression. Both gaps are tolerated because all NEW writes go
-- through the helper, and pre-existing rows containing TAG-block payloads
-- are vanishingly rare. Document any new gap added here in test/security/
-- SCENARIOS.md Section K alongside the rest.
--
-- WHERE filter: intentionally none. repo_memory is small per-repo, the
-- regexp_replace chain is idempotent, and dropping the filter eliminates
-- the asymmetry where rows containing only TAG-block / control-char /
-- gho_/ghr_/github_pat_ payloads would slip past a probe-based predicate.
-- Re-running the migration is a no-op on already-clean content.

UPDATE repo_memory
SET content = btrim(
  regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(
                regexp_replace(
                  content,
                  '<!--.*?-->', '', 'g'
                ),
                E'[\\u200B-\\u200D\\uFEFF\\u00AD\\u2066-\\u2069\\u202A-\\u202E]', '', 'g'
              ),
              E'\\x00', '', 'g'
            ),
            E'[\\r\\n\\u2028\\u2029]+', ' ', 'g'
          ),
          'ghp_[A-Za-z0-9]{36}', '[REDACTED_GITHUB_TOKEN]', 'g'
        ),
        'gho_[A-Za-z0-9]{36}', '[REDACTED_GITHUB_TOKEN]', 'g'
      ),
      'ghs_[A-Za-z0-9]{36}', '[REDACTED_GITHUB_TOKEN]', 'g'
    ),
    'ghr_[A-Za-z0-9]{36}', '[REDACTED_GITHUB_TOKEN]', 'g'
  )
)
WHERE category != 'env_var';

-- Drop rows that collapsed to empty after sanitization (e.g. content was
-- entirely an HTML comment or invisibles). Empty memory rows have no value
-- and the write-side guard now skips them too. Pre-condition: prior writes
-- enforced `z.string().min(1)` at the MCP boundary, so an empty row here
-- implies sanitization collapse, not a legitimate empty row.
DELETE FROM repo_memory
WHERE category != 'env_var'
  AND content = '';

-- github_pat_ is rewritten in a second pass because Postgres ARE only allows
-- a fixed number of nested regexp_replace calls in a single SET expression
-- before parser readability collapses; splitting keeps the chain audit-able.
UPDATE repo_memory
SET content = regexp_replace(content, 'github_pat_[A-Za-z0-9_]{11,221}', '[REDACTED_GITHUB_TOKEN]', 'g')
WHERE category != 'env_var'
  AND content ~ 'github_pat_[A-Za-z0-9_]{11,221}';
