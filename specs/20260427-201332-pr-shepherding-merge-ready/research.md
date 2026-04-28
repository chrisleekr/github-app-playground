# Phase 0 Research: PR Shepherding to Merge-Ready State

**Date**: 2026-04-27
**Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)
**Source proposal**: `~/Dropbox/Private Note/20260426_pr-shepherding-merge-ready-architecture.md`

This document resolves every unknown the plan flags as needing decision before tasks/implementation. Each entry: **Decision**, **Rationale**, **Alternatives considered**.

---

## R1. Cron tickle interval

**Decision**: Single global Bun-timer scheduler running every **15 seconds**, scanning the `ship:tickle` Valkey sorted set (`ZRANGEBYSCORE ship:tickle 0 <now_ms> LIMIT 0 100`) for due continuations and re-enqueueing them.

**Rationale**:

- 15s is short enough that the worst-case extra latency over a webhook-driven early-wake is one tickle interval — well under the 30-min SC-002 wall-clock SLO.
- 15s is long enough that a 100-active-intent fleet causes 1 ZRANGEBYSCORE every 15s (≈4 RPS to Valkey) — negligible.
- A `ZRANGEBYSCORE` against a sorted set is O(log N + K); 100-row K-cap with `LIMIT 0 100` keeps each tick bounded.
- Single global tick is simpler than per-intent timers (no timer-leak risk; restart picks up trivially because state is in Valkey).
- The Bun scheduler runs inside the webhook server process (Constitution: single-server). It does not require a new OS process.

**Alternatives considered**:

- _Per-intent setTimeout in-process_: would explode timer count and lose state across restart.
- _Cron via OS cron / k8s CronJob_: introduces a third process; overkill for 15s cadence.
- _Valkey pub/sub for wake events_: works but loses durability — a missed message strands the intent. The sorted-set polling design is restart-safe by construction.

**Configurable via env**: `CRON_TICKLE_INTERVAL_MS` (default `15000`). Defaulting low because the cost is negligible; an operator can raise it for a quieter system.

---

## R2. `mergeable=null` debouncing schedule

**Decision**: Geometric backoff schedule **`[5_000, 10_000, 30_000, 60_000, 60_000]` ms**, max 5 polls. After exhaustion, return `NonReadinessReason = mergeable_pending` and yield (FR-021). Total wall-clock budget consumed: ~165s in worst case.

**Rationale**:

- GitHub's `mergeable` field typically resolves within 5–30s of a push (per architecture note §6).
- Geometric growth balances responsiveness (fast first poll catches the common case) against API budget (later polls back off).
- Upper bound 5 polls × 60s = 5 minutes prevents a stuck intent burning more than that window per probe call.
- Returning `mergeable_pending` instead of failing is correct: it tells the orchestrator "yield and retry on next tickle" which is exactly the FR-020 slot-release behavior.

**Alternatives considered**:

- _Linear backoff (e.g., `[10s × 5]`)_: wastes polls in the common-fast case; a 5s first poll covers most resolutions.
- _Exponential (`5, 10, 20, 40, 80, ...`)_: grows too aggressively past the typical 30s resolution window.
- _Single fixed wait_: simpler but either too short (false `pending`) or too long (slow probe).

**Configurable via env**: `MERGEABLE_NULL_BACKOFF_MS_LIST` (default `"5000,10000,30000,60000,60000"`). Validated by Zod as a comma-separated list of positive integers.

---

## R3. Review-barrier safety margin (reviewer-agnostic)

**Decision**: Single global safety margin **20 minutes** since the most recent push to the head SHA. Before declaring `ready`, the bot MUST observe either (a) at least one review from any non-bot author against the current head SHA, or (b) 20 minutes elapsed since the most recent push with no review activity from any non-bot author. There is no list of "expected" reviewers — the barrier is purely "any non-bot review OR margin elapsed". The bot's own GitHub App login is excluded from the "non-bot" set.

**Rationale**:

