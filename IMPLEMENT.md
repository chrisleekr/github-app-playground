# Implement — issue #52: pino logger redact paths + err scrubbing

Closes #52.

## Summary

Adds path-based redaction and a composed `err` serializer to the root
pino instance at `src/logger.ts:174` so every log line — across every
child logger and every call site — passes through a single chokepoint
that scrubs:

- Named credential fields (`authorization`, `x-hub-signature-256`,
  `privateKey`, `webhookSecret`, `installationToken`,
  `claudeCodeOauthToken`, `daemonAuthToken`, `awsBearerTokenBedrock`,
  `awsSecretAccessKey`, `awsSessionToken`, `anthropicApiKey`, `token`,
  `*.password`, plus the `headers.*` / `*.headers.*` /
  `req.headers.*` / `request.headers.*` / `response.data.token` shapes
  for the same fields).
- Free-text leakage in error `message`, `stack`, `request.headers.*`,
  and `response.data.*`. The serializer reuses the already-tested
  `redactGitHubTokens` regex (`src/utils/sanitize.ts:77-89`) and adds
  an inline `scheme://user:pass@host` scrubber that mirrors
  `redactValkeyUrl` (`src/orchestrator/valkey.ts:62-73`).

The serializer operates on a copy, so the original `Error` instance is
never mutated. No new npm dependencies, no env var changes, no edits
to the ~27 callers of `logger.*`.

## Files changed (path · one-line rationale)

- `src/logger.ts` · Adds `REDACT_PATHS` + composed `errSerializer`,
  wires both into the root pino instance, exports them so tests can
  rebuild the same config against a captured destination.
- `test/utils/logger.test.ts` · New file — eight unit tests covering
  every leak vector from the issue: App JWT in
  `err.request.headers.authorization`, `ghs_…` in `err.message` and
  `err.stack`, top-level `privateKey` field, `x-hub-signature-256`
  header, Valkey URL credentials in `err.message`, non-mutation of
  the original Error, `response.data.token` redaction, and the
  non-error pass-through branch.
- `docs/operate/observability.md` · New "Log redaction" section
  documenting the two-layer approach (paths + err serializer),
  citing `src/logger.ts:17` and `src/logger.ts:113`, and noting that
  `redactGitHubTokens` / `redactValkeyUrl` remain in place for their
  non-log call sites.

## Commits (sha · subject)

- `36a23bf` · fix(logger): redact paths and scrub err.\* before pino emits
- `854c8df` · test(logger): cover redact paths and err serializer scrubbing
- `8e13042` · docs(observability): document the logger as canonical redaction chokepoint

## Tests run (command · result)

- `bun run typecheck` · clean (0 errors)
- `bun run lint` · 0 errors / 277 warnings (identical to pre-change baseline of 277)
- `bun run format` · `All matched files use Prettier code style!`
- `bun test test/utils/logger.test.ts` · 8 pass / 0 fail / 25 expect() calls
- `bun test test/utils/sanitize.test.ts` · 30 pass / 0 fail (regression check)
- `bun run scripts/check-docs-citations.ts` · OK (every `src/<path>:<line>` citation in docs is in-range)
- `bun run scripts/check-docs-versions.ts` · OK (Bun version pins agree)
- `mkdocs build --strict` · clean

The wider `bun test` suite has 186 fail / 24 errors that are
infrastructure-dependent (require real Postgres + Valkey) and were
present on `main` before this PR (verified by `git stash && bun test`
baseline: 187 fail / 25 errors — this PR actually removes one failure
and one error).

## Verification

1. **T1 — redact paths:** `src/logger.ts:17` enumerates every path the
   issue asked for. The list lives next to the logger so a new
   secret-bearing config field added in `src/config.ts` is one place
   to update.
2. **T2 — composed err serializer:** `src/logger.ts:131` defers to
   `pino.stdSerializers.err` and only then runs string-scrubbers,
   preserving downstream tooling compatibility while catching the
   four-segment-deep `err.request.headers.authorization` path that
   pino's wildcard syntax cannot reach (pino's `*.foo.bar` only
   matches 3-segment paths). Verified by the
   `redacts request.headers.authorization carrying an App JWT` test.
3. **T3 — Valkey URL credential scrubbing folded into logger:**
   `redactCredentialUrls` in `src/logger.ts:54` is invoked by
   `scrubString`, which the err serializer applies to `message`,
   `stack`, and string values inside `request.headers` /
   `response.data`. The point helper at `src/orchestrator/valkey.ts:64`
   stays in place for the info-log call site at
   `src/orchestrator/valkey.ts:33`. Verified by
   `scrubs Valkey URL credentials embedded in err.message`.
4. **T4 — unit tests:** `test/utils/logger.test.ts` covers all five
   plan-mandated assertions plus the response.data.token / non-error
   branches. Coverage on `src/logger.ts` is 100% functions / 98.97%
   lines (above the 90 % per-file gate).
5. **T5 — docs:** `docs/operate/observability.md` gains a "Log
   redaction" section that describes both layers and cross-links to
   the point helpers; `mkdocs build --strict` passes, citation guard
   passes.
6. **Non-mutation:** The serializer uses object spread to produce
   fresh `request` / `response` objects, leaving the original `Error`
   instance untouched. Verified by the
   `does not mutate the original Error instance` test.

The optional plan item ("fold `redactValkeyUrl` into the logger
config so the remaining ad-hoc call at `src/orchestrator/valkey.ts:33`
stops diverging from the global policy") was implemented via the
inline regex scrubber inside the err serializer rather than by
importing the existing helper, to avoid introducing a
`logger -> valkey -> logger` import cycle. The existing
`redactValkeyUrl` call at line 33 (info path) is still wanted: it
runs at startup _before_ the logger emits, on a value (`config.valkeyUrl`)
that is otherwise safe to log structurally.
