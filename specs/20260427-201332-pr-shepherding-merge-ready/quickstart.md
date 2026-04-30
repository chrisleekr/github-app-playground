# Quickstart: PR Shepherding to Merge-Ready State

**Audience**: Developer landing on this branch for the first time.
**Goal**: Get a working dev loop in under 10 minutes; understand how to test and validate each phase.

---

## Prerequisites

- Bun ≥ 1.3.12 (single-sourced via `.tool-versions`).
- Postgres 17 + Valkey 8 running locally — easiest via `bun run dev:deps` (Docker Compose).
- A GitHub App test installation pointing to this dev instance (existing `docs/SETUP.md` covers setup).
- `~/.env.local` populated per `docs/CONFIGURATION.md`. New env vars (Phase 0 R1–R8):

```text
# Wall-clock cap per shepherding session (FR-012a).
MAX_WALL_CLOCK_PER_SHIP_RUN=4h

# Cron tickle scan interval (R1).
CRON_TICKLE_INTERVAL_MS=15000

# mergeable=null backoff schedule (R2).
MERGEABLE_NULL_BACKOFF_MS_LIST=5000,10000,30000,60000,60000

# Review barrier (R3) — single global margin; no reviewer list.
REVIEW_BARRIER_SAFETY_MARGIN_MS=1200000

# Fix-attempts ledger cap (R4).
FIX_ATTEMPTS_PER_SIGNATURE_CAP=3

# Phase rollout flags (R8). Default false until each phase is smoke-tested.
SHIP_USE_PROBE_VERDICT=false
SHIP_USE_CONTINUATION_LOOP=false
# Trigger-surface wiring (literal/NL/label dispatch through the trigger router).
# When false, only the legacy `@chrisleekr-bot` mention dispatcher runs.
SHIP_USE_TRIGGER_SURFACES_V2=false
```

All new env vars are validated at startup by the Zod schema in `src/config.ts`. The server fails fast on invalid values (Constitution IV / "Code Style").

---

## Day-1 setup

```bash
git checkout 20260427-201332-pr-shepherding-merge-ready
bun install
bun run dev:deps             # starts Valkey + Postgres
bun run typecheck            # confirm strict TS still clean
bun run lint
bun test                     # baseline test suite must pass before adding new code
```

Once all green, you're ready to land the first phase.

---

## Phase-by-phase work loop

The plan delivers in 7 phases. Each is independently shippable; do not start a later phase before the earlier one is merged.

### P1 — Probe + verdict module

```bash
# Implementation
src/workflows/ship/verdict.ts        # MergeReadiness + NonReadinessReason types
src/workflows/ship/probe.ts          # Pure GraphQL probe; no agent
src/workflows/handlers/ship.ts       # Wire SHIP_USE_PROBE_VERDICT flag

# Tests (≥90% coverage required)
test/workflows/ship/verdict.test.ts
test/workflows/ship/probe.test.ts
test/workflows/ship/fixtures/probe-responses/*.json

# Local verification
bun run dev                          # starts webhook server
# In another terminal:
bun run local-e2e                    # invokes a webhook against a known PR; tail logs
```

**Acceptance for P1**:

- All probe-test scenarios from `contracts/probe-graphql-query.md` §"Test fixtures" pass.
- Setting `SHIP_USE_PROBE_VERDICT=true` in `.env.local` causes `ship` to use the probe verdict in place of the "no findings" terminal condition.
- `bun run check` green.

### P2 — Intent + iteration tables

```bash
# Implementation
src/db/migrations/008_ship_intents.sql   # 4 tables (only intents + iterations active in P2)
src/workflows/ship/intent.ts             # Lifecycle module
src/db/queries/ship.ts                   # Typed Bun.sql helpers
src/shared/ship-types.ts                 # SessionTerminalState + BlockerCategory enums

# Tests
test/workflows/ship/intent.test.ts
test/db/migrations/008.test.ts          # Schema-level tests (constraints, partial unique index)

# Migration apply
bun run db:migrate                       # applies 008
```