- Per spec clarification 2026-04-27 the system MUST NOT maintain a configurable list of reviewer logins. The reasoning is operational simplicity: a reviewer list is one more config surface to keep in sync with whichever bots/humans are actually configured on a given installation, and gets stale silently.
- 20 minutes is comfortably under the SC-002 30-minute wall-clock SLO. Memory note `feedback_coderabbit_review_latency.md` records 10–15 min as a typical observed upper bound for one common reviewer on this repo; 20 minutes adds a small margin without becoming a noticeable wall-clock burden.
- "Non-bot" is detected by the GraphQL `author.__typename === 'User'` filter (excluding `Bot`) AND `author.login !== <our App's login>`. This generalises to humans posting reviews and to other Apps posting reviews equally, without enumerating any specific reviewer.
- The trade-off explicitly accepted in the spec: on PRs with slow auto-reviewers the bot may declare `ready` before nitpicks arrive. The human can re-trigger `bot:ship` to re-enter the loop.

**Alternatives considered**:

- _Per-reviewer login list_ (`AUTOMATED_REVIEWER_LOGINS` + per-reviewer wait): rejected by the maintainer — too much config surface, drifts silently when reviewer set changes.
- _15-minute global margin_: no headroom for tail-latency days.
- _No barrier_: the structural bug we are fixing.
- _Wait indefinitely until any review observed_: violates SC-002 if no reviewer ever responds.

**Configurable via env**:

- `REVIEW_BARRIER_SAFETY_MARGIN_MS` (default `1200000` = 20 min) — single global margin.

No reviewer-list env var exists.

---

## R4. Root-cause signature derivation

**Decision**: Two-tier signature.

- **Tier 1 (cheap, deterministic)**: `sha256(check_name + ":" + first_error_line_normalized).slice(0, 16)` where `first_error_line_normalized` strips line/column numbers, file paths within the repo prefix, and ANSI escapes; preserves error type and message body.
- **Tier 2 (fallback for unstructured failures)**: `sha256(check_name + ":" + workflow_run_conclusion + ":" + last_50_lines_normalized).slice(0, 16)` if Tier 1 yields no extractable error line.

The signature ledger keys on `(intent_id, signature) → attempts`. Cap is `FIX_ATTEMPTS_PER_SIGNATURE_CAP` (default 3, env-configurable).

**Rationale**:

- Tier 1 is precise: same lint rule violation on different lines collapses to one signature, which is correct (the bot already attempted that fix).
- Tier 1 is wrong for unstructured failures (panic dumps, infrastructure errors). Tier 2 catches those by hashing a tail window.
- 16 hex chars (64 bits) gives ~1 collision per 4 billion signatures within an intent — collisions on a single PR are statistically zero.
- Normalization (strip line numbers, repo paths, ANSI) prevents trivial differences from defeating the signature.

**Alternatives considered**:

- _Hash full log_: defeats the purpose; identical semantic failures hash differently if a single timestamp differs.
- _AI-derived clustering_: high cost per probe; non-deterministic; deferred as a future optimization if Tier 1+2 prove insufficient.
- _Per-test-id signature_: only works for test failures. Tier 1 generalizes.

**Implementation note**: `src/workflows/ship/signature.ts` exposes `deriveSignature(checkRun: CheckRun, logs: string): { signature: string; tier: 1 | 2 }`. Tested with a fixture matrix of failure outputs (ESLint, TypeScript, Bun test failure, Docker build error, OOM kill).

---

## R5. Continuation `state_blob` shape and versioning

**Decision**: Discriminated-union JSON shape, validated by Zod, persisted as `JSONB` with a numeric `state_version` column.

```typescript
type StateBlobV1 = {
  v: 1;
  iteration_n: number;
  last_seen_head_sha: string;
  last_seen_base_sha: string;
  last_probe_verdict: NonReadinessReason | null;
  last_coderabbit_comment_id: number | null;
  last_push_at: string; // ISO8601
  fix_attempts_summary: { signature: string; attempts: number }[];
};
```

Future shape changes bump `v` to 2 and add a migration in the same PR that introduces the new shape; the loader switches on `v` and refuses to load `v` values it doesn't know.

**Rationale**:

- Shape WILL evolve (note §10.5). Versioning from day one prevents the "JSONB without schema" trap.
- Zod validation on load means a corrupt or out-of-date blob fails fast at the resume point with a clear error, not silently with `undefined.field`.
- Per-version loaders give a clean migration path: ship a v1 → v2 in-place upgrader when the shape changes.
- `state_version` as a separate INT column lets you query/index versions without parsing JSONB.

**Alternatives considered**:

- _Separate columns per field_: rigid, requires migration for every field add.
- _Plain JSON without zod validation_: works until the first corrupt blob; then debugging is unbearable.
- _Versioning in JSON only (no separate column)_: harder to query "how many intents are still on v1?" without `JSONB ->> 'v'`.

