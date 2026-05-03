# Implement: issue #74 — supplemental fetch of PR base branch in checkout

Closes #74 (`fix(pipeline): shallow single-branch clone omits origin/baseBranch, breaking PR diffs and auto-rebase`).

## Summary

The pipeline's PR checkout uses `git clone --single-branch --branch=<headBranch>`, which rewrites `remote.origin.fetch` so only the head branch is fetched. The agent prompt then directs the agent to use `origin/<baseBranch>` for diffs, and the auto-rebase handler tells the agent to `git rebase origin/<baseRef>` — both fail because the base branch's remote-tracking ref was never created. This change adds a small additive supplemental fetch in `checkoutRepo` (`git remote set-branches --add` + `git fetch --depth=<cloneDepth>`) that runs only on PR events when `baseBranch` is non-empty and differs from the cloned head branch. Failures are best-effort (warn-and-continue) so a missing base ref never aborts an unrelated request.

## Files changed (path · one-line rationale)

- `src/core/checkout.ts` · Accept optional `baseBranch` parameter; on PR events with head ≠ base, run `git remote set-branches --add origin <baseBranch>` + `git fetch --depth=<cloneDepth> origin <baseBranch>` after the initial clone. Wraps in try/catch with Pino warn (no abort). Adds a Pino info log anchored on the existing "Cloning repository" line.
- `src/core/pipeline.ts` · Forward `enrichedCtx.baseBranch` (already populated from GraphQL at L229) into `checkoutRepo` via the new explicit parameter.
- `src/core/prompt-builder.ts` · Trim now-redundant defensive prose `(NOT 'main' or 'master')` from the PR diff instructions and the IMPORTANT-CLARIFICATIONS line — `origin/<baseBranch>` now resolves first try so the agent doesn't need the warning.
- `test/core/checkout.test.ts` · New unit test using `git init --bare` + `GIT_CONFIG_COUNT/KEY/VALUE` `insteadOf` redirect to drive `checkoutRepo` against a local fixture. Four cases: PR head ≠ base (both refs present), PR head == base (no duplicate fetch), issue event (no supplemental fetch), PR with no `baseBranch` supplied.
- `CLAUDE.md` · Pipeline step 5 now notes the supplemental base-branch fetch on PR events.
- `docs/build/architecture.md` · "One request, one clone" bullet mentions the supplemental fetch with one clarifying sentence.

## Commits (sha · subject)

Single conventional-commit on this branch — see `git log main..HEAD --oneline`. Subject: `fix(checkout): fetch PR base branch so origin/<baseBranch> resolves (closes #74)`.

## Tests run (command · result)

- `bun run typecheck` · pass (clean exit)
- `NODE_OPTIONS='--max-old-space-size=4096' bun run lint` · 0 errors / 291 pre-existing warnings
- `bun test test/core/checkout.test.ts test/core/prompt-builder.test.ts` · **33 pass / 0 fail / 94 expect()**
- `bun test` (full suite) · **530 pass / 153 skip / 194 fail** vs. **530 pass / 153 skip / 195 fail on `main` with this branch's test file present** — net zero new failures (in fact one fewer, since the new checkout test passes here and would fail on `main`). All 194 remaining failures are pre-existing and infra-bound (Postgres / Valkey / removed `finalizeTrackingComment` & `requireDb` test imports) — unrelated to this change.
- `bun run scripts/check-docs-citations.ts` · OK
- `bun run scripts/check-docs-versions.ts` · OK

## Verification

1. **T1 satisfied** — `src/core/checkout.ts` adds the supplemental `git remote set-branches --add origin <baseBranch>` + `git fetch --depth=<cloneDepth> origin <baseBranch>` after the initial clone, gated on `ctx.isPR && baseBranch !== undefined && baseBranch !== "" && baseBranch !== branch`. Wrapped in try/catch with Pino `warn` carrying `{baseBranch, headBranch, err}` — a missing base ref degrades gracefully to a warn log instead of aborting checkout. Pino info log added before the supplemental fetch with `{baseBranch, headBranch, depth}`.
2. **T2 satisfied** — `src/core/pipeline.ts` now passes `enrichedCtx.baseBranch` as the third argument to `checkoutRepo`. `EnrichedBotContext.baseBranch` is required (typed in `src/types.ts:166`), populated from GraphQL at `src/core/pipeline.ts:229`.
3. **T3 satisfied** — `test/core/checkout.test.ts` builds a real bare upstream with `main` + `feat/x`, redirects the hardcoded `https://github.com/...` URL via `GIT_CONFIG_COUNT/KEY_0/VALUE_0` `insteadOf`, and asserts `git branch -r` against the workDir. Cases:
   - PR head ≠ base → both `origin/feat/x` and `origin/main` resolvable via `git rev-parse`.
   - PR head == base → only `origin/main` (no duplicate fetch attempted).
   - Issue event (`isPR=false`) → only `origin/main` (supplemental fetch gated on `isPR`).
   - PR with `baseBranch` undefined → only `origin/feat/x` (gate also covers absence).
4. **T4 satisfied** — `(NOT 'main' or 'master')` removed from `src/core/prompt-builder.ts:56` and L140; the actual `git diff origin/<baseBranch>...HEAD` directives are intact.
5. **T5 satisfied** — `test/core/prompt-builder.test.ts` had no assertions matching the trimmed substring (verified by grep); 29/29 prompt-builder tests still pass.
6. **T6 satisfied** — `CLAUDE.md` Pipeline step 5 + `docs/build/architecture.md` "One request, one clone" bullet both note the supplemental base-branch fetch in one sentence each.
7. **Manual smoke not run** — the live-PR trigger check requires the deployed daemon (out of scope for the implement workflow). Verification 3 in the plan is covered structurally by the new unit test, which exercises the exact code path with a real `git clone --single-branch` + supplemental fetch against a real local upstream.
8. **No new dependencies, no schema changes, no API surface changes** — checkout signature gained one optional parameter; all existing callers (triage handler, plan handler) continue to work unchanged because they don't pass it.