**Acceptance for P2**:

- Migration applies cleanly to a fresh database.
- Partial unique index rejects a second `active` intent for the same `(owner, repo, pr_number)`.
- `bot:ship` while session active replies "already in progress" without inserting a duplicate row.

### P3 — Continuation + cron tickle (the architectural payload)

```bash
# Implementation
src/workflows/ship/continuation.ts       # persist + resume
src/workflows/ship/tickle-scheduler.ts   # 15s scan over Valkey sorted set
# ship.ts: replace in-process loop with continuation re-entry behind SHIP_USE_CONTINUATION_LOOP flag

# Tests (≥90% coverage on continuation.test.ts — restart-safety property)
test/workflows/ship/continuation.test.ts
test/workflows/ship/tickle-scheduler.test.ts

# Restart-safety smoke test
bun run dev
# Trigger bot:ship on a PR; mid-session, kill the dev server (Ctrl-C); restart it.
# Verify: no duplicate tracking comment; same intent_id resumes.
```

**Acceptance for P3**:

- A killed-and-restarted dev server picks up the same intent without creating a duplicate tracking comment.
- Daemon job slots are released during waits (verify by checking active-slot count in Valkey while a session is mid-yield).
- Cron tickle scans run at 15s intervals and re-enqueue overdue continuations.

### P4 — Webhook reactor

```bash
# Implementation
src/workflows/ship/webhook-reactor.ts
src/webhook/events/check_run.ts          # NEW or MODIFIED
src/webhook/events/check_suite.ts        # NEW or MODIFIED
# Other event handlers gain reactor.fanOut() call after their existing logic

# Tests
test/workflows/ship/webhook-reactor.test.ts
```

**Acceptance for P4**:

- All scenarios in `contracts/webhook-event-subscriptions.md` §"Tests" pass.
- Webhook reactor early-wake latency <500ms p95 (measured via pino log timestamps).
- Cron tickle still works as backstop when webhooks are missed (test by intentionally dropping events).

### P5 — Fix-attempts ledger + deadline + USD telemetry

```bash
# Implementation
src/workflows/ship/signature.ts          # deriveSignature (Tier 1 + Tier 2)
src/workflows/ship/fix-attempts.ts       # per-(intent, signature) ledger
src/workflows/ship/deadline.ts           # wall-clock cap enforcement

# Tests (≥90% on signature determinism)
test/workflows/ship/signature.test.ts
test/workflows/ship/fix-attempts.test.ts
test/workflows/ship/deadline.test.ts
```

**Acceptance for P5**:

- Identical failure outputs produce identical signatures across runs (determinism).
- Different lint violations on different lines collapse to one signature when normalised.
- Tier 2 fallback engages when Tier 1 fails to extract an error line.
- Deadline-reached intent transitions to `deadline_exceeded` cleanly.
- USD spend appears in tracking comment after each agent-invoking iteration.

### P6 — Abort command

```bash
# Implementation
src/workflows/ship/abort.ts              # cancellation token + bot:abort-ship handler

# Tests
test/workflows/ship/abort.test.ts       # all scenarios from contracts/bot-commands.md
```

**Acceptance for P6**:

- `bot:abort-ship` from authorised user terminates session at next safe checkpoint.
- Zero further mutating actions after cancellation flag set (SC-005).
- Unauthorised abort attempt rejected with explanation.

### P7 — Resolve-review-thread MCP server

```bash
# Implementation
src/mcp/servers/resolve-review-thread.ts
src/mcp/registry.ts                      # MODIFIED: register the new server
src/workflows/handlers/resolve.ts        # MODIFIED: invoke resolve_review_thread tool after replying

# Tests
test/mcp/resolve-review-thread.test.ts
```

**Acceptance for P7**:

- All scenarios in `contracts/mcp-resolve-thread-server.md` §"Tests" pass.
- After a resolve iteration that addresses a thread, the thread shows as resolved on the PR (verified by next probe call returning `is_resolved=true` for that thread).
- No token field appears in any log line.

