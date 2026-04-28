# Contract: Bot Commands

**Phases**: `bot:ship` modified throughout P1–P5; `bot:abort-ship` introduced in P6. Trigger-surface parity (NL + label) added in US1 (router) + US4 (abort/stop/resume routing) per FR-025/025a/026/026a/027/028.
**Modules**: `src/workflows/ship/trigger-router.ts` (canonical entry), `src/workflows/ship/nl-classifier.ts` (NL surface), `src/workflows/ship/label-trigger.ts` (label surface), `src/workflows/orchestrator.ts` (legacy literal-comment parser; flag-gated), `src/workflows/handlers/ship.ts` (ship), `src/workflows/ship/abort.ts` (abort).

This document defines the user-facing command syntax. Every command MUST be invokable through three functionally-equivalent surfaces (FR-018 + FR-027): literal `bot:<verb>` PR comment, natural-language phrasing prefixed with the configured trigger-phrase mention, and addition of the matching GitHub label. The `SHIP_USE_TRIGGER_SURFACES_V2` env flag (default `false`) gates the NL and label paths for safe rollout; literal-comment parsing remains the always-on default.

---

## Trigger surface parity (FR-027)

The three surfaces converge on a single `CanonicalCommand` record and route through one handler entry point. There is no per-surface behaviour gap: every command works identically across all three; the `surface` field on the canonical record exists for observability (FR-016) only.

```ts
type CanonicalCommand = {
  intent: "ship" | "stop" | "resume" | "abort";
  deadline_ms?: number;
  surface: "literal" | "nl" | "label";
  principal_login: string; // comment.user.login (literal/nl) | sender.login (label)
  pr: { owner: string; repo: string; number: number; installation_id: number };
};
```

### Surface 1 — Literal `bot:<verb>` comment (always available)

```text
@chrisleekr-bot bot:ship [--deadline <duration>]
```

Mention prefix optional for the literal surface (the `bot:` prefix is itself unambiguous). Parsed by inline regex in the orchestrator when `SHIP_USE_TRIGGER_SURFACES_V2=false`, or routed via `trigger-router.routeTrigger({surface:'literal', ...})` when the flag is on.

### Surface 2 — Natural-language with mention prefix (FR-025 + FR-025a)

```text
@chrisleekr-bot ship this PR please, deadline 2 hours
```

The mention prefix is **mandatory** on this surface — it is the FR-025a guard against false-positive triggering on conversational comments. Comments without the configured `TRIGGER_PHRASE` (default `@chrisleekr-bot`) are dropped before any LLM call. Only the substring after the first mention is sent to the classifier.

The classifier (single-turn Bedrock via `src/ai/llm-client.ts`) returns:

```json
{ "intent": "ship", "deadline_ms": 7200000 }
```

`intent: "none"` is a valid and common response on free-form comments (e.g., `@chrisleekr-bot thanks for the help`); it MUST result in zero handler invocation and zero reply.

Examples (all assume the mention prefix is present):

| Phrasing                     | Classifier output                      |
| ---------------------------- | -------------------------------------- |
| `ship it please`             | `{intent:'ship'}`                      |
| `ship with 2h deadline`      | `{intent:'ship', deadline_ms:7200000}` |
| `give it 30 mins to wrap up` | `{intent:'ship', deadline_ms:1800000}` |
| `stop the bot`               | `{intent:'stop'}`                      |
| `abort everything`           | `{intent:'abort'}`                     |
| `thanks for the help`        | `{intent:'none'}`                      |

### Surface 3 — GitHub label (FR-026 + FR-026a)

Recognised label names — each command has its own label:

| Command        | Label            | Override-suffix syntax                          |
| -------------- | ---------------- | ----------------------------------------------- |
| Start session  | `bot:ship`       | `bot:ship/deadline=2h`, `bot:ship/deadline=30m` |
| Pause session  | `bot:stop`       | (no overrides)                                  |
| Resume session | `bot:resume`     | (no overrides)                                  |
| Abort session  | `bot:abort-ship` | (no overrides)                                  |

Triggers fire on the `pull_request.labeled` webhook action **only**. The `unlabeled` action is ignored — removing a label does NOT issue any command (`bot:stop` requires its own label).

After acting on a `labeled` event (whether the action was to start, reject as ineligible per FR-015, reject as already-in-progress per FR-007a, or reject as unauthorised per FR-028), the bot MUST self-remove the triggering label via GraphQL `removeLabelsFromLabelable` (or REST equivalent). This makes label re-application the supported re-trigger mechanism. Override suffixes are parsed deterministically — no LLM is invoked on the label surface.

---

---

## `bot:ship` — Start a shepherding session

### Syntax

```text
@chrisleekr-bot bot:ship [--deadline <duration>]
```

| Argument     | Type            | Required | Default                                        | Notes                                                                                       |
| ------------ | --------------- | -------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `--deadline` | duration string | optional | `MAX_WALL_CLOCK_PER_SHIP_RUN` env (default 4h) | Per-invocation override. Examples: `2h`, `30m`, `1h30m`. Validated by Zod; max value `24h`. |