---

## R6. Webhook event subscription set for the reactor

**Decision**: Subscribe to **5 webhook event types**:

1. `pull_request` — only the `synchronize` action (push to head ref) and `closed` action (PR closed/merged externally).
2. `pull_request_review` — `submitted` action (any review submission).
3. `pull_request_review_comment` — `created`, `edited`, `deleted` actions (thread mutations).
4. `check_run` — `completed` action only (covers per-job CI signal).
5. `check_suite` — `completed` action only (covers aggregate CI signal).

Reactor matches by `(installation_id, owner, repo, pr_number)` against active intents and re-enqueues their continuations to a `wake_at = now()` slot, jumping the cron tickle queue.

**Rationale**:

- These are exactly the 5 events that change one of the inputs to `MergeReadiness`. Other events (label, review_request, assigned, etc.) don't change the verdict and would be noise.
- `check_suite.completed` is included alongside `check_run.completed` because some CI providers emit only suite-level signals on aggregate completion.
- `pull_request.closed` is the reactor's signal to terminate active intents with `SessionTerminalState = pr_closed` (merged externally) or `pr_closed` (just closed) — distinguishable by `merged: true/false` in the payload.
- Restricting to specific actions per event type cuts webhook volume and reactor work.

**Alternatives considered**:

- _Subscribe to all PR-related events_: needless processing, cost.
- _Polling instead of reactor_: rejected by spec (Out of Scope), wasteful, slow.
- _Adding `status` event_: superseded by `check_run` for modern CI providers; no need.

**Configuration**: GitHub App installation manifest must include these event subscriptions. Documented in `docs/SETUP.md` update (same-PR per Constitution VIII).

---

## R7. Cron-tickle frequency: per-intent or global?

**Decision**: **Single global tick** at `CRON_TICKLE_INTERVAL_MS` (default 15s). Per-intent `wake_at` lives in the Valkey sorted set; the global tick selects all intents whose `wake_at <= now`.

**Rationale**:

- Per-intent timers add complexity (cancellation, restart-safety, leak detection) for zero correctness win — a 15s global granularity is well within tolerance.
- Aligns with note §12.Q6 (open question deferred); chose simpler global-tick after weighing operational complexity vs marginal latency win of per-intent timers.
- Re-enqueue from webhook reactor (R6) gives near-instant wake when state actually changes; the cron tickle is the backstop for missed webhooks and `mergeable_pending` retries.

**Alternatives considered**:

- _Per-intent timer_: extra code, extra failure modes. Deferred unless 15s granularity proves insufficient.
- _Tick frequency derived from intent's `wait_for` set_: overengineered for this stage.

---

## R8. Cutover plan: existing in-process `ship` loop → new continuation-based architecture

**Decision**: Feature-flagged cutover per phase. Three flags total.

- **P1**: probe runs alongside existing loop; ship terminal condition switches to probe verdict but loop body unchanged. Behind `SHIP_USE_PROBE_VERDICT` (default `false` initially, flipped to `true` after smoke testing).
- **P2**: intents are written by ship handler regardless of loop architecture (observability-only initially).
- **P3**: continuation-based loop replaces in-process loop. Behind `SHIP_USE_CONTINUATION_LOOP` (default `false`); when enabled, the legacy in-process `REVIEW_RESOLVE_MAX_ITERATIONS` path is bypassed.
- **P3 trigger surfaces (FR-025/026/027)**: NL intent classifier and label trigger paths land additively; literal `bot:<verb>` comment surface remains the always-on default. Behind `SHIP_USE_TRIGGER_SURFACES_V2` (default `false`); when enabled, comments are routed through the trigger-router which fans literal/NL/label inputs into one canonical command record. Recommended cutover ordering: probe-verdict first (deepest semantic change), continuation-loop second (architecture flip), trigger-surfaces last (additive surface — lowest blast radius if rolled back).
- **P4–P7**: each new capability gated behind its own env flag for the first deploy, then flag removed in a follow-up PR after one week of clean operation.

**Rationale**:

- Each phase is genuinely shippable in isolation (per spec §11) but the live system must not regress while phases land.
- Feature flags let the operator roll back instantly if a phase misbehaves in production without reverting code.
- Flag removal in follow-up PRs (one week later) keeps `src/config.ts` from accumulating dead flags long-term.

**Alternatives considered**:

