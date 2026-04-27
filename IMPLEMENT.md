# Issue #50 — ci(testing): integration and migration tests silently skip in CI because ci.yml declares no Postgres or Valkey service

## Summary

Wired Postgres + Valkey service containers into `.github/workflows/ci.yml`
so the three DB-backed suites (`test/db/migrate.test.ts`,
`test/integration/repo-knowledge.test.ts`,
`test/integration/telemetry-aggregates.test.ts`) actually execute on every
PR instead of `describe.skipIf(sql === null)`-ing themselves to green.
Hardened `scripts/test-isolated.sh` so a fully-skipped suite no longer
slips past the `' 0 fail'` grep, and documented the DB-backed test
contract in `CONTRIBUTING.md`. Closes #50.

## Files changed (path · one-line rationale)

- `.github/workflows/ci.yml` · adds a `services:` block
  (`pgvector/pgvector:pg17` + `valkey/valkey:9` with healthchecks
  mirroring `docker-compose.dev.yml`), inserts a `Seed test database`
  step that runs `scripts/init-test-db.sql` via `psql`, and exports
  `TEST_DATABASE_URL` / `TEST_VALKEY_URL` on the `Test` step so the
  existing default-URL fallbacks resolve to the service containers.
- `scripts/test-isolated.sh` · success detection now requires both
  `' 0 fail'` AND a non-skip Bun summary; a suite that produces only
  skips is reported as `FAIL (skipped tests present): <file>` and the
  full Bun output is preserved for debugging.
- `CONTRIBUTING.md` · new "Database-backed integration tests"
  subsection under `## Testing` listing the three suites, the
  `bun run dev:deps` workflow, the `TEST_DATABASE_URL` /
  `TEST_VALKEY_URL` defaults, and a `> [!WARNING]` callout that
  `repo-knowledge.test.ts` is destructive (drops & recreates tables) and
  only opts in when `TEST_DATABASE_URL` is explicitly set.

## Commits (sha · subject)

- (filled in after `git push`) · `ci(testing): wire Postgres + Valkey services into ci.yml`

## Tests run (command · result)

- `bun run typecheck` · clean (`tsc --noEmit` exited 0).
- `bun run lint` · 0 errors / 139 pre-existing warnings — same baseline
  as `main`; no new diagnostics introduced.
- `bun run format` · `All matched files use Prettier code style!` after
  `bun run format:fix` normalised a CONTRIBUTING.md table column width.
- `bun run build` · `Build completed successfully`.
- `bun run check:dockerfile-base-sync` · `OK: SHARED-BASE blocks match`.
- `shellcheck scripts/test-isolated.sh` · clean.
- Hardened-detection regression on `test/db/migrate.test.ts`
  (a fully-skipped suite without a DB) · `has_zero_fail=true
has_skip=true → RESULT: fail` — script now correctly rejects what it
  previously called green.
- Hardened-detection sanity on `test/utils/circuit-breaker.test.ts`
  (a normal passing non-DB suite) · `has_zero_fail=true has_skip=false
→ RESULT: pass` — confirms no false positives on regular passing files
  (Bun omits the `0 skip` line entirely when no tests skip).
- `bun run test` (full suite) · NOT run end-to-end locally because the
  sandbox has no Postgres on `localhost:5432` and no `github_app_test`
  database. The CI run on this PR is the canonical verification surface
  for that — that's exactly the gap this PR closes.

## Verification

- **T1 (services block)** — `.github/workflows/ci.yml:34-62` declares
  `postgres: pgvector/pgvector:pg17` (env `POSTGRES_USER=bot` /
  `POSTGRES_PASSWORD=bot` / `POSTGRES_DB=github_app`, port `5432:5432`,
  `--health-cmd "pg_isready -U bot -d github_app"` with the same 5s/3s/5
  cadence as `docker-compose.dev.yml:19-23`) and `valkey: valkey/valkey:9`
  (port `6379:6379`, `--health-cmd "valkey-cli ping"`, same cadence).
  Image tags match `docker-compose.dev.yml:9,26`.
- **T2 (seed step)** — `.github/workflows/ci.yml:114-129` installs
  `postgresql-client` only when `psql` is missing (`ubuntu-latest`
  already ships with it; the `apt-get install` is a defensive fallback
  in case the runner image changes upstream) and runs
  `psql -h localhost -U bot -d github_app -v ON_ERROR_STOP=1 -f scripts/init-test-db.sql`,
  creating `github_app_test`. Necessary because GitHub Actions
  `services:` containers do not execute `/docker-entrypoint-initdb.d/`,
  which is the path `docker-compose.dev.yml:18` relies on locally.
- **T3 (Test-step env vars)** — `.github/workflows/ci.yml:131-135` sets
  `TEST_DATABASE_URL=postgres://bot:bot@localhost:5432/github_app_test`
  and `TEST_VALKEY_URL=redis://localhost:6379` on the `Test` step.
  These match the defaults at `test/db/migrate.test.ts:15-16` and
  `test/integration/telemetry-aggregates.test.ts:14-15`, and they
  satisfy the explicit-set requirement at
  `test/integration/repo-knowledge.test.ts:27-30`. No test-source diff
  was required.
- **T4 (hardened skip detection)** —
  `scripts/test-isolated.sh:11-40` now requires both `has_zero_fail`
  AND `! has_skip` for a file to count as passed. The skip check uses
  `grep -qE '^[[:space:]]+[1-9][0-9]* skip'`, which only matches Bun's
  summary line when the count is ≥ 1 (Bun omits the `0 skip` line when
  no tests skip, so a normal pass still resolves correctly). The
  failure label discriminates: `FAIL (skipped tests present): <file>`
  vs. `FAIL: <file>`, so CI logs make the rejection reason obvious.
  End-to-end verified: a single fully-skipped run of
  `test/db/migrate.test.ts` now reports
  `has_zero_fail=true has_skip=true → RESULT: fail`, where it would
  previously have passed.
- **T5 (CONTRIBUTING.md)** — adds a "Database-backed integration
  tests" subsection under `## Testing` listing the three suites with
  one-line descriptions, the `bun run dev:deps` path, the two default
  URLs, and a `> [!WARNING]` callout that
  `test/integration/repo-knowledge.test.ts` is destructive — its
  `beforeAll` hook drops `repo_memory`, `triage_results`, `executions`,
  and `daemons` — and is therefore opt-in via explicit
  `TEST_DATABASE_URL`.
- **T6 (CI sanity check)** — left for the PR run: the
  `lint-and-test` job on this PR will surface (a) the `Initialize
containers` step provisioning both services, (b) the seed step
  creating `github_app_test`, and (c) the `Test` step's Bun output
  showing non-zero `it` counts on `migrate.test.ts`,
  `repo-knowledge.test.ts`, and `telemetry-aggregates.test.ts`.

**Intentionally NOT done**

- Did not run the full `bun run test` locally — the sandbox does not
  have a `bot:bot@localhost:5432` Postgres with a `github_app_test`
  database. The CI run on this PR is the canonical verification surface,
  which is exactly the gap this PR closes.
- Did not change any test code. The plan called out that the existing
  default-URL fallbacks already match the values exported by the new
  `Test` step, so this PR is a CI-wiring change with zero test-source
  diff.
- Did not add `actionlint` to local tooling — no
  `actionlint`/`shellcheck` config exists in this repo and adding one
  would expand scope past the bug.
