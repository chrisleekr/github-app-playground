# Shared test factories — implementation report

## Summary

Consolidated `makeCtx` / `silentLog` / `makeOctokit` boilerplate that was
duplicated across 6 test files into a single `test/factories.ts` module.
The factories produce `BotContext`, `EnrichedBotContext`, `FetchedData`,
mock loggers, and mock Octokit instances. Net: 7 files changed,
+208 / -221 lines (factories module included).

Per-file mock state (e.g. `mock.module(...)` calls) deliberately stays
inside each test file — Bun's module mocks persist process-wide and
sharing them through factories would create cross-file leakage.

## Files changed

- `test/factories.ts` · NEW. `makeSilentLogger`, `makeOctokit`,
  `makeBotContext`, `makeEnrichedBotContext`, `makeFetchedData`. The
  `MockLogger` intersection type satisfies both `BotContext["log"]`
  consumers and tests that need `.mock.calls` spy access.
- `test/utils/retry.test.ts` · Replaced inline `silentLog` literal with
  `makeSilentLogger()`.
- `test/webhook/authorize.test.ts` · Removed local `makeSilentLog()`,
  uses `makeSilentLogger()` from factories.
- `test/core/tracking-comment.test.ts` · Removed local `silentLog`
  const and `makeCtx()` helper; call sites now use `makeBotContext()`
  directly.
- `test/core/prompt-builder.test.ts` · Removed local `makeCtx()` and
  inline issue/PR fixture builders; uses `makeBotContext()` and
  `makeFetchedData()`.
- `test/core/fetcher.test.ts` · Local `makeCtx()` is now a thin wrapper
  around `makeBotContext()` + `makeOctokit()` that supplies the
  fetcher-specific GraphQL response/error overrides.
- `test/webhook/router.test.ts` · Local `makeCtx()` is now a thin
  wrapper around `makeBotContext()` + `makeOctokit()` that supplies
  router-specific defaults (`owner: "chrisleekr"`, `repo: "app"`,
  `triggerUsername: "chrisleekr"`).

## Commits

- `4cdde98` · refactor(testing): extract shared test factories

## Tests run

- `bun run typecheck` · exit 0
- `bun run lint` · exit 0 (103 pre-existing warnings, no errors)
- `bun test test/utils/retry.test.ts test/webhook/authorize.test.ts
test/core/prompt-builder.test.ts test/core/fetcher.test.ts
test/webhook/router.test.ts` · 95 pass / 0 fail
- `bun test test/core/tracking-comment.test.ts` · 26 pass / 0 fail

## Verification

- `bun run typecheck` exits 0 ✓
- `bun run lint` exits 0 ✓
- Migrated test files keep their original assertions; counts are
  identical to baseline ✓
- Source coverage for refactored modules unchanged
  (`src/core/{fetcher,prompt-builder,tracking-comment}.ts`,
  `src/webhook/{authorize,router}.ts`, `src/utils/retry.ts` all 100% line
  coverage in the targeted run) ✓
- Pre-existing test ordering interaction: when
  `test/webhook/router.test.ts` runs in the same Bun process as
  `test/core/tracking-comment.test.ts`, `mock.module(...)` from the
  router test intercepts the tracking-comment imports. Verified
  identical 95 pass / 1 fail / 1 error count on `main` (via `git stash`)
  — this is a pre-existing Bun module-mock persistence issue, not
  introduced by this refactor.