- _Big-bang cutover after P7_: incompatible with phased delivery's value (early signal on each phase).
- _Branch-by-abstraction without flags_: harder to roll back; flags are the cheaper safety net for a one-week soak.

---

## R9. Probe-correctness defense (verdict snapshot)

**Decision**: Every probe iteration writes a complete `verdict_json` snapshot to `ship_iterations` (FR-024). The snapshot captures the GraphQL response payload verbatim plus the derived `MergeReadiness` verdict and the chosen `NonReadinessReason` (or `null` if `ready`). Storage is `JSONB` indexed by `(intent_id, iteration_n)`.

The offline reconciler that scans for false-ready cases (note §10.8) is **deferred to post-v1**. The snapshot guarantees the data is there when the reconciler is justified.

**Rationale**: Already settled by spec Q (round 2): snapshot now, reconcile later when there's data showing it's needed. Storage cost is small (~5 KB per iteration × 10 iterations × 100 PRs/month = ~5 MB/month — negligible for Postgres).

**Alternatives considered**: All weighed in spec round-2 Q&A; this is the chosen Option B.

---

## R10. Tracking comment: stable marker design

**Decision**: HTML comment marker `<!-- ship-intent:{intent_id} -->` placed at the **top** of the tracking comment body. Locator function does an REST API list-comments call against the PR, filters by author (the bot's GitHub App login) AND substring match on the marker, and asserts uniqueness.

**Rationale**:

- HTML comments are invisible in rendered Markdown but trivially searchable.
- `intent_id` (UUID) in the marker means even if the operator manually deletes the row from `ship_intents`, the bot won't accidentally edit a stale comment from a previous intent.
- Asserting uniqueness defends against "two markers found" bugs (would indicate a bot-side concurrency error worth surfacing loudly).
- Author filter prevents matching against a human pasting the marker by accident.

**Alternatives considered**:

- _Store comment_id in `ship_intents.tracking_comment_id`_: still needed (it's faster) — the marker is the fallback for restart cases where the DB row is correct but the cached comment_id is stale (e.g., comment manually deleted).
- _Special label on the PR_: doesn't survive iteration history; not granular enough.

**Implementation**: stored alongside the comment_id in `ship_intents.tracking_comment_id`. On resume, prefer the cached id; fall back to marker scan if the cached id 404s.

---

## R11. Cooperative cancellation token

**Decision**: A `CancellationToken` interface that any ship/-subsystem function accepts as an optional parameter; checks at well-defined safe-checkpoint locations (start of each iteration, before any push, before any GraphQL mutation, before tracking-comment update). Implementation backed by a single per-intent flag in Valkey (`ship:cancel:{intent_id}`) that is set by the abort handler and cleared on terminal transition.

**Rationale**:

- Fully cooperative — no thrown errors mid-write — preserves invariants (no half-finished pushes, no orphaned tracking comments).
- Single flag in Valkey means abort is O(1) and visible across processes.
- Safe-checkpoint discipline matches FR-011's "next safe checkpoint" wording and SC-005's "100% of cases".

**Alternatives considered**:

- _Throw a `CancelledError`_: risks leaving partial state if thrown between read-modify-write halves.
- _Polling DB column for `status='aborting'`_: works but adds DB load; Valkey flag is cheaper.

---

## Summary

All 11 unknowns are resolved with concrete decisions, default values, and configurable env knobs where applicable. No `NEEDS CLARIFICATION` markers remain. Phase 0 complete.

| Decision                                          | Default             | Env knob                                                                                |
| ------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------- |
| Cron tickle interval                              | 15 s                | `CRON_TICKLE_INTERVAL_MS`                                                               |
| `mergeable=null` backoff                          | `[5,10,30,60,60]` s | `MERGEABLE_NULL_BACKOFF_MS_LIST`                                                        |
| Review-barrier safety margin (any non-bot review) | 20 min              | `REVIEW_BARRIER_SAFETY_MARGIN_MS`                                                       |
| Fix-attempts per signature                        | 3                   | `FIX_ATTEMPTS_PER_SIGNATURE_CAP`                                                        |
| Wall-clock per session                            | 4 h                 | `MAX_WALL_CLOCK_PER_SHIP_RUN`                                                           |
| Phase rollout flags                               | off → on            | `SHIP_USE_PROBE_VERDICT`, `SHIP_USE_CONTINUATION_LOOP`, `SHIP_USE_TRIGGER_SURFACES_V2`. |

Phase 1 outputs follow: [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md).
