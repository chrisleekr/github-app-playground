# Resolve report — PR #70

## Summary

PR #70 (`ci/wire-postgres-valkey-services-50` → `main`) had one failing
check (`Lint & Test`) and three open review threads when this resolve
iteration started. All three review threads were classified **Valid**
and are now addressed in commit
[`fddee33`](https://github.com/chrisleekr/github-app-playground/commit/fddee336).
The CI failure was an integration-test-isolation drift — the two suites
touched by this PR forgot to drop `workflow_runs` (added by migration
`005_workflow_runs` after these two suites were last edited) — and is
fixed in the same commit. PR is now waiting for CI to re-run on the new
HEAD; provided green, all blockers are cleared.

## CI status

| Check                     | Before                                                                                                                        | What I did                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Lint & Test`             | fail (1m14s, [run 24991617907](https://github.com/chrisleekr/github-app-playground/actions/runs/24991617907/job/73178325642)) | Diagnosed: `bun test test/integration/telemetry-aggregates.test.ts` failed with `PostgresError: relation "workflow_runs" already exists` during `runMigrations` step `005_workflow_runs`. Root cause: each Bun test file runs in its own process under `scripts/test-isolated.sh`; an earlier file (one of the 6 newer DB-backed suites) creates `workflow_runs`, and the cleanup hook in `telemetry-aggregates.test.ts` / `repo-knowledge.test.ts` only drops the legacy table set (`_migrations`, `repo_memory`, `triage_results`, `executions`, `daemons`) — leaving `workflow_runs` behind. Migration 005 then fails because `CREATE TABLE workflow_runs` (no `IF NOT EXISTS`) hits the leftover. **Fix**: added `DROP TABLE IF EXISTS workflow_runs CASCADE;` to both suites' `beforeAll` (and `telemetry-aggregates.test.ts`'s `afterAll`). The other 6 DB-backed suites already drop it. Pushed in `fddee33`. |
| `Analyze (actions)`       | pass                                                                                                                          | unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `Analyze (javascript-…)`  | pass                                                                                                                          | unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `CodeQL`                  | pass                                                                                                                          | unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `Gitleaks` (×2)           | pass                                                                                                                          | unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `Label PR based on title` | pass                                                                                                                          | unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## Review comments

### [major] `.github/workflows/ci.yml:134` — `TEST_VALKEY_URL` is dead

- **Classification**: Valid.
- **Evidence**: `grep -rn 'TEST_VALKEY_URL' src/ test/` returns zero
  matches in code; only `liveness-reaper.test.ts:21` reads
  `process.env["VALKEY_URL"]`, and the rest of the suite picks up
  `VALKEY_URL` via `setIfEmpty("VALKEY_URL", "redis://localhost:6379")`
  in `test/preload.ts:62`. CI worked today only because the preload
  default coincidentally matches the service container's port.
- **Action**: renamed `TEST_VALKEY_URL` → `VALKEY_URL` on the `Test`
  step in `.github/workflows/ci.yml`, with an inline comment explaining
  why the name differs from `TEST_DATABASE_URL`. Updated CONTRIBUTING.md
  to reference `VALKEY_URL` (and to note the preload default).
- **Reply**: <https://github.com/chrisleekr/github-app-playground/pull/70#discussion_r3147016965>

### [minor] `CONTRIBUTING.md:89` — DB-backed suite table is incomplete

- **Classification**: Valid.
- **Evidence**: `grep -rn 'TEST_DATABASE_URL' test/` finds 8 suites,
  not 3. The 5 missing entries: `test/webhook/events/issue-comment.test.ts`,
  `test/workflows/runs-store.test.ts`,
  `test/workflows/handlers/ship.test.ts`,
  `test/workflows/orchestrator.test.ts`,
  `test/orchestrator/liveness-reaper.test.ts`.
- **Action**: reframed the section in terms of the contract — "any suite
  gating on `process.env["TEST_DATABASE_URL"]` is opt-in; locate the
  current set with `grep -rn 'TEST_DATABASE_URL' test/`" — listed all 8
  current opt-in suites for visibility, and added explicit guidance to
  new-suite authors to drop every migration-created table in their
  cleanup hooks. That last point is exactly the trap that broke this
  PR's CI in the first place.
- **Reply**: <https://github.com/chrisleekr/github-app-playground/pull/70#discussion_r3147017118>

### [nit] `scripts/test-isolated.sh:15` — `' 0 fail'` is unanchored

- **Classification**: Valid (low-risk false-positive surface).
- **Evidence**: existing `grep -q ' 0 fail'` would match a stack trace,
  test name, or echoed string containing the substring; the new skip
  check on the same file already anchors with `^[[:space:]]+`.
- **Action**: tightened to `grep -qE '^[[:space:]]+0 fail'` for symmetry
  with the skip-check anchor on the same file. Updated the inline
  comment to explain the anchor's role. `shellcheck` still clean.
- **Reply**: <https://github.com/chrisleekr/github-app-playground/pull/70#discussion_r3147017224>

## Commits pushed

- `fddee33` · `fix(testing): drop workflow_runs in integration test cleanup; address review feedback`

## Outstanding

- **Waiting on CI** — the new HEAD (`fddee33`) was pushed at
  ~2026-04-27T11:46Z; the `Lint & Test` re-run is the canonical
  verification surface, just like the original PR. Provided it goes
  green:
  - `Lint & Test` cleared by the `workflow_runs` drop.
  - All 3 review threads cleared by the same commit.
  - `reviewDecision` is currently **not** APPROVED (the prior review
    raised the three findings); a re-review or explicit resolution by
    the author is the only remaining merge gate.
- **No human action items raised by this resolve iteration** beyond
  the standard re-review.

Local pre-push verification on `fddee33`:

- `bun run typecheck` — clean.
- `bun run lint` — 0 errors / 139 pre-existing warnings (unchanged baseline).
- `bun run format` — `All matched files use Prettier code style!`.
- `bun run build` — `Build completed successfully`.
- `bun run check:dockerfile-base-sync` — `OK: SHARED-BASE blocks match`.
- `shellcheck scripts/test-isolated.sh` — clean.
- `bash scripts/test-isolated.sh` (full suite) — 38 files passed; 6
  DB-backed suites correctly fail-via-skip locally because the sandbox
  has no Postgres / Valkey. CI provisions both; that is what cleared
  the silent-skip masking and is exactly the path the original PR was
  designed to enable.
