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
--   2. Strip BMP invisibles + ASCII C0/C1 control characters: zero-width,
--      BOM, soft-hyphen, bidi controls, NUL through U+0008, U+000B/U+000C,
--      U+000E-U+001F, and U+007F-U+009F. Mirrors the bracket expression in
--      stripInvisibleCharacters() so a legacy row containing a stray ESC
--      (U+001B) or NBSP-adjacent C1 byte gets the same treatment as a row
--      written today.
--   3. Collapse CR/LF/U+2028/U+2029 runs to a single space (line-shape
--      break-out vector).
--   4. Redact every GitHub token shape that redactGitHubTokens covers:
--      ghp_ / gho_ / ghs_ / ghr_ / github_pat_.
--   5. Trim surrounding whitespace, including tab and NBSP, to match the
--      JS String.prototype.trim() set the runtime helper relies on.
--      Postgres btrim() defaults to ASCII space only, so an explicit
--      character set is required for parity.
--
-- This SQL pass is intentionally narrower than the TypeScript helper in
-- three specific ways:
--   (a) no markdown alt-text / link-title / hidden-attribute strip,
--   (b) no normalizeHtmlEntities decode/strip,
--   (c) no Unicode TAG block (U+E0000..U+E007F) strip - Postgres ARE in
--       17 does not range over the supplementary plane in a single
--       bracket-expression.
-- All three gaps are tolerated because every NEW write goes through the
-- runtime helper. Pre-existing rows containing payloads that exercise only
-- those vectors are vanishingly rare. Document any new gap added here in
-- test/security/SCENARIOS.md Section K alongside the rest.
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
                content,
                '<!--.*?-->', '', 'g'
              ),
              E'[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u00AD\\u200B-\\u200D\\u2066-\\u2069\\u202A-\\u202E\\uFEFF]', '', 'g'
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
  ),
  E' \t\u00A0'
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
