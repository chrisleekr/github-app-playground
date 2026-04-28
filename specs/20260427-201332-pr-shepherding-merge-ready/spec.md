# Feature Specification: PR Shepherding to Merge-Ready State

**Feature Branch**: `20260427-201332-pr-shepherding-merge-ready`
**Created**: 2026-04-27
**Status**: Draft
**Input**: User description: "PR Shepherding to Merge-Ready State"

## Clarifications

### Session 2026-04-27

- Authoritative architecture: this spec adopts the architecture proposal in `~/Dropbox/Private Note/20260426_pr-shepherding-merge-ready-architecture.md` (composition S1+S3+S5 with `MergeReadiness` typed verdict). FR-008 (no auto-merge) and FR-018 (trigger model) are resolved against that note's §3 non-goals and §5 definition.
- Q: Single-active shepherding session per PR, or multiple? → A: Exactly one active session per PR. Any re-trigger while a session is active MUST be rejected with an "already in progress" response to the trigger source; concurrent sessions are not permitted.
- Q: When a cascade-retarget changes the PR's base ref mid-session, does the session abort or continue? → A: Continue under the new base. The session updates its recorded `target_base_sha`, re-runs the merge-readiness probe immediately against the new base, and keeps iterating. The session's deadline carries over unchanged.
- Q: How are the per-session budget and deadline configured, and is USD enforced? → A: Wall-clock deadline is the only hard enforcement (per-installation env default, default 4 hours, overridable per-invocation via trigger flag). USD spend is recorded per iteration and surfaced in the tracking comment for observability, but the system MUST NOT terminate a session on USD overspend mid-run — partial work has already incurred cost and an abrupt kill yields no return on it. Other guards (per-iteration `AGENT_TIMEOUT_MS`, fix-attempts ledger, iteration cap, human stop, human-push detection) bound runaway risk structurally.
- Q: How does the bot handle CI flake before declaring `ready`? → A: Targeted re-run plus annotation. Before terminal `ready`, the bot identifies every _required_ check that has had at least one failure on the _current head SHA_ during the session and triggers a single re-run of each; terminal `ready` requires that re-run to pass on the current head. The tracking comment annotates every flake observed during the session (required and non-required) so the maintainer sees the full history before merging. Non-required check flakes never gate the verdict.
- Q: When the verdict is terminal `ready`, does the bot flip the PR from draft to ready-for-review? → A: Yes, always. If the PR is in `draft` state when the terminal `ready` verdict is reached, the bot MUST mark it ready-for-review as part of the terminal action. Rationale: the bot's contract is "drive the PR to a merge-ready state" end-to-end; leaving a verdict-`ready` PR in draft contradicts the verdict and invites human confusion. A maintainer who wants the PR to stay in draft after shepherding can manually flip it back; the default is to make the PR look as ready as the verdict says it is.
- Q: How are "halt reason" / "non-readiness reason" / "terminal state" enumerations decomposed? → A: Keep three orthogonal enumerations. (1) **`NonReadinessReason`** — per-iteration probe verdict reason (`failing_checks`, `open_threads`, `changes_requested`, `behind_base`, `mergeable_pending`, `pending_checks`, `human_took_over`); drives the next iteration's action. (2) **`SessionTerminalState`** — how the session ended (`merged_externally`, `ready_awaiting_human_merge`, `deadline_exceeded`, `human_took_over`, `aborted_by_user`, `pr_closed`); the value `ship_intents.status` settles to. (3) **`BlockerCategory`** — human-readable display category for the tracking comment (`design-discussion-needed`, `manual-push-detected`, `iteration-cap`, `flake-cap`, `merge-conflict-needs-human`, `permission-denied`, `stopped-by-user`, `unrecoverable-error`). The three sets are related but not collapsible: a session can return `failing_checks` (NonReadinessReason) 12 times, surface `flake-cap` (BlockerCategory) in the tracking comment, and finally settle to `deadline_exceeded` (SessionTerminalState).
- Q: How does the spec defend against a false-ready probe verdict (probe says `ready` when the conjunction is actually unsatisfied — bot declares ready, human merges, `main` breaks)? → A: Require the probe to persist its full input snapshot per iteration, defer the offline reconciler to a later phase. Each iteration MUST write the complete probe input (mergeable, mergeStateStatus, full check_runs matrix on the head SHA, review-thread states, reviewDecision, recorded base SHA, head SHA authorship) to a per-iteration JSON column. This unlocks any future reconciler design (e.g., a scheduled scan that flags sessions ending `ready_awaiting_human_merge` whose PR did not subsequently merge cleanly within a window). The reconciler itself is out of scope for v1 — building it before the probe has run in production is designing without data; the snapshot guarantees the data will be there when the reconciler is justified.
- Q: Operator-facing surface for cross-session visibility — custom dashboard, or rely on existing observability stack? → A: Tracking comment per session (FR-006) + structured logs and metrics (FR-016) only. No custom dashboard in v1. Cross-session aggregate view is via the existing observability stack (Datadog via pup, log queries, ad-hoc DB queries). A custom dashboard is deferred until evidence exists that the per-session tracking comment plus structured telemetry are insufficient.
- Q: Is the reviewer-latency barrier (FR-023) tied to CodeRabbit specifically, or generic across any automated reviewer? → A: Reviewer-agnostic with no reviewer list at all. The system MUST NOT maintain a configurable list of reviewer logins. Instead, the barrier waits for _any_ non-bot review against the current head SHA, OR for a single global safety margin to elapse since the most recent push. One env var (`REVIEW_BARRIER_SAFETY_MARGIN_MS`) controls the margin. The barrier never references a specific reviewer's identity in code, env-var names, module names, prompts, or logs. Trade-off accepted: on PRs with slow auto-reviewers the bot may declare ready before nitpicks arrive; the human can re-trigger `bot:ship` to re-enter the loop in that case.
- Q: Which commands should be invokable via natural language and label in addition to the literal `bot:<verb>` syntax? → A: All commands, including override flags. Every command in the shepherding surface — `bot:ship`, `bot:stop`, `bot:resume`, `bot:abort-ship`, plus override flags such as `--deadline <duration>` — MUST be invokable through the literal command syntax, through a natural-language phrasing routed to the same handler, AND through a per-command GitHub label. The three surfaces are functionally equivalent; whichever fires first wins, subsequent fires within the same session collapse under the existing single-active-session rule (FR-007a).
- Q: How is a natural-language trigger parsed into the structured command + override set? → A: A single-turn LLM intent classifier reusing the existing Bedrock adaptor (`src/ai/llm-client.ts`). The classifier returns a fixed JSON schema `{intent: 'ship' | 'stop' | 'resume' | 'abort' | 'none', deadline_ms?: number, ...}`. Output of the classifier is the canonical command record passed to the handler — there is no separate post-classifier parse step. Cost and latency live within the existing single-turn classification envelope; `intent: 'none'` is a valid and common return on free-form comments.
- Q: How does the GitHub-label trigger surface behave on `labeled` vs `unlabeled` events, and how is re-triggering handled? → A: One-shot trigger on `labeled` only. Each command has its own label (`bot:ship`, `bot:stop`, `bot:resume`, `bot:abort-ship`). The `unlabeled` event is ignored — removing the label does NOT issue `bot:stop` or any other command. Once the bot has acted on the `labeled` event (or rejected the trigger as ineligible / already-in-progress), it MUST remove the label from the PR itself, leaving the label history in GitHub's audit trail and freeing the label for re-application. Re-applying the same label after self-removal is the supported re-trigger mechanism. Override flags via label are encoded in the label's name suffix (e.g., `bot:ship/deadline=2h`) and parsed deterministically — no LLM is invoked on labels.
- Q: Do label and natural-language triggers inherit the same `ALLOWED_OWNERS` authorisation gate as the literal `bot:<verb>` command? → A: Identical gate across all three surfaces. The gate is applied to `sender.login` on `labeled` webhook events and to `comment.user.login` on `issue_comment` / `pull_request_review_comment` events. There is no per-command tiering (no "anyone can stop the bot"), no looser gate for labels relying on GitHub repo-write permission alone, and no stricter gate beyond the existing one. A principal who is not in `ALLOWED_OWNERS` MUST receive the same rejection regardless of which surface they used.
- Q: What guard prevents the natural-language classifier from firing on conversational PR comments that merely mention "ship" or "merge"? → A: A mention-prefix gate. The natural-language classifier is invoked ONLY for comments whose body contains `@chrisleekr-bot` (or the configured `TRIGGER_PHRASE` value); only the substring AFTER the mention is passed to the classifier. Comments without the mention prefix are dropped before the classifier runs — no LLM cost, no false-positive risk. The literal `bot:<verb>` command syntax remains accepted without a mention prefix (it is unambiguous on its own); labels do not require a mention prefix because the label itself is the explicit signal. This concentrates the prompt-injection / false-positive surface onto the mention-gated NL path only.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Drive a stuck PR to merge-ready (Priority: P1)

