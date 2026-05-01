# Issue #51 — docs(ci): close docs-drift gap with PR-wide build, version-pin guard, and src-citation verifier

## Summary

Closes the silent docs-drift gap in `.github/workflows/docs.yml` by removing
the `pull_request:` `paths:` filter (so every PR runs `mkdocs build --strict`,
not just doc-touching PRs), and adds two project-specific CI gates that
`mkdocs --strict` cannot do on its own — a Bun-version pin verifier and a
`src/<path>:<line>` citation verifier. Also refreshes the surface-to-page
map in `CLAUDE.md` for the post-reorg `docs/` layout and documents the new
gates. Closes #51.

## Files changed (path · one-line rationale)

- `.github/workflows/docs.yml` · drop `paths:` from `pull_request:` so
  code-side changes that invalidate doc facts still trip the docs job;
  add `oven-sh/setup-bun@v2` plus two `Verify…` steps before
  `mkdocs build --strict`.
- `scripts/check-docs-versions.ts` · new Bun script. Reads canonical Bun
  version from `.tool-versions`, asserts `package.json` `engines.bun` /
  `packageManager` and `Dockerfile.{orchestrator,daemon}`
  `FROM oven/bun:<ver>` lines agree, then scans every `docs/**/*.md` for
  `oven/bun:<ver>` and for loose Bun semvers (only inside lines that
  mention the word `bun`, to avoid false matches on Node / openssl pins)
  and fails on disagreement.
- `scripts/check-docs-citations.ts` · new Bun script. Walks
  `docs/**/*.md`, extracts every `src/<path>.<ext>:<line>` (or
  `:<start>-<end>`) citation, and verifies the file exists and the cited
  line / range is in bounds. Bare `src/foo.ts` references without a
  `:line` suffix are intentionally out of scope — they don't claim a
  line and can't go stale on a shift.
- `package.json` · adds `check:docs-versions` and `check:docs-citations`
  scripts and chains both into the unified `check` script.
- `CLAUDE.md` · refreshes the `Documentation` surface-to-page map for
  the audience-first `docs/` layout (`operate/`, `build/`, `use/`) and
  documents the two new CI-enforced gates.
- `IMPLEMENT.md` · this artifact (replaces the prior run's tracking
  comment body).

## Commits (sha · subject)

- `<sha>` · ci(docs): run docs build on every PR + add version-pin and
  src-citation guards

## Tests run (command · result)

- `bun run typecheck` · pass (clean).
- `bun run lint` · pass — 0 errors, 261 pre-existing warnings unchanged
  (none in the two new scripts).
- `bun run format` · pass after `bun run format:fix` normalised
  `scripts/check-docs-citations.ts`.
- `bun run check:no-destructive` · pass.
- `bun run check:docs-versions` · pass on clean tree
  (`OK: every Bun version reference matches .tool-versions canonical 1.3.13`).
- `bun run check:docs-citations` · pass on clean tree
  (`OK: every src/<path>:<line> citation in docs/ points at an in-range location`).
- Negative-path for `check:docs-versions`: edited `docs/operate/setup.md`
  to say `1.3.8`; rerun exited 1 with
  `docs/operate/setup.md:9 [...] found '1.3.8', expected '1.3.13'`. Reverted.
- Negative-path for `check:docs-citations`: appended
  `src/k8s/ephemeral-daemon-spawner.ts:99999` to `docs/operate/deployment.md`;
  rerun exited 1 with `start line 99999 out of range (file has 226 lines)`.
  Reverted.

`bun run test` and `bun run docs:build` were not run locally — the test
suite goes through `scripts/test-isolated.sh` and depends on
Postgres/Valkey docker containers, and `mkdocs build --strict` needs
the Python deps from `docs/requirements.txt`. Both run as part of CI on
this PR.

## Verification

Acceptance criteria from the plan:

1. **Docs build runs on non-doc PRs.** `pull_request:` no longer carries
   a `paths:` filter (`.github/workflows/docs.yml`); the
   `Deploy to GitHub Pages` step keeps its
   `if: github.event_name == 'push' || github.event_name == 'workflow_dispatch'`
   guard so PR runs validate without publishing.
2. **Version-pin check is wired.** `scripts/check-docs-versions.ts` exits
   0 on a clean tree and 1 on any disagreement with `.tool-versions`.
   Wired into `bun run check` and as a `Verify docs version pins` step
   in `.github/workflows/docs.yml`.
3. **Citation check is wired.** `scripts/check-docs-citations.ts` exits
   0 on a clean tree and 1 on any out-of-range citation. Wired into
   `bun run check` and as a `Verify docs src citations` step in
   `.github/workflows/docs.yml`.
4. **`bun run check` includes both gates.** Updated in `package.json`.
5. **Workflow gate fails the job.** Both `Verify…` steps use
   `bun run …` without `continue-on-error`, so a non-zero exit fails
   the `Docs / build` check.
6. **Strict build still green.** No content changes to docs that the
   verifier would flag; `oven-sh/setup-bun@v2` is added before the
   Python setup so `bun` is on `PATH` for the new steps.

The four originally-cited stale facts (`SETUP.md:11` `>= 1.3.8`,
`DEPLOYMENT.md:30` `oven/bun:1.3.12`, `DEPLOYMENT.md:167` and
`DEPLOYMENT.md:215` `src/app.ts:<line>` pointers) were already re-synced
during the audience-first docs reorg in commit `a9c919d`, so no
doc-prose edits were needed in this PR — only the structural CI gates
that prevent them from rotting again.
