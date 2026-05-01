# Resolve — PR #88 (`chore/51-docs-ci-drift-guards`)

## Summary

All three open review threads on PR #88 were classified **Valid** and addressed in a single follow-up commit (`0bf0164`). The two new CI gates introduced by the PR (`scripts/check-docs-versions.ts` and `scripts/check-docs-citations.ts`) now (a) catch stale `oven/bun:<ver>` mentions inside Dockerfile comments / RUN / ENV lines instead of only the anchored `FROM … AS base` form, (b) reject `..` segments inside the citation path component so a doc citing `src/sub/../foo.ts:1` no longer silently reports OK, and (c) are exercised by 11 committed tests under `test/scripts/` that drive each script via `Bun.spawnSync` against tmp-dir fixtures. Both scripts grew a tiny env-var seam (`DOCS_CHECK_REPO_ROOT`, namespaced + commented) so tests can point them at a fixture tree without copying the script — production invocations leave it unset and resolve `repoRoot` from `import.meta.url` exactly as before. Branch is now `0bf0164`, 2 ahead of `main`, no rebase required; the new commit is the final blocker for CI reruns to confirm. Nothing else is outstanding from this resolve iteration.

## CI status

| Check               | State at start       | Action                                   |
| ------------------- | -------------------- | ---------------------------------------- |
| All required checks | passing on `3455f33` | None (branch was clean entering resolve) |

No diagnose-and-fix cycle was needed. The follow-up commit `0bf0164` will rerun the same suite. The new tests are scoped to `test/scripts/` and stay inside the existing 90% per-file coverage threshold (Bun's coverage only counts files loaded into the test process; the spawned scripts run in a child process and aren't measured by the parent test file's coverage).

## Review comments

| ID                                                                                                 | File:line                             | Classification | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Reply                                                                                              |
| -------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [`3173541169`](https://github.com/chrisleekr/github-app-playground/pull/88#discussion_r3173541169) | `scripts/check-docs-versions.ts:113`  | **Valid**      | `checkDockerfile` now scans every `oven/bun:<ver>` occurrence on each line via the existing `OVEN_RE` regex; the anchored `FROM … AS base` check is kept solely as a presence assertion. Stale comments such as `Dockerfile.daemon:193` (`# /root is mode 700 in oven/bun:1.3.13`) now trip on the next bump. Regression test: `flags a Dockerfile comment whose oven/bun:<ver> has rotted` in `test/scripts/check-docs-versions.test.ts`.                                                                                               | [`3173593316`](https://github.com/chrisleekr/github-app-playground/pull/88#discussion_r3173593316) |
| [`3173541707`](https://github.com/chrisleekr/github-app-playground/pull/88#discussion_r3173541707) | `scripts/check-docs-citations.ts:29`  | **Valid**      | After the regex match, `relPath.split("/").includes("..")` rejects any citation whose path component contains a `..` segment, with reason `path contains a \`..\` segment — citations must point inside src/`. Regression test: `rejects \`..\` segments in the path component`.                                                                                                                                                                                                                                                         | [`3173593722`](https://github.com/chrisleekr/github-app-playground/pull/88#discussion_r3173593722) |
| [`3173542242`](https://github.com/chrisleekr/github-app-playground/pull/88#discussion_r3173542242) | `scripts/check-docs-citations.ts:154` | **Valid**      | Added `test/scripts/check-docs-versions.test.ts` (5 cases) + `test/scripts/check-docs-citations.test.ts` (6 cases). Each builds a tmp-dir fixture (`.tool-versions`, `package.json`, `Dockerfile.*`, `docs/`, `src/`), spawns the script via `Bun.spawnSync` with `DOCS_CHECK_REPO_ROOT` pointing at the fixture, and asserts exit code + a stderr substring. Both scripts now read `process.env["DOCS_CHECK_REPO_ROOT"] ?? <import.meta.url default>` so production behaviour is unchanged. `bun test test/scripts/` → 11 pass, 0 fail. | [`3173594183`](https://github.com/chrisleekr/github-app-playground/pull/88#discussion_r3173594183) |

## Commits pushed

- `0bf0164` · ci(docs): harden version + citation gates against PR #88 review feedback

## Outstanding

Nothing blocks merge from a resolve perspective:

- All three review comments are addressed and have evidence-backed replies.
- Local `bun run typecheck`, `bun run lint` (0 errors / 276 pre-existing warnings, unchanged), `bun run format`, `bun run check:no-destructive`, `bun run check:docs-versions`, `bun run check:docs-citations`, and `bun test test/scripts/` are all green.
- `bun run test` (full suite via `scripts/test-isolated.sh` / Postgres + Valkey) and `bun run docs:build` (mkdocs strict, needs Python deps) were not run locally — both run in CI on this PR and were passing on the prior commit.
- This bot can post inline replies but cannot submit a formal `APPROVE` review decision (FR-017). Final approval and merge remain a human action.
