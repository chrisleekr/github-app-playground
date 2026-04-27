# Issue #33 — fix(idempotency): isAlreadyProcessed passes direction:"desc" — silently ignored; durable check fails on hot PRs

## Summary

Closes #33. The durable idempotency check in `isAlreadyProcessed` was passing `direction: "desc"` to `octokit.rest.issues.listComments`, but the per-issue REST endpoint does not accept `direction` (or `sort`); GitHub silently dropped the parameter and returned the **oldest** 100 comments ascending. On any PR/issue with >100 prior comments the just-posted tracking-comment marker landed on page 2+, so the durable check returned `false` and webhook retries on a fresh pod (where the in-memory `processed` Map is empty) re-ran the full pipeline — duplicate clones, duplicate Agent SDK runs, duplicate Anthropic spend, and duplicate tracking comments.

The fix replaces the bogus `direction: "desc"` with `since: ctx.triggerTimestamp` (already on `BotContext`, populated from `payload.comment.created_at` in `parseIssueCommentEvent` / `parseReviewCommentEvent`). This scopes the scan to comments at-or-after the webhook trigger; the tracking comment is posted seconds later, so even ~24 h of retries land inside the `since` window and the marker is guaranteed to be on page 1. The audit confirmed `tracking-comment.ts` is the only `listComments` caller in `src/`, so no other call sites needed the same correction.

## Files changed (path · one-line rationale)

- `src/core/tracking-comment.ts` · replaced `direction: "desc"` with `since: triggerTimestamp` in `isAlreadyProcessed` and rewrote the inline comment to match the per-issue REST endpoint's documented contract (orders strictly by ascending ID; only `since`/`per_page`/`page` are honoured).
- `test/core/tracking-comment.test.ts` · updated the call-shape assertion to pin `since`/`per_page` and assert `direction`/`sort` are NOT passed; added two behavioural tests (100-old-comments hot-PR and retry-path positive case) that the previous fixture never exercised.

## Commits (sha · subject)

- `43cfecf` · `fix(idempotency): scope durable check with since=triggerTimestamp instead of bogus direction:"desc"`

## Tests run (command · result)

- `bun test test/core/tracking-comment.test.ts` · **28 pass / 0 fail** (74 expect calls; `src/core/tracking-comment.ts` 100% line + 100% function coverage).
- `bun test test/webhook/router.test.ts` · **16 pass / 0 fail** (the file that exercises the two-layer idempotency sequence in `processRequest`).
- `bun run typecheck` · clean (`tsc --noEmit` exits 0).
- `bun run lint` · 0 errors (139 pre-existing warnings on unrelated files; none on the changed files).
- `bun test` (full suite) · 328 pass / 191 fail / 14 errors. The failing/error counts are **identical to the pre-change baseline on `main`** (verified by `git stash` + re-run); no regressions introduced by this change.

## Verification

- **T1 (patch `isAlreadyProcessed`)** — done. `src/core/tracking-comment.ts:92-115` now passes `since: triggerTimestamp` and `per_page: 100`, with no `direction`/`sort`. The rewritten inline comment explicitly documents that the per-issue endpoint orders by ascending ID and that `direction`/`sort` are silently dropped (only the repo-level sibling endpoint accepts them).
- **T2 (rewire existing test)** — done. The assertion test at `test/core/tracking-comment.test.ts:51-69` injects an explicit `triggerTimestamp` via `makeBotContext`, asserts `since` matches it, asserts `per_page === 100`, and asserts both `direction` and `sort` are `undefined`.
- **T3 (regression tests)** — done. The hot-PR test at `test/core/tracking-comment.test.ts:71-87` builds a 100-element fixture of unrelated `<!-- delivery:other-... -->` markers and asserts the function returns `false`. The retry-path positive test at `test/core/tracking-comment.test.ts:89-114` proves that a since-bounded window containing the bot's own marker resolves to `true`.
- **T4 (audit other callers)** — done. `Grep listComments src/` returns a single hit (`src/core/tracking-comment.ts:100`); no other call site in `src/` needed updating, so this PR remains correctly scoped to the one defect.
- **T5 (verification commands)** — done. See **Tests run** above.

The fix preserves behaviour for the common case (cold PRs with <100 comments, where the bug was already invisible) while correcting the hot-PR / retry case (>100 prior comments + retry on a fresh pod) that the issue called out as the cause of duplicate Anthropic spend and double tracking comments.