A maintainer opens or updates a pull request, then asks the bot to shepherd it. The bot iterates through the PR's open work — failing CI checks, unanswered review comments, stale rebases — and drives the PR toward a state where every required check is green, every actionable review thread is addressed, and the PR shows a clean mergeable state to a human reviewer who only needs to click "merge."

**Why this priority**: This is the core value proposition. Maintainer time is currently spent in a slow loop: read CI failure, push fix, wait, read review comment, push fix, wait. Off-loading this loop to the bot is what the feature exists to do.

**Independent Test**: Open a PR with a deliberate lint failure and one review comment that asks for a renamed variable. Trigger shepherding. Verify the bot pushes a commit fixing the lint, replies to the review thread with the rename, resolves the thread, waits for CI to re-run green, and updates a tracking comment to "merge-ready" — all without human keystrokes between trigger and merge-ready.

**Acceptance Scenarios**:

1. **Given** a PR with a failing lint check and no review comments, **When** the maintainer triggers shepherding, **Then** the bot pushes a commit that resolves the lint failure, waits for CI to go green, and reports merge-ready in the tracking comment.
2. **Given** a PR with green CI and one unresolved CodeRabbit nitpick that requests a JSDoc edit, **When** the maintainer triggers shepherding, **Then** the bot edits the JSDoc, pushes the change, replies to the review thread, resolves the thread, and reports merge-ready.
3. **Given** a PR that is already merge-ready, **When** the maintainer triggers shepherding, **Then** the bot detects the no-op state, posts a single tracking comment confirming merge-ready, and exits.

