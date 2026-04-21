# Feature Specification: Definitive Bot Workflows

**Feature Branch**: `20260421-181205-bot-workflows`
**Created**: 2026-04-21
**Status**: Draft
**Input**: User description: "Define definitive workflows"

## Clarifications

### Session 2026-04-21

- Q: How is a new workflow added in the future (extensibility contract)? → A: Single workflow registry — one data structure lists all workflows with metadata (name, label, accepted context, required prior workflow, handler); dispatcher, intent-classifier, and docs generator all read from this one registry.
- Q: When `bot:ship` is re-applied to an issue that already has an open bot-authored PR, what should the bot do? → A: Resume from review on the existing PR — ship skips triage/plan/implement (outputs already exist) and picks up at review.
- Q: What bounds halt the `review` loop on a stalled PR? → A: Inherit `pr-auto` bounds verbatim — 3 consecutive CI-fix attempts max, 15-minute reviewer patience with no new comments, no wall-clock cap.
- Q: Where does per-workflow-run state live? → A: Single shared `workflow_runs` table with a JSON `state` column is the authoritative store; the tracking comment on the issue/PR is a human-readable mirror updated after each state change. Adding a new workflow requires no schema migration.
- Q: How are simultaneous `bot:*` labels handled? → A: At most one `bot:*` label may be active on any given issue or PR. Applying a new `bot:*` label MUST automatically remove any other `bot:*` label that was already present on the same item; newest applied wins.
- Q: How does a maintainer resume a failed `ship` run mid-pipeline? → A: Re-applying `bot:ship` makes the orchestrator read the run store, find the last completed stage for that item, and continue from the next one. One-label recovery; no fresh restart. Generalises FR-020 to cover every failure point.
- Q: How is a composite workflow (e.g. `ship`) executed given each stage is a separately queued job? → A: Each registry entry has a `steps` field — an ordered list of other workflow names to run sequentially. Atomic workflows have empty `steps`. When a workflow finishes, the runtime checks whether it is currently executing as a step of a parent composite run; if so, the next name in the parent's `steps` list is enqueued as a fresh job. No coordinator process, no polling — the `steps` list itself is the orchestration.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Trigger a single named workflow via a label (Priority: P1)

A maintainer applies a `bot:<workflow>` label to a GitHub issue or pull request. The bot detects the label, runs exactly the workflow named by the label against that item, and posts its result as a tracking comment. No other workflow runs.

**Why this priority**: This is the atomic primitive every other flow is built on. If only this works, maintainers can still get value by manually stepping through triage → plan → implement → review one label at a time. It is also the simplest thing to make correct and idempotent.

**Independent Test**: Open a fresh issue, apply `bot:triage`, observe that only the triage workflow runs (no plan, implement, or review), and the tracking comment reports triage output. Repeat for `bot:plan`, `bot:implement`, `bot:review` on appropriate items.

**Acceptance Scenarios**:

1. **Given** an open issue with no prior bot activity, **When** a maintainer applies label `bot:triage`, **Then** the bot posts a tracking comment within 10 seconds, runs only the triage workflow, and updates the tracking comment with triage findings (validity verdict, staleness check, recommended next step).
2. **Given** an issue that has already been triaged, **When** a maintainer applies label `bot:plan`, **Then** the bot produces a task-decomposition plan comment scoped to that issue and runs no other workflow.
3. **Given** an issue with an approved plan, **When** a maintainer applies label `bot:implement`, **Then** the bot produces code changes on a new branch and opens a pull request linked to the issue.
4. **Given** an open pull request, **When** a maintainer applies label `bot:review`, **Then** the bot monitors CI, validates review comments, applies fixes where appropriate, and loops until the PR is merge-ready or until a stop condition is hit.
5. **Given** a label has already been applied and its workflow has already run to completion (success or terminal failure), **When** the same label is re-applied, **Then** the bot recognises the prior run via its tracking comment and does not re-execute unless the maintainer explicitly requests a re-run.

---

### User Story 2 - Orchestrate end-to-end with a single label (Priority: P1)

