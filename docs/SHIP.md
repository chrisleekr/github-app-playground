# `bot:ship` — PR shepherding to merge-ready

The shepherding lifecycle takes an open PR from "needs work" to "ready for human merge" — driving CI fixes, replying to review threads, and resolving them, until the merge-readiness probe says the PR is clean. The bot **never** merges; the final merge action remains with a human (FR-008).

## How to invoke

There are three functionally equivalent surfaces (FR-027). All three produce the same canonical command and the same downstream behaviour; only the `surface` field on the canonical record differs (it appears in logs for observability, FR-016).

| Surface | Example                                                  | Notes                                                                                                    |
| ------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Literal | `bot:ship` _(or `bot:ship --deadline 2h`)_               | Deterministic regex parser. The legacy surface; available without any feature flag.                      |
| Natural | `@chrisleekr-bot ship this please`                       | Mention-prefix-gated NL classifier (FR-025a). Zero LLM cost on comments without the mention.             |
| Label   | Apply the `bot:ship` label _(or `bot:ship/deadline=2h`)_ | Bot self-removes the label after acting (FR-026a). Re-application is the supported re-trigger mechanism. |

All three surfaces — literal, natural-language, and label — are permanent v1 features. The natural-language path costs nothing on comments without the `TRIGGER_PHRASE` mention (FR-025a gate runs before the LLM call).

The four recognised verbs (each available across all three surfaces): `ship`, `stop`, `resume`, `abort-ship`. See `contracts/bot-commands.md` for full syntax.

## How to monitor

Each session writes a single canonical tracking comment marked with `<!-- ship-intent:{intent_id} -->`. The body shows current phase, last action, next queued action, iteration count, USD spent, deadline, and (on terminal) the blocker category. A maintainer glancing at the PR sees exactly where the bot is and whether they need to act.

For Day-2 SQL queries (active sessions, terminal-state distribution, USD spend by intent), see the in-repo file `specs/20260427-201332-pr-shepherding-merge-ready/quickstart.md` §"Day-2 ops".

## How to abort

Three ways, all equivalent:

| Surface | Example                          |
| ------- | -------------------------------- |
| Literal | `bot:abort-ship`                 |
| Natural | `@chrisleekr-bot abort the bot`  |
| Label   | Apply the `bot:abort-ship` label |

Abort sets a Valkey cancellation flag, waits ≤2 s for the next cooperative checkpoint, then force-transitions the intent to `aborted_by_user`. After abort, the bot performs zero further mutating actions on the PR (FR-009 / SC-005).

For a recoverable pause, use `bot:stop` (and later `bot:resume`) instead. A stopped session preserves its continuation row; the deadline keeps counting down while paused.

## Rollout flags

The remaining v1 rollout flags are `SHIP_USE_PROBE_VERDICT` (probe-verdict ladder vs. legacy in-process review/resolve loop) and `SHIP_USE_CONTINUATION_LOOP` (cron-tickle re-entry vs. in-process loop). Both default off; flip on after the corresponding soak per research.md R8.
