# Implement: issue #66 — paginate GraphQL fetcher + MAX_FETCHED\_\* caps

## Summary

Closes #66 (`fix(pipeline): GraphQL fetcher silently truncates PR/issue context past 100 items`).

`src/core/fetcher.ts` previously issued single-page GraphQL requests with `first: 100` on every connection (issue/PR comments, reviews, the inline comments nested under each review, and changed files). Anything past the first 100 items was silently dropped before the data ever reached the agent — the prompt looked complete but was missing context, which is the failure mode the issue calls out.

The fix:

1. Every connection now selects `pageInfo { hasNextPage endCursor }` and threads cursor variables (`$afterFiles`, `$afterComments`, `$afterReviews`) through the query. The fetcher walks the cursors via `octokit.graphql.paginate(...)` (already bundled with `octokit ^5.0.5` via `@octokit/plugin-paginate-graphql`).
2. A new `REVIEW_COMMENTS_QUERY` walks each review's overflow comments via the review node ID — `graphql.paginate` only follows one `pageInfo` per call, so the nested per-review pagination needs its own request.
3. Four new env vars (`MAX_FETCHED_COMMENTS` / `_REVIEWS` / `_REVIEW_COMMENTS` / `_FILES`, default `500` each) cap the merged result. When a cap fires the fetcher emits `log.warn({ connection, fetched, cap })` and sets `FetchedData.truncated.<connection> = true`.
4. `buildPrompt` in `src/core/prompt-builder.ts` reads `data.truncated` and prepends a `WARNING: pre-fetched context is incomplete…` banner naming the affected connections, so the agent knows to reach for the GitHub CLI when it needs the missing items.
5. The TOCTOU filter (`filterByTriggerTime`) runs after the paginate merge, so its semantics are unchanged.

## Plan deviations

- **T1 / T2 (install + thread plugin) skipped as no-ops.** `octokit ^5.0.5` already bundles `@octokit/plugin-paginate-graphql` and exposes `octokit.graphql.paginate` on every existing instance. Verified via lockfile inspection and a runtime probe. Threading a shared factory through 11 instantiation sites would have been pure churn for zero behaviour change.

## Files changed

- `src/core/fetcher.ts` · rewrote both queries to select `pageInfo`, switched to `graphql.paginate`, added `applyCap()` + nested review-comment follow-up; emits structured warn logs and sets `FetchedData.truncated` flags.
- `src/types.ts` · extended `FetchedData` with `truncated?: { comments?, reviews?, reviewComments?, changedFiles? }`.
- `src/config.ts` · added 4 zod fields + env wiring (`MAX_FETCHED_COMMENTS` / `_REVIEWS` / `_REVIEW_COMMENTS` / `_FILES`, default `500`).
- `src/core/prompt-builder.ts` · added `buildTruncationBanner` and injected it into the prompt when any flag is set.
- `test/core/fetcher.test.ts` · new tests covering pagination merge (length > 100), TOCTOU after merge, cap fire (log + flag), nested review-comment pagination, and banner injection.
- `test/factories.ts` · extended `makeOctokit` with `graphqlPaginateResponses` (substring-keyed routing on the paginate fn).
- `docs/operate/configuration.md` · 4 new rows documenting the env vars.
- `docs/operate/observability.md` · new "Data fetching safety caps" section documenting the warn log shape and prompt banner.

## Commits

- `fix(fetcher): paginate GraphQL connections + MAX_FETCHED_* caps (closes #66)` — single commit, branch `fix/issue-66-paginate-graphql`.

## Tests run

- `bun run typecheck` · clean.
- `NODE_OPTIONS='--max-old-space-size=4096' bunx eslint .` · 0 errors / 291 warnings (all pre-existing return-type warnings in unrelated files).
- `bun run format` · clean.
- `bun test test/core/fetcher.test.ts` · 30 pass / 0 fail / 64 expect calls.
- `bun run scripts/check-docs-citations.ts` · clean.
- `bun run scripts/check-docs-versions.ts` · clean.
- `bun run docs:build` · skipped locally (`mkdocs` not installed in workspace); runs in CI via `.github/workflows/docs.yml`.
- `bun run test` (isolated runner): 78 files passed, 25 files skipped because Postgres / Valkey are not running in this workspace (pre-existing infrastructure dependency, none of the skipped files were touched by this PR).

## Verification

- **Acceptance criterion: PRs/issues with > 100 comments / reviews / changed files no longer truncate silently.** New test "merges paginated issue comments into FetchedData (length > 100)" proves the merge for 250 comments; "merges paginated review comments across nested pageInfo" proves the nested review-comment merge (100 + 50 = 150).
- **Acceptance criterion: a hard cap protects the prompt window.** `applyCap` clamps to `config.maxFetchedComments` (etc.), emits a structured warn, and sets `truncated.<connection> = true`. Test "logs warn and sets truncated flag when MAX_FETCHED cap fires" asserts all three (length, log fields, flag).
- **Acceptance criterion: the agent must know when context is incomplete.** `buildPrompt` injects a `WARNING: pre-fetched context is incomplete…` banner naming the affected connections. Test "buildPrompt includes truncation banner when truncated flag is set" asserts the banner.
- **TOCTOU semantics preserved.** Test "applies filterByTriggerTime AFTER pagination merge" sets `triggerTimestamp` to comment-240 of 600 and asserts comment-239 (newest pre-trigger) survives while comments 240+ are dropped.

### Intentionally NOT done

- T1 / T2 (paginate-graphql install + threaded factory). Plugin is already bundled with `octokit ^5.0.5` and `octokit.graphql.paginate` is present on every existing instance. Documented above under "Plan deviations".