Notable absences (deliberate per spec clarifications):

- No `--auto-merge` or `--merge` flag (FR-008 forbids auto-merge).
- No `--budget` USD flag (Q3-round1: USD is observability-only, not enforced).

### Behavior

1. Parse the command; reject malformed args with a comment quoting the command and explaining the syntax.
2. Verify the comment author is in `ALLOWED_OWNERS` or is another bot composite workflow within the same installation. (Per FR-018.)
3. Verify the PR is eligible per FR-015 (not on a fork, not already closed/merged, target branch not forbidden).
4. Attempt to insert a `ship_intents` row. The partial unique index enforces FR-007a:
   - On unique-violation, find the existing active intent and reply: _"Already shepherding this PR (session `<intent_id>`, started `<timestamp>`). Comment `@chrisleekr-bot bot:abort-ship` to stop."_
   - On success, post the initial tracking comment with marker `<!-- ship-intent:{id} -->`, write the comment id back to `ship_intents.tracking_comment_id`, and enqueue the first iteration.
5. Return.

### Response artifact

A tracking comment on the PR (FR-006) with at minimum:

- The marker.
- Session id.
- Trigger source (login).
- Deadline timestamp.
- Current phase (initially `probing`).
- Last action (initially `session created`).
- Iteration count (initially 0).
- USD spent (initially 0.00).
- A "How to abort" hint (`@chrisleekr-bot bot:abort-ship`).

---

## `bot:abort-ship` — Stop the active shepherding session

### Syntax

```text
@chrisleekr-bot bot:abort-ship
```

No arguments.

### Behavior

1. Parse the command. Verify the comment author is in `ALLOWED_OWNERS`. (Anyone-can-abort would be a denial-of-service vector; restricted to authorised humans.)
2. Find the active intent for this PR. If none exists, reply: _"No active shepherding session on this PR."_
3. Set the Valkey cancellation flag: `SET ship:cancel:<intent_id> 1 EX 3600`.
4. Wait briefly (≤ 2 s) for the next safe-checkpoint to complete by polling `ship_intents.status`. If the intent has transitioned to `aborted_by_user`, reply with confirmation. If it has not within 2 s (because no checkpoint is in progress), force the transition:
   - `UPDATE ship_intents SET status = 'aborted_by_user', terminal_blocker_category = 'stopped-by-user', terminated_at = now()`.
   - `DELETE FROM ship_continuations WHERE intent_id = ...`.
   - `ZREM ship:tickle <intent_id>`.
5. Update the tracking comment with the terminal state and reply with a confirmation comment.

### Safety guarantee

SC-005: 100% of cases — zero further mutating actions after the cancellation flag is set. Implementation: every mutating function in `src/workflows/ship/*` checks the cancellation flag at start of operation and skips with no side effects if set.

### Response artifact

A reply comment confirming the abort, plus the tracking comment updated to show:

- Terminal state: `aborted_by_user`.
- Blocker category: `stopped-by-user`.
- Last action: `aborted by <login>`.
- Final iteration count and USD spent.

---

## Alias / forward-compatibility

Both commands accept a future renamed prefix without breaking existing usage:

- `bot:ship` and `bot:shepherd` are aliases (both parse to the ship handler).
- `bot:abort-ship`, `bot:abort-shepherd`, `bot:stop-shepherd` are aliases.

This is to support the open spec terminology question (`Shepherding Session` vs `ship_intent`) without forcing a one-time rename across user docs.

---

## Tests

`test/workflows/ship/abort.test.ts` MUST cover:

1. Authorised user issues `bot:abort-ship` while session active → terminates with confirmation.
2. Unauthorised user issues `bot:abort-ship` → command rejected with explanation; intent unchanged.
3. `bot:abort-ship` on PR with no active session → "no active session" reply; no DB write.
4. Cancellation flag set; no in-progress checkpoint → forced transition path.
5. Cancellation flag set; in-progress checkpoint completes within 2s → cooperative transition path.
6. Re-running `bot:abort-ship` on already-aborted session → idempotent reply, no error.
7. Authorisation check against `ALLOWED_OWNERS` matches existing trust model.

`test/workflows/handlers/ship.test.ts` MUST cover (relevant new behavior only):

1. `bot:ship` with no args → creates intent with default deadline.
2. `bot:ship --deadline 2h` → creates intent with custom deadline.
3. `bot:ship --deadline 25h` → rejected (max 24h).
4. `bot:ship` while session active → "already in progress" reply; no second insert.
5. `bot:ship` from unauthorised user → rejected.
6. `bot:ship` on closed PR → declined with FR-015 reason.
7. `bot:ship` on fork PR → declined with FR-015 reason.

---

## `bot:stop` — Pause an active shepherding session (reversible, NON-terminal)

### bot:stop Syntax

Three functionally-equivalent surfaces (FR-011 + FR-027):

```text
@chrisleekr-bot bot:stop
```

Or natural language with mention prefix: `@chrisleekr-bot pause for now`.
Or label: add the `bot:stop` label to the PR.

No arguments.

