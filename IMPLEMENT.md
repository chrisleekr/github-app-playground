# Implement: issue #76 — constant-time daemon bearer-token check + rotation slot

Closes #76 (`security(orchestrator): non-constant-time bearer-token check exposes DAEMON_AUTH_TOKEN to timing attacks`).

## Summary

The orchestrator's daemon WebSocket upgrade handler in `src/orchestrator/ws-server.ts` previously authenticated with a plain string `!==` comparison against the expected `Bearer <token>` value. JavaScript string equality short-circuits on the first mismatched byte, so response latency leaked the matching prefix length and a network-adjacent attacker could recover the daemon auth token one byte at a time. A recovered token would let the attacker register a malicious daemon and harvest per-job GitHub App installation tokens (which carry `contents:write` and `issues:write` permissions).

This PR replaces the comparison with a length-padded `crypto.timingSafeEqual`-based comparator, adds an optional `DAEMON_AUTH_TOKEN_PREVIOUS` rotation slot so operators can rotate the secret without a synchronised fleet restart, extends the existing `test/orchestrator/ws-server.test.ts` with six regression cases, and documents the rotation procedure in the configuration reference + daemon-fleet runbook.

## Files changed (path · one-line rationale)

- `src/orchestrator/ws-server.ts` · Adds an internal `isAuthHeaderValid()` helper that pads buffers to a fixed length, calls `timingSafeEqual` for both primary and previous tokens unconditionally, and combines results with bitwise OR (no JS short-circuit). Wires it into the upgrade handler in place of `!==`.
- `src/config.ts` · Adds optional `daemonAuthTokenPrevious` (zod) and the `DAEMON_AUTH_TOKEN_PREVIOUS` env mapping. `validateDataLayerConfig` already only requires the primary, so no validation change is needed.
- `test/orchestrator/ws-server.test.ts` · Six new regression cases covering missing header, shorter header, equal-length-different-bytes, longer prefix-collision, primary accept, and previous-token rotation accept — all driven through the real `Bun.serve` fetch handler via `await fetch(...)`.
- `docs/operate/configuration.md` · Adds a `DAEMON_AUTH_TOKEN_PREVIOUS` row to the orchestrator/daemon env table, notes the constant-time comparison on the primary, and links to the rotation runbook.
- `docs/operate/runbooks/daemon-fleet.md` · New "Rotating `DAEMON_AUTH_TOKEN`" section with a sequence diagram and step-by-step overlap-window procedure (90-day cadence per OWASP Secrets Management cheat sheet).
- `.env.example` · Documents the new `DAEMON_AUTH_TOKEN_PREVIOUS` variable.

## Commits (sha · subject)

- `cdc4834` · `fix(orchestrator): constant-time bearer-token check + rotation slot (#76)`

## Tests run (command · result)

- `bun run typecheck` · **pass** (clean exit)
- `NODE_OPTIONS='--max-old-space-size=4096' bunx eslint src/orchestrator/ws-server.ts src/config.ts test/orchestrator/ws-server.test.ts` · **0 errors / 10 pre-existing warnings** (all `@typescript-eslint/explicit-function-return-type` on inline-arrow `new Promise<T>(resolve => …)` callbacks that predate this PR — same pattern, just shifted line numbers)
- `bun run format` · **all files pass Prettier**
- `bun test test/orchestrator/ws-server.test.ts` · **17 pass / 0 fail** (11 pre-existing + 6 new). Per-file coverage table reports `src/orchestrator/ws-server.ts` at **100% line / 100% function** coverage.
- `bun test test/config.test.ts` · **40 pass / 0 fail**
- `bun run scripts/check-docs-versions.ts` · **OK**
- `bun run scripts/check-docs-citations.ts` · **OK**
- `bun test` (full suite) · 535 pass / 153 skip / 194 fail. Verified by `git stash` + re-run that all 194 failures exist on `main` unaffected by this PR — they are pre-existing infra-bound failures (Postgres / Valkey / removed test imports). Net zero new failures introduced.
- `bun run docs:build` · **not run locally** — `mkdocs` (Python) is not installed in the bot sandbox. The two project-specific gates that run ahead of `mkdocs build --strict` in CI (`check:docs-versions`, `check:docs-citations`) both pass, and the `docs.yml` PR pipeline will exercise the strict build.

## Verification

1. **T1 + T2 satisfied** — `src/orchestrator/ws-server.ts:30-82` introduces `isAuthHeaderValid()`, a constant-time bearer-token comparator. `src/orchestrator/ws-server.ts:111` replaces the vulnerable `authHeader !== \`Bearer ${authToken}\``with a call to the new helper. The 401 response shape and`logger.warn` payload are preserved verbatim, so the daemon reconnect path and any log-shipping consumers are unaffected.
2. **T3 satisfied** — `src/config.ts:282-289` adds `daemonAuthTokenPrevious: z.string().optional()` with an explanatory comment. `src/config.ts:763` maps `process.env["DAEMON_AUTH_TOKEN_PREVIOUS"]`. `validateDataLayerConfig` continues to only require the primary token (verified `src/config.ts:629-665`), so existing deployments are unaffected. The previous slot is consumed exclusively by the orchestrator; daemons (`src/daemon/ws-client.ts`) keep sending the primary `daemonAuthToken` value.
3. **T4 satisfied** — six new regression cases at the end of `test/orchestrator/ws-server.test.ts` under `describe("WebSocket auth (constant-time bearer comparator, #76)")`:
   - Missing `Authorization` header → 401
   - Header shorter than expected → 401
   - Header equal-length but different bytes → 401
   - Header longer than expected (prefix-collision attack) → 401 (this case would have authenticated under a buggy length-prefix comparator; the explicit length-equality guard rejects it)
   - Primary token accepted → not 401 (Bun returns 500 on a non-upgrade request, proving the auth check passed)
   - With `DAEMON_AUTH_TOKEN_PREVIOUS` set: both primary and previous tokens accepted; an unrelated token still rejected
4. **T5 satisfied** — `docs/operate/configuration.md:80` adds the `DAEMON_AUTH_TOKEN_PREVIOUS` env row with a link to the runbook section. `docs/operate/runbooks/daemon-fleet.md` adds a "Rotating `DAEMON_AUTH_TOKEN`" subsection with a 5-step procedure, a sequence diagram, and a 90-day cadence reference (OWASP Secrets Management).
5. **No new npm dependencies.** `node:crypto` is built-in; `Buffer` is a Bun/Node global. No package.json change.
6. **Vulnerable line gone.** `grep -n "Bearer" src/orchestrator/ws-server.ts` shows only the two `Buffer.from(\`Bearer ${...}\`, "utf8")`lines inside the comparator — no`!==`Bearer comparison remains.`grep -rn "timingSafeEqual" src/`now returns 3 hits inside`src/orchestrator/ws-server.ts` (was 0 before).
7. **No timing leak between primary/previous slots.** Both `timingSafeEqual` calls run unconditionally when `expectedPrevious !== null`, and the results are combined with bitwise `|` (Number coercion, no JS `||` short-circuit), so an attacker cannot tell which slot rejected them via timing.
8. **Bot pre-commit hook green.** `gitleaks` ran clean (`no leaks found`); lint-staged ran prettier + eslint clean.

Closes #76