---

### User Story 2 - Halt safely when shepherding is the wrong tool (Priority: P1)

Some PR obstacles cannot be cleared by a bot — a reviewer requested a different architectural approach, a security-sensitive file changed, the PR target branch was rewritten, the maintainer pushed a manual commit mid-cycle. The bot must recognise these conditions, stop iterating, and hand back to a human with a clear explanation, rather than thrashing or guessing.

**Why this priority**: A shepherding bot that silently makes the wrong call is worse than no bot. The cost of an unsafe action (force-push, merge over a thread, "fix" that destroys reviewer intent) is high. This story is what makes the P1 story safe to ship.

**Independent Test**: Trigger shepherding on a PR where the latest review comment says "please redesign this — let's discuss." Verify the bot does not push a code change, posts a tracking comment that names the obstacle and the next human action required, and stops iterating.

**Acceptance Scenarios**:

1. **Given** a review comment that requests a design discussion (e.g., "let's talk about this approach"), **When** the bot processes the thread, **Then** it does not push code, marks the thread as needing-human, and reports halted-pending-human in the tracking comment.
2. **Given** the maintainer pushes a manual commit while shepherding is in flight, **When** the bot's next iteration begins, **Then** it detects the foreign commit, pauses without overwriting, and asks the maintainer in the tracking comment whether to resume.
3. **Given** a PR where shepherding has already attempted the same fix N times and CI keeps failing the same check, **When** the iteration cap is reached, **Then** the bot stops, surfaces the stuck check in the tracking comment, and does not push another attempt.

---

### User Story 3 - Visible, resumable progress (Priority: P2)

A maintainer should be able to glance at the PR and know exactly what the bot is doing, what it has already done, what it tried and gave up on, and whether they need to act. If the bot's process restarts mid-cycle, it should pick up where it left off rather than starting over or duplicating work.

**Why this priority**: Without visible state, maintainers will not trust the bot enough to leave it running. Without resumability, an OOM kill or restart silently abandons work and creates duplicate comments.

**Independent Test**: Trigger shepherding, kill the bot process mid-iteration, restart it. Verify the bot resumes against the same PR using the existing tracking comment, does not create a duplicate tracking comment, and continues from the next pending action.

**Acceptance Scenarios**:

1. **Given** shepherding is running on a PR, **When** a maintainer opens the PR, **Then** there is exactly one bot tracking comment showing the current phase, the last action taken, the next action queued, and a timestamp.
2. **Given** a shepherding run is interrupted, **When** the bot restarts, **Then** it locates the existing tracking comment by stable marker, reads the last persisted state, and resumes from the next un-completed step without creating a duplicate comment.
3. **Given** two trigger requests arrive for the same PR within a short window, **When** the second one is processed, **Then** the bot recognises shepherding is already in flight and does not start a parallel run.

---

### User Story 4 - Maintainer override (Priority: P2)

A maintainer must be able to stop, pause, or hand control back to themselves at any moment with a single comment, without race conditions where the bot pushes one more commit after the stop instruction.