---

## Day-2 ops

### Observe a session in flight

```bash
# Active intents
bun run db:query "SELECT id, owner, repo, pr_number, status, deadline_at, spent_usd
                  FROM ship_intents
                  WHERE status = 'active'
                  ORDER BY created_at DESC"

# Recent iterations for a session
bun run db:query "SELECT iteration_n, kind, finished_at, non_readiness_reason, cost_usd
                  FROM ship_iterations
                  WHERE intent_id = '<id>'
                  ORDER BY iteration_n DESC LIMIT 20"

# Continuation state
bun run db:query "SELECT intent_id, wait_for, wake_at, state_version
                  FROM ship_continuations
                  WHERE intent_id = '<id>'"

# Fix-attempts ledger (which checks are stuck?)
bun run db:query "SELECT signature, tier, attempts, last_seen_at
                  FROM ship_fix_attempts
                  WHERE intent_id = '<id>'
                  ORDER BY attempts DESC"
```

### Tracking comment is the maintainer's UI

The tracking comment on the PR is the authoritative live view. Always check the PR before querying the DB.

### Logs

Filter pino logs by `intent_id`:

```bash
bun run logs:tail | jq 'select(.intent_id == "<id>")'
```

Every log line in `src/workflows/ship/*` includes the `intent_id` field via the child logger. This is enforced at code-review time per Constitution VI.

### Cost ceiling

USD per session is observability-only (Q3-round1). Sustained high cost → tighten `MAX_WALL_CLOCK_PER_SHIP_RUN`, do not add a USD kill switch.

---

## Rollback

Each phase has its own env flag (`SHIP_USE_PROBE_VERDICT`, `SHIP_USE_CONTINUATION_LOOP`, `SHIP_USE_TRIGGER_SURFACES_V2`, ...). Setting a flag to `false` reverts that phase's behaviour to the prior (legacy) code path without code rollback. Use this for any phase that misbehaves in production.

After one full week of clean operation on a phase, the flag is removed in a follow-up PR (per R8 cutover plan) — keeps `src/config.ts` from accumulating dead flags.

---

## Where to look when something goes wrong

| Symptom                                                        | First place to check                                                                                                                                |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bot declared `ready` but `main` broke after merge              | `ship_iterations.verdict_json` for the final probe iteration. Compare to actual GitHub state at that timestamp.                                     |
| Session never reaches terminal state                           | `ship_continuations.wake_at` (is the cron tickle picking it up?) and `ship_continuations.state_blob.iteration_n` (is the iteration count growing?). |
| `bot:ship` says "already in progress" but no PR comment exists | `ship_intents.status` for that PR. The marker scan in R10 is the recovery path; check `tracking_comment_id` is correct.                             |
| Webhook reactor not waking sessions                            | Check Valkey `ZRANGE ship:tickle 0 -1 WITHSCORES`. Verify webhook event subscriptions on the GitHub App installation.                               |
| Fix-attempts cap firing on PRs that should be fixable          | `ship_fix_attempts.signature` collisions; inspect with the test fixture matrix. Likely a normalisation gap in `signature.ts`.                       |

---

## Documentation updates required (per Constitution VIII, same-PR)

When P1–P7 land, the following docs MUST be updated in the same PR:

| Doc                     | Phase                     | Change                                                                       |
| ----------------------- | ------------------------- | ---------------------------------------------------------------------------- |
| `docs/CONFIGURATION.md` | every phase that adds env | Document each new env var with default + range.                              |
| `docs/BOT-WORKFLOWS.md` | P1, P2, P3                | Rewrite ship-workflow section to describe intent lifecycle and continuation. |
| `docs/ARCHITECTURE.md`  | P3, P4                    | Add Mermaid diagram of continuation + reactor flow.                          |
| `docs/SHIP.md` (NEW)    | P1                        | Operator-facing — what `bot:ship` does, how to monitor, how to abort.        |
| `docs/SETUP.md`         | P4                        | Document the 5 webhook event subscriptions required.                         |

End of quickstart.