A maintainer applies `bot:ship` to an issue. The bot runs triage, then — if triage passes — automatically hands off to plan, then implement, then review, stopping only when the PR is merge-ready or a stage fails. The maintainer sees one continuous thread of tracking comments across the issue and the PR that was opened from it.

**Why this priority**: This is the headline capability — the whole reason the other four workflows are defined as a named set. Without it, the bot is a collection of manual buttons. With it, an issue can go from "filed" to "merge-ready PR" with a single label.

**Independent Test**: On a green-path issue (valid, scoped, small) apply `bot:ship`, leave the repo untouched, and verify that a merge-ready PR appears without any further human input, with each stage's output visible in tracking comments on the originating issue and the resulting PR.

**Acceptance Scenarios**:

1. **Given** an issue that passes triage, **When** `bot:ship` is applied, **Then** the bot runs triage → plan → implement → review in sequence, each stage handing off to the next automatically on success, and the final state is a PR awaiting human merge.
2. **Given** an issue where triage determines the issue is invalid or stale, **When** `bot:ship` is applied, **Then** the bot halts after triage, records the verdict in the tracking comment, and does not run plan, implement, or review.
3. **Given** a ship run in progress, **When** any stage fails terminally (e.g., implement cannot produce a working build), **Then** the bot halts the orchestration, records which stage failed and why, and leaves the issue/PR in a state a maintainer can resume from.
4. **Given** an issue already has an open bot-authored PR, **When** `bot:ship` is applied to the issue again, **Then** the bot does not open a duplicate PR; it resumes from the review stage against the existing PR.

---

### User Story 3 - Trigger via comment with intent detection (Priority: P2)

A maintainer writes a free-form comment on an issue or PR (e.g., "@chrisleekr-bot can you triage this and then plan it?"). The bot runs an intent-detection pass (using the triage workflow as the intent classifier), determines which of the five workflows the maintainer asked for, and dispatches it.

**Why this priority**: Labels are discoverable but clunky for expressive requests. Comment-driven triggering is the existing bot UX on this repo and must keep working, but now it dispatches through the same named-workflow contract as labels so there is one source of truth for what each workflow does.

**Independent Test**: Comment `@chrisleekr-bot please ship this` on an issue and verify the bot dispatches the ship workflow identically to how the `bot:ship` label would.

**Acceptance Scenarios**:

1. **Given** an open issue, **When** a maintainer comments with a clear request that maps unambiguously to one of the five workflows, **Then** the bot dispatches that workflow and posts a tracking comment referencing which workflow it chose and why.
2. **Given** an open issue, **When** a maintainer comments with an ambiguous request (e.g., "look at this"), **Then** the bot asks a single short clarifying question in reply and does not dispatch any workflow until the maintainer answers.
3. **Given** a comment that asks for something outside the five defined workflows (e.g., "delete this repo"), **Then** the bot replies that the request is not one of the supported workflows and takes no action.

---

### User Story 4 - Discover and understand the workflows from docs (Priority: P3)

A new contributor reads the project documentation and finds a single authoritative page that lists the five workflows, what each does, how to trigger each one (label and comment), what the hand-off rules are, and what the stop conditions are.

**Why this priority**: Docs are how this contract becomes durable. Without them the workflow names and labels will drift in people's heads and the system degrades back to "whatever the bot happens to do today".

**Independent Test**: A contributor who has never seen this repo reads `docs/` and, without asking anyone, can correctly predict what will happen when they apply `bot:plan` to an issue.

**Acceptance Scenarios**:

1. **Given** the published documentation site, **When** a reader searches for "bot workflows", **Then** they find one page that names all five workflows, lists each label, and describes each workflow's inputs, outputs, and stop conditions.
2. **Given** the documentation, **When** a maintainer changes the behaviour of a workflow in code, **Then** the corresponding doc page must be updated in the same pull request (enforced by the project's existing doc-sync rule in `CLAUDE.md`).

---

### Edge Cases

- A maintainer applies a second `bot:*` label while one is already on the item. The bot removes the older label automatically and dispatches the newly applied one. Only one `bot:*` label is ever active at a time.
- A maintainer applies `bot:implement` to an issue that has never been planned. The bot refuses and comments that plan must complete first; it does not silently run plan on the maintainer's behalf (that is what `bot:ship` is for).
- A maintainer applies `bot:review` to an issue (not a PR). The bot refuses and explains that review only applies to PRs.
- A maintainer applies `bot:plan` to a closed issue. The bot refuses and explains that plan only applies to open issues.
- A ship run is in progress and a maintainer applies a stage label (e.g., `bot:review`) to force a re-run of one stage. The bot honours the explicit label, halts the orchestrator, and records the handover.
- The same label is applied, removed, and re-applied within a short window. The bot treats the re-application as the same request (idempotent via the tracking comment) and does not double-run.
- CI in the review workflow has been failing for three consecutive fix attempts. The bot halts the review loop, records the last failure, and leaves the PR for human intervention.
- An intent-detection pass on a comment returns low confidence. The bot asks one clarifying question rather than guessing.

## Requirements _(mandatory)_

### Functional Requirements

**Workflow definitions**

- **FR-001**: The system MUST define exactly five named workflows: `triage`, `plan`, `implement`, `review`, and `ship`.
- **FR-002**: The `triage` workflow MUST operate only on open issues and MUST produce a validity verdict (valid / stale / invalid / needs-more-info) and a recommended next workflow.
- **FR-003**: The `plan` workflow MUST operate only on open issues and MUST produce a written task decomposition suitable for the `implement` workflow to consume.
- **FR-004**: The `implement` workflow MUST operate only on open issues that already have a `plan` output, MUST produce code changes on a fresh branch, and MUST open a pull request linked to the originating issue.
- **FR-005**: The `review` workflow MUST operate only on open pull requests and MUST (a) monitor continuous integration to terminal status, (b) validate review comments from human reviewers and bot reviewers, (c) apply fixes for comments it judges valid, (d) reply with a short rationale when it declines a comment, and (e) loop until the pull request is merge-ready or a documented stop condition is reached.
- **FR-006**: The `ship` workflow MUST declare its orchestration as an ordered `steps` list in the registry: `["triage", "plan", "implement", "review"]`. Each step MUST be executed as a separately enqueued job (see FR-027); on success the next name in the list is enqueued, on terminal failure orchestration halts. Stages whose outputs already exist for the item MUST be skipped (e.g., a second PR MUST NOT be opened when one is already open for the issue).

**Triggers**

- **FR-007**: Each workflow MUST be triggerable by applying the corresponding label: `bot:triage`, `bot:plan`, `bot:implement`, `bot:review`, `bot:ship`.
- **FR-008**: Each workflow MUST be triggerable by a comment on the issue or pull request; the `triage` workflow MUST also serve as the intent classifier for such comments, mapping free-form requests to one of the five named workflows.
- **FR-009**: When intent detection returns below a confidence threshold, the system MUST reply with a single clarifying question and MUST NOT dispatch any workflow until the maintainer answers.
- **FR-010**: When a request falls outside the five named workflows, the system MUST reply explaining that the request is not supported and MUST NOT take any action.

**Execution guarantees**

- **FR-011**: The system MUST be idempotent per (item, workflow) pair: re-applying the same label or repeating the same comment-triggered request on the same item MUST NOT cause the same workflow to run twice unless the maintainer explicitly requests a re-run. Idempotency is resolved against the authoritative run store (FR-025), with the tracking comment as a secondary signal.
- **FR-012**: Each workflow run MUST post or update a tracking comment on the triggering item (issue or PR) from acknowledgment through completion. The tracking comment is a human-readable mirror of the run's state; it is not the authoritative store.
- **FR-013**: When a `ship` run fails at any stage, the system MUST record which stage failed and the failure reason in the run store. Re-applying `bot:ship` to the same item MUST cause the orchestrator to read the run store, identify the last successfully completed stage, and continue from the next unfinished stage. FR-020 (resume from `review` when a PR already exists) is a specific case of this general rule. Stage-specific labels (e.g., `bot:implement`) remain available for forcing a single-stage re-run.
- **FR-014**: At most one `bot:*` label MUST be active on any given issue or pull request. When a maintainer applies a `bot:*` label, the system MUST automatically remove any other `bot:*` label already present on the same item (newest applied wins) before dispatching. This invariant removes the class of ambiguity where two labels compete for interpretation.
- **FR-025**: The system MUST persist per-workflow-run state in a single shared `workflow_runs` table keyed by (workflow name, target item, run id) with a JSON `state` column for workflow-specific fields. Adding a new workflow MUST NOT require a schema migration.
- **FR-026**: Every authoritative state change in the run store MUST be reflected in the corresponding tracking comment within the same unit of work, so a maintainer reading the comment sees the current run state without consulting the database.

**Execution model**

- **FR-027**: Each workflow invocation MUST be executed as a single job on the existing Valkey-backed job queue, claimed by a daemon over WebSocket. No workflow MUST execute synchronously inside the webhook server process (this preserves the existing 10-second webhook response SLA).
- **FR-028**: When a workflow completes successfully, the runtime MUST check whether it was executing as a step of a parent composite workflow run. If yes, the runtime MUST enqueue a fresh job for the next name in the parent's `steps` list; if the parent's list is exhausted, the parent run MUST be marked complete. Hand-off MUST happen via queue enqueue only — there is no coordinator process and no polling.
- **FR-029**: When a workflow fails terminally, the runtime MUST mark both the workflow run and any parent composite run as failed in the run store and MUST NOT enqueue any further steps from the parent's list.

**Authorisation & safety**

- **FR-015**: All workflows MUST honour the existing owner allowlist used by the webhook router; unauthorised triggers MUST be rejected with an explanatory comment.
- **FR-016**: The `implement` workflow MUST NOT push directly to the base branch; it MUST always produce a pull request.
- **FR-017**: The `review` workflow MUST NOT merge the pull request; merge remains a human action.

**Documentation**

- **FR-018**: The project documentation MUST contain a single authoritative page describing all five workflows: inputs, outputs, trigger labels, trigger-comment examples, hand-off rules, and stop conditions.
- **FR-019**: The project's existing doc-sync rule MUST be extended so that changes to any workflow's behaviour require updating the authoritative workflow page in the same pull request.

**Extensibility**

- **FR-022**: The system MUST define each workflow as an entry in a single workflow registry. Each entry MUST carry at minimum: name, trigger label, accepted context (`issue` / `pr` / both), required prior workflow output (or `none`), an ordered `steps` list of other workflow names to run sequentially (empty for atomic workflows), and a reference to its handler.
- **FR-023**: The label dispatcher, the comment-trigger intent classifier, and the authoritative workflow documentation page MUST derive their behaviour and content from the registry; they MUST NOT maintain a parallel hard-coded list of workflow names.
- **FR-024**: Adding a new workflow MUST require only (a) one new registry entry, (b) one handler implementation, and (c) one new section in the authoritative doc page (or a generated one). No changes to the dispatcher, intent classifier, or any other workflow's handler MUST be required.

- **FR-020**: When `bot:ship` is re-applied to an issue that already has an open bot-authored pull request, the system MUST resume from the `review` stage against the existing pull request. It MUST NOT open a second pull request, and it MUST NOT re-run `triage`, `plan`, or `implement` when their outputs already exist for that issue. This behaviour follows directly from FR-006's "skip stages whose inputs already exist" rule.

- **FR-021**: The `review` workflow MUST halt when either of the following is hit, matching the existing `pr-auto` skill verbatim: (a) three consecutive CI-fix attempts have failed, or (b) 15 minutes have elapsed with no new reviewer comments and the PR is not yet approved. There is no wall-clock cap beyond condition (b).

### Key Entities

- **Workflow**: A named, independently runnable unit of work. One of `triage`, `plan`, `implement`, `review`, `ship`. Has defined inputs (issue vs PR, required prior outputs) and defined outputs (verdict, plan, PR, merge-ready state, or nothing).
- **Workflow registry**: The single authoritative enumeration of all workflows. Each registry entry carries the workflow's name, trigger label, accepted context (issue / PR / both), required prior workflow output, an ordered `steps` list (empty for atomic workflows; non-empty for composite workflows like `ship`), and a handler reference. The label dispatcher, comment-trigger intent classifier, and docs page are all derived from this registry.
- **Steps**: The ordered list of workflow names that a composite workflow runs in sequence. An atomic workflow (`triage`, `plan`, `implement`, `review`) has empty `steps`. A composite workflow (`ship`) has `steps = [triage, plan, implement, review]`. Hand-off between steps happens via queue enqueue when a step completes.
- **Trigger**: The event that initiates a workflow run. Two kinds: **label trigger** (applying a `bot:*` label) and **comment trigger** (mentioning the bot in a comment body). Both resolve to the same five workflows.
- **Intent classification**: The output of running `triage` against a comment body to decide which of the five workflows the maintainer asked for. Has a confidence score; below threshold it produces a clarifying question rather than a dispatch.
- **Workflow run**: A single execution of a workflow against a specific item (issue or PR). Its authoritative state lives in the shared `workflow_runs` table (FR-025) keyed by (workflow name, target item, run id) with workflow-specific fields stored as JSON.
- **Tracking comment**: A single bot-authored comment on the triggering issue or PR that mirrors the current state of the workflow run for human readers. Always kept in sync with the run store (FR-026); not the authoritative store.
- **Hand-off**: The transition between stages inside a `ship` run. Succeeds if the prior stage's output satisfies the next stage's input; fails terminally otherwise.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: A maintainer can take a green-path issue from "filed" to "merge-ready PR" by applying one label (`bot:ship`) with zero further interaction, in under 30 minutes of wall-clock time for a small change (<200 lines diff).
- **SC-002**: A new contributor reading only the documentation can correctly predict each workflow's inputs, outputs, and trigger in a blind test with 90% accuracy across a 10-question exercise.
- **SC-003**: When a maintainer applies any `bot:*` label, the bot acknowledges with a tracking comment within 10 seconds in 95% of cases, matching the existing webhook-response SLA.
- **SC-004**: Re-applying the same label on the same item produces no duplicate workflow run in 100% of cases (measured as distinct tracking comments per (item, workflow) pair).
- **SC-005**: Comment-triggered intent detection maps the comment to the correct workflow — or correctly refuses / asks for clarification — in 90% of a labelled evaluation set of at least 20 historical maintainer comments on this repo.
- **SC-006**: When a `ship` run fails at any stage, a maintainer can resume the remaining stages by re-applying `bot:ship` (a single label action) with zero manual cleanup, in 100% of failed-stage scenarios.
- **SC-007**: The authoritative workflow documentation page exists, is linked from the documentation site's top-level navigation, and is updated in the same pull request as any behavioural change — measured by zero post-merge "doc drift" fixes in the first 90 days after launch.

## Assumptions

- The `@chrisleekr-bot` mention-based trigger and owner allowlist already enforced by the webhook router remain the authoritative authorisation layer; this feature does not change who can trigger the bot, only how.
- The existing webhook → triage → daemon-dispatch → pipeline architecture in `src/webhook/`, `src/orchestrator/`, and `src/core/pipeline.ts` remains intact; each of the five workflows is a pipeline variant, not a replacement architecture.
- The existing `pr-auto` skill's behaviour on this repo (CI watch loop, review-comment validation loop, 3-fix-attempts cap) is the starting point for the `review` workflow's definition; FR-021 asks whether those exact numbers carry over verbatim.
- The documentation site (`docs/` published via MkDocs Material) is the target for the new authoritative workflow page; no new documentation platform is introduced.
- Label names are namespaced with the `bot:` prefix to keep them visually distinct from topic labels and to reserve `bot:` for future bot workflows without another migration.
- An issue's link between plan output → implement output → PR → review is tracked via the tracking-comment thread plus GitHub's native issue/PR linking; no new persistence layer is introduced.
- Out of scope for this spec: adding workflows beyond the five named; changing the bot's authentication model; adding trigger sources other than labels and comments (e.g., slash commands in PR descriptions, external API webhooks).