### bot:stop Behavior

1. Parse the command via `trigger-router.routeTrigger(...)` (T028a).
2. Verify the principal is in `ALLOWED_OWNERS` per FR-028. On unauthorised, reply with the documented rejection; if surface was `'label'`, self-remove the label per FR-026a; return.
3. Find the intent for this PR. If none exists, reply _"No active shepherding session on this PR."_ If status is already `paused`, reply _"Session already paused. Comment `@chrisleekr-bot bot:resume` to continue."_ If status is terminal, reply with the terminal state and instruct the maintainer that a fresh `bot:ship` is required. In all three cases, self-remove the label if applicable, and return.
4. Set the Valkey cancellation flag: `SET ship:cancel:<intent_id> 1 EX 3600`.
5. Wait briefly (≤ 2 s) for the next safe-checkpoint to complete by polling `ship_intents.status`. If status transitions to `paused`, reply with confirmation. If it does not within 2 s (no checkpoint in progress), force the transition via `intent.pauseIntent(...)` — NOT `forceAbortIntent` — which performs `UPDATE ship_intents SET status = 'paused' WHERE id = ... AND status = 'active'` (the WHERE filter prevents stomping a concurrent terminal transition). Do NOT delete the continuation row; it is needed for resume.
6. Update the tracking comment with the paused state, last action, timestamp, and a _"Comment `@chrisleekr-bot bot:resume` to continue"_ hint.
7. If surface was `'label'`, self-remove the label per FR-026a.

### Difference from `bot:abort-ship`

`bot:stop` transitions to NON-terminal `paused` (resumable, continuation row preserved).
`bot:abort-ship` transitions to terminal `aborted_by_user` (final; continuation row deleted; new `bot:ship` required to restart).

### Reactor behaviour while paused

Webhook events still arrive for paused intents. The reactor MUST still process events that drive terminal transitions (`pull_request.closed`, foreign-push `synchronize`, `bot:abort-ship` from any surface) — pause is not a force-field against PR-state evolution. Signal-only events (`check_run.completed`, `pull_request_review.submitted`) on a paused intent MUST be no-ops (the cancellation flag silences mid-iteration mutations; the intent is not re-enqueued for early-wake while paused).

---

## `bot:resume` — Resume a paused shepherding session

### bot:resume Syntax

Three functionally-equivalent surfaces:

```text
@chrisleekr-bot bot:resume
```

Or natural language with mention prefix: `@chrisleekr-bot keep going`.
Or label: add the `bot:resume` label to the PR.

No arguments.

### bot:resume Behavior

1. Parse via `trigger-router.routeTrigger(...)`.
2. Verify principal is in `ALLOWED_OWNERS` per FR-028. On unauthorised, reply, self-remove label if applicable, return.
3. Find the intent for this PR. If status is NOT `paused` (already `active`, or any terminal state), reply with the current status and do nothing; self-remove label if applicable.
4. Verify no third-party push has happened to the PR head since pause: compare `head_commit.author.login` (from the latest `synchronize` webhook OR a fresh GraphQL fetch) against the bot's own App login. If a foreign push exists, transition to terminal `human_took_over` + `BlockerCategory='manual-push-detected'` per FR-010 INSTEAD of resuming, and reply with the explanation. (This is exactly the manual-push-detection path from FR-010 and T036b, surfaced now at the resume boundary.)
5. Clear the Valkey cancellation flag: `DEL ship:cancel:<intent_id>`.
6. Call `intent.resumeIntent(...)` to transition status `paused` → `active` via `UPDATE ship_intents SET status = 'active' WHERE id = ... AND status = 'paused'`.
7. Re-enqueue the continuation: `UPDATE ship_continuations SET wake_at = now() WHERE intent_id = ...` and `ZADD ship:tickle 0 <intent_id>`.
8. Update the tracking comment (`resumed at {timestamp} by {login}`).
9. If surface was `'label'`, self-remove the label per FR-026a.

### bot:stop and bot:resume Tests

`test/workflows/ship/stop-resume.test.ts` MUST cover:

1. Authorised user pauses active session → status transitions to `paused`; tracking comment updated; continuation row preserved.
2. Authorised user resumes paused session with no foreign push → status transitions to `active`; continuation re-enqueued at `now()`; cancellation flag cleared.
3. Resume after foreign push → transitions to terminal `human_took_over` + `manual-push-detected`, NOT to `active`; continuation row deleted.
4. Stop on already-paused session → no-op reply, no DB write.
5. Resume on already-active session → no-op reply, no DB write.
6. Stop/resume across all three surfaces (literal, NL, label) produce identical state transitions (FR-027 parity assertion).
7. Unauthorised principal rejected uniformly across all three surfaces (FR-028).
8. Pause then immediate stop again (idempotency) → second stop is a no-op.
9. Pause does NOT extend `deadline_at`; if deadline fires while paused, intent transitions to `deadline_exceeded` per the state machine in `data-model.md`.
10. Reactor on paused intent: `check_run.completed` is a no-op; `pull_request.closed merged=true` still transitions to `merged_externally`.
