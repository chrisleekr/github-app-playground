# Feature Specification: Scheduled Research Workflow

**Feature Branch**: `20260410-164348-scheduled-research-workflow`
**Created**: 2026-04-10
**Status**: Draft
**Input**: User description: "Add scheduled research workflow using anthropics/claude-code-action"
**Reference**: Pattern adapted from [chrisleekr/personal-claw `research.yml`](https://github.com/chrisleekr/personal-claw/blob/main/.github/workflows/research.yml)

## Clarifications

### Session 2026-04-10

- Q: How should the maintainer be alerted when a scheduled run fails technically (not "no finding qualified")? → A: Rely on the CI/CD platform's default — failed runs are visible in the platform's run history and trigger the platform's built-in workflow-failure email notification to the workflow file's owner. No additional alerting mechanism is in scope.
- Q: How should the workflow decide whether a candidate finding duplicates an existing issue? → A: The research agent enumerates the repository's existing research-labelled issues (open and closed), judges semantic similarity against the candidate finding itself, and discards the candidate if it materially overlaps with any existing issue.
- Q: What cadence should scheduled runs use? → A: Once daily for the automatic recurring schedule. The manual on-demand trigger (FR-002) is retained alongside the daily schedule and is unchanged.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Automated recurring research with single-issue output (Priority: P1)

As the maintainer of `github-app-playground`, I want a workflow that runs on a fixed schedule without my involvement, analyses the repository and external best-practice sources, and opens exactly one deeply researched GitHub issue per run, so that I receive a steady stream of high-signal improvement ideas I can triage manually without having to remember to ask for them.

**Why this priority**: This is the entire purpose of the feature. Without automatic recurring execution producing a concrete, reviewable artefact (an issue), the feature delivers no value. A single-run MVP satisfies the core problem.

**Independent Test**: After merging the workflow file to the default branch, trigger the workflow once manually against `main` (`workflow_dispatch` requires the workflow definition to exist on the default branch — the very first introduction of any new workflow file therefore cannot be smoke-tested before merge; subsequent changes to an existing workflow can be smoke-tested on a feature branch via `gh workflow run --ref <branch>`). Wait for the run to complete or hit the 60-minute ceiling, then verify that:

1. The workflow completed without errors.
2. Exactly one new GitHub issue exists in the repository, labelled as a research finding, containing a verified finding, a rationale, a diagram, and references.
3. No code, branches, or pull requests were created or modified by the run.

**Acceptance Scenarios**:

1. **Given** the workflow is installed and all required secrets are configured, **When** the scheduled trigger fires, **Then** the workflow completes successfully and creates exactly one new issue labelled as a research finding within its allotted time budget.
2. **Given** the workflow run finds no improvement that passes its own quality bar, **When** the run finishes, **Then** no issue is created and the run log explains which areas were evaluated and why nothing qualified.
3. **Given** a run is already in progress, **When** the scheduled trigger fires again, **Then** the new trigger does not cancel or duplicate the in-flight run.
4. **Given** a run exceeds the configured time budget, **When** the budget is reached, **Then** the run is terminated, no partial issue is created, and the termination is visible in the run log.

---

### User Story 2 - On-demand run with optional focus area (Priority: P2)

As the maintainer, I want to trigger a research run manually at any time and optionally point it at a specific area (e.g. "security", "idempotency", "observability"), so that I can get targeted analysis when I am about to work on a particular subsystem or when I want to validate the workflow end-to-end without waiting for the next scheduled slot.

**Why this priority**: Manual triggering is essential for testing, debugging, and ad-hoc use, but the feature is still valuable without it if the schedule works correctly. It is the second-most important slice.

**Independent Test**: Trigger the workflow manually from the repository's manual-trigger interface, both with and without a focus-area value, and verify that each run produces either a single issue scoped to that area (or any area when unspecified) or a clear "nothing qualified" log entry.

**Acceptance Scenarios**:

1. **Given** the workflow supports manual dispatch, **When** the maintainer triggers it without a focus area, **Then** the workflow picks a focus area automatically from the predefined list and produces one issue scoped to that area (or a "nothing qualified" outcome).
2. **Given** the maintainer supplies a well-formed non-empty focus area on manual dispatch (lowercase letters, digits, and hyphens only; first character a letter; 1–32 characters), **When** the run executes, **Then** the produced issue (if any) is scoped to that requested area.
3. **Given** the maintainer supplies an empty or whitespace-only focus area, **When** the run executes, **Then** the workflow falls back to automatic area selection exactly as if no value had been supplied.
4. **Given** the maintainer supplies a focus-area value that fails the FR-003 format constraint (e.g. contains uppercase letters, spaces, or special characters), **When** the run executes, **Then** the workflow rejects the value, logs a `focus_area_rejected=invalid_format` line that does **not** echo the rejected value itself, falls back to a random pick from the predefined list, and otherwise behaves identically to a run with no input.

---

### User Story 3 - Safe, auditable, and budget-bounded execution (Priority: P3)

As the maintainer, I want each run to be safe-by-default (no code changes, no PRs, bounded time, bounded scope, fail-fast on missing credentials), so that I can leave the workflow running indefinitely without worrying about runaway cost, accidental repository modifications, or silent credential problems.

**Why this priority**: Safety and auditability are what make it acceptable to turn this workflow on and forget about it. Without these guardrails the feature is technically functional but operationally risky. It is important, but the workflow delivers its core value even at P1 if run manually under supervision.

**Independent Test**: Review a completed run's logs and resulting artefacts to confirm: (a) no commits, branches, or PRs were created; (b) a time budget was enforced; (c) if any required secret is missing, the run fails immediately with a clear message naming the missing secret; (d) duplicate findings that already exist as open or closed issues are not re-filed.

**Acceptance Scenarios**:

1. **Given** any required secret is missing, **When** the workflow starts, **Then** it fails immediately with an error that explicitly names every missing secret and does not attempt any research work.
2. **Given** the workflow runs successfully, **When** the maintainer inspects the repository afterwards, **Then** no commits, branches, or pull requests were created by the run — only at most one new issue.
3. **Given** an existing open or closed research issue already covers a candidate finding, **When** the run executes, **Then** the workflow either selects a different finding or produces no issue for that run.
4. **Given** a run reaches the configured wall-clock time limit, **When** the limit is hit, **Then** the run is terminated cleanly and no partial issue is created.

---

### Edge Cases

- **Schedule drift / missed runs**: If the scheduler skips or delays a trigger, the next successful run must behave identically — there is no catch-up or backfill responsibility.
- **Concurrent triggers**: If a scheduled trigger and a manual trigger overlap, the second trigger must wait or be skipped — it must not cancel the in-flight run and must not run in parallel against the same repository state.
- **Secrets rotation**: If credentials are rotated mid-run, the in-flight run may fail; subsequent runs must succeed once secrets are restored, with no manual cleanup required.
- **Repository with no prior issues**: The first ever run must succeed even when there are no existing research issues to compare against for duplicate detection.
- **Focus area supplied that is not in the predefined list**: The workflow must still produce a usable result (either honour the supplied value or fall back to a predefined area with a clear log message) — it must not crash.
- **External search unavailable**: If the research agent's external research tools are degraded or return no useful results, the run must either still produce a verified internal-only finding or produce no issue, never a hallucinated one.
- **Model output that fails the quality gate** (unverified file paths, missing diagram, missing references): The workflow must not create an issue with such output.
- **Time budget reached while the agent is mid-answer**: The run must be terminated at the budget boundary regardless of progress — no partial issue must be created.

## Requirements _(mandatory)_

### Functional Requirements

#### Scheduling and triggering

- **FR-001**: The system MUST run the research workflow automatically once per 24 hours, without human intervention. The exact wall-clock hour at which the daily run fires is a planning-phase decision and is not fixed by this spec, but the cadence (one run per calendar day) is fixed.
- **FR-002**: The system MUST also allow the maintainer to trigger the workflow manually on demand.
- **FR-003**: The manual trigger MUST accept an optional focus-area value. The system MUST treat this value as untrusted user input. After whitespace stripping, the value MUST be (a) accepted verbatim only if it satisfies a conservative format constraint (lowercase ASCII letters, digits, and hyphens only; first character a letter; total length 1–32 characters), (b) treated as empty (and therefore replaced by an automatic random selection from the predefined list) if no value is supplied or the value is whitespace-only, or (c) rejected and replaced by an automatic random selection if it is non-empty but fails the format constraint. In case (c), the system MUST log that the supplied value was rejected, including the reason, before falling back. The system MUST NOT inject the supplied value into the agent's prompt or any shell command without first applying this validation.
- **FR-004**: The system MUST prevent concurrent runs of the research workflow against the same repository; overlapping triggers MUST queue or be skipped, and MUST NOT cancel an in-flight run.

#### Execution safety and budget

- **FR-005**: Every run MUST enforce a wall-clock time limit of 1 hour (60 minutes); runs that reach this limit MUST be terminated cleanly without producing a partial issue.
- **FR-006**: The system MUST validate that all required credentials and configuration are present before any research work begins, and MUST fail fast with an error that names every missing item when validation fails.
- **FR-007**: The system MUST NOT modify any repository content during a run. It MUST NOT create commits, branches, pull requests, or tags, and MUST NOT alter any existing file, issue, or comment. The only write action permitted is creating at most one new issue (and creating the labels that issue depends on if they do not yet exist).
- **FR-008**: The system MUST constrain the set of actions available to the research agent to only those needed for reading the repository, performing external research, and creating a single labelled issue.

#### Research scope and quality gate

- **FR-009**: The system MUST restrict each scheduled run, and each manual `workflow_dispatch` run with an empty or whitespace-only `focus_area` input, to a single focus area drawn from a predefined list of areas relevant to this repository. For manual runs that supply a non-empty `focus_area` input, the supplied value is honoured verbatim if it satisfies the input-format constraint in FR-003 — otherwise the workflow falls back to a random pick from the predefined list and logs the fallback. This is the explicit relaxation required by the edge case "Focus area supplied that is not in the predefined list".
- **FR-010**: Before filing a new issue, the research agent MUST enumerate the repository's existing research-labelled issues in both open and closed states, judge whether the candidate finding materially overlaps with any of them by semantic comparison, and discard the candidate if such overlap exists. The system MUST NOT rely on exact-string title matching alone, and MUST NOT use any out-of-band similarity service — duplicate detection is performed by the agent itself against the issue list it retrieves at run time.
- **FR-011**: Every issue filed by the workflow MUST contain, at minimum: a summary of the finding, a rationale explaining why it matters, a visual diagram that explains the finding, and a references section citing both internal file paths and any external sources used.
- **FR-012**: Every internal file path, function name, or code reference cited in an issue MUST have been verified against the actual repository contents during the run. Unverifiable references MUST cause the finding to be discarded.
- **FR-013**: Every finding filed as an issue MUST be feasible to implement within the current codebase and MUST build on the existing architecture rather than proposing a rewrite.
- **FR-014**: When no candidate finding passes the quality gate, the system MUST NOT create an issue, and MUST instead record in the run log which areas were evaluated and why nothing qualified.
- **FR-015**: The system MUST create at most one issue per run.

#### Issue labelling and discoverability

- **FR-016**: Every issue created by the workflow MUST be labelled in a way that unambiguously identifies it as a workflow-produced research finding and that identifies the focus area it belongs to.
- **FR-017**: The system MUST ensure that the labels it depends on exist before applying them, creating them if necessary.

#### Observability

- **FR-018**: Every run MUST produce a log that records: the trigger type (scheduled or manual), the selected focus area, the outcome (issue created / no issue / failed), the link to any issue it created, and — on failure — the reason.
- **FR-019**: When a run fails technically (errors out before a final outcome is recorded), the system MUST surface that failure through the CI/CD platform's native failure-visibility mechanisms (run history showing a failed status, plus the platform's built-in workflow-failure email to the workflow file's owner). The system MUST NOT depend on any custom alerting integration (Slack, Discord, paging, automatic failure-tracking issue, etc.) for failure notification.

### Key Entities _(include if feature involves data)_

- **Scheduled run**: A single invocation of the research workflow. Attributes: trigger type (scheduled or manual), start time, end time, selected focus area, outcome, link to produced issue (if any), list of areas evaluated, reason for no-issue outcome (if applicable).
- **Research finding**: A candidate improvement identified by the run. Attributes: focus area, summary, rationale, verified internal references, external references, diagram, conventional-commit-style title prefix (e.g. `fix`, `feat`, `perf`, `refactor`, `security`, `test`, `docs`). Must pass the quality gate (feasibility, extendability, verified references) before becoming an issue.
- **Research issue**: The GitHub issue created from a finding. Attributes: title (conventional-commit style), body (finding + rationale + diagram + references + next steps), labels (research marker + focus-area marker), link back to the run that produced it.
- **Focus area**: A named subsystem or concern within this repository that bounds the scope of a single run (e.g. webhook handling, idempotency, MCP servers, security, performance, observability, testing, documentation). Drawn from a predefined list.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: 100% of successful runs produce either exactly one new research-labelled issue or a clear "nothing qualified" log entry — never zero issues with no explanation, and never more than one.
- **SC-002**: 100% of runs terminate within the 1-hour time budget, whether by completing naturally or by being stopped at the budget boundary.
- **SC-003**: 100% of runs missing any required credential fail immediately (before any research work) with an error message that names every missing credential.
- **SC-004**: 0 commits, branches, or pull requests are created by the workflow across all runs during a 30-day observation window.
- **SC-005**: Of the issues the workflow files across a 30-day window, at least 80% contain internal file-path references that still exist on the default branch at the time of triage (i.e. the quality gate prevents hallucinated paths almost all the time).
- **SC-006**: Of the issues the workflow files across a 30-day window, at most 10% are closed by the maintainer as duplicates of a pre-existing issue (measuring the effectiveness of the duplicate-check step).
- **SC-007**: The maintainer can trigger a manual run and receive a completed result (issue or "nothing qualified") without editing any workflow files, within a single wall-clock hour.
- **SC-008**: Overlapping triggers never cause two runs of this workflow to execute concurrently against the same repository across a 30-day window.

## Assumptions

- The workflow runs inside the repository's CI/CD environment on the `github-app-playground` repository itself — it is not part of the webhook server runtime and does not share process with `src/app.ts`.
- The pattern established by the reference workflow ([`chrisleekr/personal-claw` `research.yml`](https://github.com/chrisleekr/personal-claw/blob/main/.github/workflows/research.yml)) is acceptable to the maintainer as the starting point, including its "one deep issue per run" philosophy, its use of a Personal Access Token instead of OIDC for cron-triggered runs, and its pattern of allowing external web search for the research agent.
- Required credentials (a Claude authentication token and a Personal Access Token with permission to create issues and labels) will be provisioned in the repository's secret store before the workflow is enabled. Provisioning those secrets is out of scope for this feature.
- The predefined list of focus areas for this repository will be derived from the repository's actual subsystems (e.g. webhook handling, idempotency, MCP servers, security, performance, observability, testing, documentation, Claude agent integration, infrastructure) and finalised during planning.
- The recurring cadence is fixed at once per 24 hours (see FR-001). The exact wall-clock hour of the daily run will be chosen during planning to suit the maintainer's local timezone and avoid peak CI/CD platform load windows.
- Each run is expected to cost a bounded amount of money (LLM usage plus CI minutes). Cost governance beyond the per-run 1-hour time budget (e.g. monthly spend caps, alerting on budget overrun) is out of scope for this feature and will be handled by existing billing controls.
- The existing custom webhook bot (`@chrisleekr-bot`) remains unchanged by this feature. The two systems are independent: the webhook bot responds to mentions on PRs and issues, while this workflow runs on a schedule and files new issues.
- Findings filed by the workflow are intended for manual triage by the maintainer. There is no expectation that findings are automatically converted into PRs, assigned to anyone, or acted upon without human review.
- No cross-repository behaviour is in scope: runs operate only on `github-app-playground` itself.