**Why this priority**: This is the safety valve. Maintainers will not adopt the feature without it; one bad experience of the bot continuing after "stop please" destroys trust permanently.

**Independent Test**: While shepherding is mid-iteration, post a stop comment on the PR. Verify the bot completes any push it has already started but performs no further pushes, replies, or thread resolutions, and updates the tracking comment to halted-by-user.

**Acceptance Scenarios**:

1. **Given** shepherding is iterating, **When** a maintainer posts a stop command on the PR, **Then** the bot stops at the next safe checkpoint and updates the tracking comment to halted-by-user.
2. **Given** shepherding is halted-by-user, **When** the maintainer posts a resume command, **Then** the bot resumes from the next pending step.

---

### Edge Cases

- The PR target branch advances (or is force-rewritten) while shepherding is mid-cycle, and the working branch needs a rebase or merge before CI can run cleanly.
- The PR's base ref is changed by a cascade-retargeting workflow mid-session (e.g., a parent PR merged and the bot retargeted child PRs to `main`). The session continues under the new base ref and re-runs the probe against it, but a base ref that was rewritten in a non-fast-forward way must still be detectable so the probe verdict (`behind_base` / `merge-conflict-needs-human`) reflects reality.
- A required CI check is flaky: the same job fails, then passes, then fails again on identical content. The bot MUST trigger one targeted re-run of any required check that failed on the current head SHA before declaring `ready`, and MUST annotate the flake history in the tracking comment regardless of final pass/fail outcome.
- A reviewer leaves a new comment after the bot has already declared merge-ready — does the bot re-enter shepherding, or stay exited?
- The PR is closed or merged externally while shepherding is running.
- A required check is configured but never reports (stuck pending) — the bot must distinguish "still running" from "abandoned."
- A review thread is replied to by a third party between the bot reading the thread and posting its reply, creating an out-of-date reply.
- The bot's own commit re-triggers a CodeRabbit re-review, which posts new nitpicks — does shepherding loop on each new review round, and if so, with what termination guarantee?
- The PR has merge conflicts against the target branch that cannot be resolved without human judgment.
- The PR's required-check set changes mid-cycle (branch protection rule updated) — the bot's "all green" snapshot becomes stale.
- The bot lacks permission to push to the PR head ref (PR from a fork, or branch protection forbids bot pushes).

## Requirements _(mandatory)_

### Merge-Readiness Verdict (normative definition)

The system computes a single typed verdict, **`MergeReadiness`**, from observed GitHub state. The verdict is `ready` if and only if **all** of the following hold simultaneously:

1. GitHub reports `mergeable === true`.
2. GitHub reports `mergeStateStatus === 'clean'`.
3. Every _required_ check on the current head SHA has been reported and has `conclusion ∈ { success, neutral, skipped }`.
4. There are zero unresolved review threads.
5. `reviewDecision !== 'CHANGES_REQUESTED'`.
6. The session's recorded `target_base_sha` either matches the PR's current base ref, or has been re-snapshotted under the Q2 cascade rule.
7. The head SHA was authored by the bot, OR a human hand-off has been explicitly acknowledged.

The agent MUST NEVER self-declare `ready`. Only the probe computes `MergeReadiness` from observed state. Any non-`ready` verdict carries a structured non-readiness reason from a finite set (see _Halt Reason_ in Key Entities).

### Functional Requirements

- **FR-001**: The system MUST accept a shepherding trigger on a pull request from an authorised maintainer and begin a shepherding session for that PR.
- **FR-002**: The system MUST iterate over the PR's blockers — failing required checks, unresolved actionable review threads, missing rebase, conflicting target branch — and attempt to clear each in turn until either the PR is merge-ready or a halt condition is reached.
- **FR-003**: The system MUST attempt fixes for mechanical CI failures whose remediation is unambiguous from the failure output (formatter diffs, lint auto-fixes, type errors with a single clear correction, missing snapshot updates, generated-file drift).
- **FR-004**: The system MUST address review comments whose remediation is mechanical and explicitly stated in the comment (rename, JSDoc edit, dead-code removal, comment fix, narrow doc updates) and MUST NOT attempt code changes for review comments that request architectural discussion, design debate, or judgment calls.
- **FR-005**: The system MUST reply to every review thread it acts on with a comment that names what was changed and the commit SHA, then resolve the thread.
- **FR-006**: The system MUST maintain exactly one tracking comment per PR per shepherding session that shows current phase, last action, next queued action, iteration count, and last-updated timestamp.
- **FR-007**: The system MUST persist shepherding state (PR ref, last commit SHA observed, iteration count, current phase, halt reason) durably enough that a process restart resumes the same session against the same tracking comment without creating a duplicate.
- **FR-007a**: The system MUST permit at most one active shepherding session per PR. When a trigger arrives for a PR that already has an active session, the system MUST reject the new trigger with an explicit "already in progress" response to the trigger source (e.g., the maintainer's PR comment) and MUST NOT start a parallel session.
- **FR-008**: The system MUST refuse to perform a merge of the PR. Merging is always a human action. No auto-merge mode is offered — including no opt-in flag, no opt-in label, and no per-installation override. (Per architecture proposal 2026-04-26 §3 non-goals.)
- **FR-009**: The system MUST refuse to force-push, rewrite published commit history, delete branches it does not own, or modify protected branches directly.
- **FR-010**: The system MUST detect a manual push by a third party to the PR head between iterations and pause until the maintainer acknowledges, rather than rebasing over or overwriting human work.
- **FR-011**: The system MUST detect a stop or pause command from the maintainer through any of the three supported trigger surfaces (literal command, natural-language with mention prefix, or label) and transition the session's status from `active` to `paused` at the next safe checkpoint, performing no further mutating actions while paused. A resume command (also accepted across all three surfaces) MUST transition the session back from `paused` to `active` and re-enqueue the continuation. Pause is NON-terminal: a paused session is NOT in `SessionTerminalState` and may resume any number of times within the wall-clock cap (FR-012). Stop differs from abort: `bot:stop` is reversible (paused, resumable), `bot:abort-ship` is terminal (settles to `aborted_by_user`). The detection logic MUST treat the three surfaces as functionally equivalent for both stop and resume.
- **FR-012**: The system MUST cap each shepherding session by both iteration count and wall-clock duration; on cap, it MUST halt with a tracking-comment explanation rather than continuing.
- **FR-012a**: The wall-clock cap MUST be configurable per-installation via environment (default 4 hours) and overridable per-invocation via a trigger flag. The system MUST NOT enforce a USD cost cap that terminates a session mid-run; cost is recorded per iteration and surfaced in the tracking comment for observability only. Mid-run cost-based termination is explicitly forbidden because the spend has already been incurred when the cap fires and abandoning the partial work yields zero return on it.
- **FR-013**: The system MUST cap retries of an identical fix-attempt against an identical failure signature. The signature is a deterministic identifier derived from `(failing-check name, root-cause cluster)`, persisted in a per-session ledger keyed by `(session_id, signature) → attempts`. On cap, the system MUST halt the session and surface the stuck check rather than retry indefinitely. Retries against the same signature MUST be counted across iterations of the same session, not reset per iteration.
- **FR-014**: Before declaring terminal `ready`, the system MUST identify every _required_ check that has recorded at least one failure on the current head SHA during the session, trigger one re-run of each, and require that re-run to complete with a passing conclusion on the current head. If the re-run also fails, the verdict is `failing_checks` rather than `ready`. The system MUST NOT gate the verdict on flake of non-required checks.
- **FR-014a**: The system MUST record every check failure observed during the session (required and non-required) and surface a flake-history annotation in the tracking comment listing each check's failure count and final outcome, so the maintainer sees the full history before merging — even when the verdict reads `ready`.
- **FR-015**: The system MUST treat the PR as ineligible and decline to start shepherding when: the PR head is on a fork the bot cannot push to; the PR is already closed or merged; the PR author is not in the authorised set; the target branch is one the bot is forbidden from interacting with (e.g., `main` of a frozen release).
- **FR-016**: The system MUST emit structured logs and metrics for each shepherding session covering trigger source, PR id, phase transitions, iteration count, halt reason, and total cost (token spend, wall-clock).
- **FR-017**: The system MUST surface its own non-recoverable errors (network, API rate limit, internal exception) to the maintainer in the tracking comment with enough detail to act on, and MUST NOT silently die.
- **FR-018**: The system MUST start a session only when explicitly triggered on a PR through one of three functionally-equivalent surfaces: (a) the literal command `bot:ship` (with optional override flags such as `--deadline <duration>`) in a PR comment or review comment; (b) a natural-language phrasing in a PR comment or review comment that begins with the configured trigger-phrase mention (default `@chrisleekr-bot`) and is classified by the LLM intent classifier (FR-025) as `intent: 'ship'`; (c) addition of the `bot:ship` GitHub label (with optional override suffix such as `bot:ship/deadline=2h`) to the PR. The trigger source MUST be either an authorised human (per `ALLOWED_OWNERS`) or another bot composite workflow within the same installation, evaluated identically across all three surfaces. The system MUST NOT auto-start sessions on PR-open or any other passive event. PRs from external forks are ineligible because the bot cannot push to fork heads.
- **FR-019**: When the session reaches terminal `ready`, the system MUST mark the PR as ready-for-review if it is currently in `draft` state. The flip is part of the terminal action and is reflected in the tracking comment. The system still MUST NOT merge the PR (FR-008 unchanged); marking ready and merging are distinct actions and only the former is performed.
- **FR-020**: The system MUST NOT hold a daemon job slot while waiting for external state to change (CI completion, automated reviewer re-review, GitHub mergeability computation, scheduled re-poll). When the next session step depends on awaited external state, the system MUST persist a continuation record (next action, awaited signals, scheduled wake time) durably, release the daemon slot, and resume on either an early-wake signal (matching webhook event) or a scheduled tickle. In-process polling loops that hold a slot during waits are forbidden.
- **FR-021**: When GitHub returns `mergeable=null` (eventual-consistency window after a push, typically 5–30 seconds), the system MUST NOT treat that as a terminal verdict. It MUST re-poll on a bounded backoff schedule (short initial delay growing to longer intervals, with a finite maximum number of polls). After the maximum, the non-readiness reason is `mergeable_pending` and the session yields per FR-020 rather than declaring ready or failing.
- **FR-022**: The system MUST distinguish "all _expected_ required checks have reported and completed" from "all currently-reported checks are green." A required check that is configured for the PR but has not yet reported, or has reported as `in_progress` / `queued`, MUST NOT count toward `ready`; the non-readiness reason in that case is `pending_checks` and the session yields per FR-020.
- **FR-023**: Before declaring terminal `ready`, the system MUST verify that the most recent push has either (a) elicited at least one review on the current head SHA from a non-bot author (the App's own login is excluded), or (b) passed a single global safety margin (`REVIEW_BARRIER_SAFETY_MARGIN_MS`) since the push timestamp without any new review activity from any non-bot author. The system MUST NOT maintain a list of specific reviewer logins to wait for; the barrier is purely "any non-bot review OR margin elapsed". The implementation MUST NOT hardcode any reviewer's identity (specific reviewer names) in module names, env-var names, prompts, or logs. Trade-off: on PRs with slow auto-reviewers the bot may declare `ready` before nitpicks arrive — this is accepted as a known limitation; the human can re-trigger `bot:ship` to re-enter the loop.
- **FR-024**: Every probe iteration MUST persist its full input snapshot to a per-iteration JSON record. The snapshot MUST include, at minimum: GitHub `mergeable` value, `mergeStateStatus`, the full check_runs matrix on the head SHA (check name, conclusion, completion timestamp, required/non-required flag), review-thread states (id, isResolved), `reviewDecision`, the session's recorded `target_base_sha`, the current head SHA, and head-SHA authorship attribution. The snapshot exists to enable later post-merge reconciliation of probe verdicts; the reconciler itself is out of scope for v1.
- **FR-025**: The system MUST provide a natural-language trigger surface for every shepherding command (`bot:ship`, `bot:stop`, `bot:resume`, `bot:abort-ship`) and their override flags (e.g., `--deadline`). Natural-language parsing MUST be performed by a single-turn LLM intent classifier reusing the existing Bedrock adaptor in `src/ai/llm-client.ts`. The classifier MUST return a fixed JSON schema `{ intent: 'ship' | 'stop' | 'resume' | 'abort' | 'none', deadline_ms?: number }` (extensible for future override flags). A return of `intent: 'none'` MUST result in no action (no handler invocation, no reply). The classifier output is the canonical command record routed to the same handler as the literal command syntax — there MUST NOT be a divergent natural-language code path beyond the classifier itself.
- **FR-025a**: The natural-language classifier MUST be invoked ONLY for comment bodies that contain the configured trigger-phrase mention (default `@chrisleekr-bot`, sourced from the existing `TRIGGER_PHRASE` env var). Only the substring after the first occurrence of the mention is passed to the classifier. Comments without the mention prefix MUST be dropped before any LLM call; this is the sole guard against false-positive triggers on conversational PR comments. The literal `bot:<verb>` command syntax remains accepted without a mention prefix because it is unambiguous; labels also do not require a mention prefix because the label itself is the explicit signal.
- **FR-026**: The system MUST provide a GitHub-label trigger surface for every shepherding command. Each command MUST have its own label name: `bot:ship`, `bot:stop`, `bot:resume`, `bot:abort-ship`. Triggers fire on the `labeled` webhook event only. The `unlabeled` event MUST be ignored (removing a label does NOT issue any command — `bot:stop` requires its own label). Override flags MUST be encoded as deterministic suffixes on the label name (e.g., `bot:ship/deadline=2h`) parsed without LLM involvement; unparseable suffixes MUST be rejected with a maintainer-facing tracking-comment reply.
- **FR-026a**: After acting on a `labeled` event (whether the action was to start a session, reject as ineligible per FR-015, reject as already-in-progress per FR-007a, or reject as unauthorised per FR-028), the system MUST remove the triggering label from the PR. This makes re-application of the same label the supported re-trigger mechanism, leaves a clean audit trail in GitHub's label history, and prevents stale labels from accumulating on the PR after terminal state is reached.
- **FR-027**: The three trigger surfaces (literal command, natural language, label) MUST route into a single trigger-handler entry point and MUST NOT bifurcate downstream behaviour. Once parsed into the canonical command record, the surface of origin is recorded for observability (FR-016) but does not influence eligibility (FR-015), authorisation (FR-028), session uniqueness (FR-007a), or any other normative behaviour. The system MUST NOT introduce per-surface feature gaps (e.g., labels that cannot stop a session, NL that cannot pass `--deadline`).
- **FR-028**: The `ALLOWED_OWNERS` authorisation gate MUST be applied identically across all three trigger surfaces. The principal evaluated against `ALLOWED_OWNERS` MUST be: (a) `comment.user.login` for `issue_comment` and `pull_request_review_comment` events (covering both literal command and natural-language surfaces); (b) `sender.login` for `labeled` webhook events (covering the label surface). There MUST NOT be per-command authorisation tiering (e.g., a looser gate for `bot:stop` to allow "anyone can halt the bot"); a single uniform gate applies. Unauthorised triggers from any surface MUST receive the same rejection reply, and label-surface rejections MUST also self-remove the label per FR-026a.

### Key Entities _(include if feature involves data)_

- **Shepherding Session**: One end-to-end attempt to drive a single PR to merge-ready. Has a session id, the target PR id, a start timestamp, an end timestamp, a `SessionTerminalState`, an iteration count, and a `BlockerCategory` if the terminal state requires human follow-up. **Uniqueness**: at most one session per PR may be in the active state at any time.
- **Iteration**: One pass of the shepherding loop within a session. Records the snapshot of PR state observed (CI matrix, review threads, mergeability), the action taken (push commit, reply to thread, resolve thread, no-op wait), and the next action queued.
- **Tracking Comment**: The single canonical maintainer-visible artifact for a session. Identified by a stable marker so the bot can find it after restart without ambiguity.
- **NonReadinessReason**: The per-iteration probe verdict reason returned by the merge-readiness probe whenever `MergeReadiness.ready === false`. Finite set: `failing_checks`, `open_threads`, `changes_requested`, `behind_base`, `mergeable_pending`, `pending_checks`, `human_took_over`. Drives the next iteration's action selection.
- **SessionStatus**: The current value of a session's `ship_intents.status` column. Finite set: `active`, `paused`, plus the SessionTerminalState members below. `active` and `paused` are NON-terminal — a session may transition between them any number of times via `bot:stop` / `bot:resume` (FR-011). Only the SessionTerminalState members are terminal.
- **SessionTerminalState**: The terminal subset of SessionStatus a session settles into when it ends. Finite set: `merged_externally`, `ready_awaiting_human_merge`, `deadline_exceeded`, `human_took_over`, `aborted_by_user`, `pr_closed`. Every session MUST settle to exactly one of these; no session may end in an indeterminate state. Once a session reaches a terminal state, it MUST NOT transition back to `active` or `paused`; a fresh `bot:ship` trigger creates a new session.
- **BlockerCategory**: A human-readable display category surfaced in the tracking comment to explain _why_ a session is in its current phase or terminated. Finite set: `design-discussion-needed`, `manual-push-detected`, `iteration-cap`, `flake-cap`, `merge-conflict-needs-human`, `permission-denied`, `stopped-by-user`, `unrecoverable-error`. Independent of `NonReadinessReason` (the probe's machine-readable verdict reason) and `SessionTerminalState` (the session's terminal status).
- **Eligibility Rule**: The conditions a PR must satisfy for the bot to start a session against it.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: For PRs whose only blockers are mechanical (lint, format, type, narrow review-comment edits, rebase), the bot reaches merge-ready without human intervention in at least 80% of triggered sessions.
- **SC-002**: Median wall-clock from shepherding-trigger to merge-ready (for PRs that reach merge-ready) is under 30 minutes.
- **SC-003**: Zero shepherding sessions perform a destructive action against the repository (force-push, merge against unresolved threads, push over a manual commit, delete a branch).
- **SC-004**: 100% of shepherding sessions terminate with a `SessionTerminalState` from the finite set, paired (where applicable) with a `BlockerCategory` visible in the tracking comment — no session ends silently or in an indeterminate state.
- **SC-005**: When a maintainer issues a stop command, the bot performs zero further mutating actions in 100% of cases (measured at the next safe checkpoint, not strictly synchronous).
- **SC-006**: After a process restart mid-session, the resumed session attaches to the existing tracking comment and creates zero duplicate tracking comments in 100% of cases.
- **SC-007**: Average bot cost per shepherded PR (token spend converted to USD) is recorded for every session and visible in the tracking comment. There is no enforced USD ceiling; the metric exists so the maintainer can tune the wall-clock cap if cost trends prove unsustainable.
- **SC-008**: For sessions whose terminal `BlockerCategory` is `design-discussion-needed`, the maintainer agrees with the classification (i.e., the PR genuinely needed human design input) in at least 90% of cases — measured by maintainer review of halted sessions over the first month.

## Out of Scope (v1)

The following are explicitly excluded from the first delivery and are not addressed by any FR:

- **Auto-merging the PR.** Merging is always a human action (FR-008). No flag, label, or override.
- **Replacing CodeRabbit or any other external reviewer.** The bot integrates with reviewers; it does not substitute for them.
- **Driving PRs from external-contributor forks.** The bot lacks push permission to fork heads (FR-018).
- **Multi-PR coordination beyond the existing cascade-retargeting feature.** A session is bound to one PR. Group ship operations across a stack of PRs are out of scope.
- **Cross-repo and cross-org shepherding.** A session targets a single PR in the installation that received the trigger.
- **Custom operator dashboard.** Cross-session visibility is delivered via the per-session tracking comment (FR-006) plus the structured logs and metrics required by FR-016, queryable through the existing observability stack. A bespoke web UI is not in v1 scope.

The following implementation approaches are explicitly rejected and MUST NOT be adopted:

- **In-`resolve` blocking wait loop** (waiting for CI / reviewer state inside a single agent run): holds a daemon slot 30–60+ minutes, fights `AGENT_TIMEOUT_MS`, balloons agent context cost, duplicates session-level loop. Wrong layer. (Per architecture proposal §15.)
- **GitHub Actions-driven loop in user repos**: requires writing workflow files into user repositories; introduces quota and security-boundary problems. (Per architecture proposal §15.)
- **Pure polling driver with no webhook signal**: wasteful and slow when GitHub's webhook stream supplies the same information at zero polling cost. (Per architecture proposal §15.)

## Assumptions

- The bot operates as `@chrisleekr-bot` (or the configured trigger phrase) and uses the existing webhook + daemon execution path, not a separate runtime.
- Authorisation is governed by the existing `ALLOWED_OWNERS` configuration; shepherding inherits the same trust model rather than introducing a parallel allowlist.
- An explicit trigger is required to start a session — shepherding does not auto-start on every PR open. (Driven by safety, cost, and the global rule against unprompted action.) The trigger may take any of three functionally-equivalent surfaces (FR-018): literal `bot:ship` command, natural-language phrasing prefixed with the configured trigger-phrase mention and classified by FR-025's LLM intent classifier, or addition of the `bot:ship` GitHub label.
- Behaviour stops at merge-ready in all cases. Auto-merge is permanently out of scope (FR-008); there is no opt-in.
- "Mechanical fix" in FR-003 / FR-004 is interpreted conservatively: if the bot has any doubt about reviewer intent or correctness, it halts the thread for human input rather than guessing.
- Cost target: USD per session is observability-only, not an enforcement gate. A working signal is under USD 5 average per shepherded PR; if observed cost trends exceed that for sustained periods, the operator response is to lower the wall-clock cap or tighten the iteration cap, not to wire in a mid-run cost kill.
- The initial scope shepherds PRs against the same repo the bot is installed on. Cross-repo and cross-org shepherding is out of scope for the first version.
- Forked PRs from external contributors are out of scope for the first version (bot lacks push permission to fork heads).
- This feature complements, and does not replace, the local `pr-auto` skill that the maintainer runs from their own Claude Code session. The bot-side shepherder is for the case where the maintainer wants the work to continue without their local session being open.
