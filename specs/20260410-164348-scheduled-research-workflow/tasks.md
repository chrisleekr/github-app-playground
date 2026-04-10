---
description: "Task list for Scheduled Research Workflow feature implementation"
---

# Tasks: Scheduled Research Workflow

**Input**: Design documents from `/specs/20260410-164348-scheduled-research-workflow/`
**Prerequisites**: `plan.md` (✅), `spec.md` (✅), `research.md` (✅), `data-model.md` (✅), `contracts/` (✅), `quickstart.md` (✅)

**Tests**: Tests are NOT included in this task list. Per `research.md` §16 and the Complexity Tracking justification in `plan.md`, the test-coverage gap is intentionally and consciously mitigated by `actionlint` static validation + a mandatory manual smoke test before merge — not by `bun test` unit tests. There is no TypeScript module to write a `*.test.ts` against because the feature is **config-only**.

**Organization**: Tasks are grouped by user story (US1 = recurring schedule, US2 = manual on-demand, US3 = safe & auditable execution) so each story can be implemented and validated incrementally.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files / different scopes / no in-flight dependency)
- **[Story]**: `[US1]`, `[US2]`, or `[US3]` — maps to a user story from `spec.md`. Setup, Foundational, and Polish phases have no story label.
- Every task includes the exact file path it touches.

## Path Conventions

This feature adds **exactly one new file** and modifies **exactly one existing file**:

- **NEW**: `.github/workflows/research.yml` — the workflow itself
- **MODIFIED**: `CLAUDE.md` — already updated by `/speckit-plan` with a `Recent Changes` entry; verified during Polish

There is **no** `src/` directory work, **no** `tests/` directory work, **no** new `package.json` dependencies, and **no** database schema. This is unusual for a tasks list and is documented here to set correct expectations.

Because almost every implementation task edits the same single file (`.github/workflows/research.yml`), most tasks within Phase 2–5 are **NOT** parallelizable — they must run in order. Tasks that _are_ genuinely parallelizable (Setup pre-flight, post-implementation verification, documentation) are marked with `[P]`.

---

## Phase 1: Setup (Shared Infrastructure) — pre-flight, no workflow file edits

**Purpose**: Provision the credentials, account-level settings, and local tooling the workflow needs _before_ the workflow file is touched. None of these tasks edit any file in the repo.

> **⚠️ User-action gate**: Tasks T001 and T002 require the user to perform actions outside the repo (provisioning secrets in the GitHub UI / CLI). Per the user's global rule "Never commit or run any code without my explicit approval", these are **proposals for the user to execute**, not actions the assistant performs autonomously.

- [ ] T001 [P] **(USER ACTION)** Provision `CLAUDE_CODE_OAUTH_TOKEN` repository secret on `chrisleekr/github-app-playground` using `claude setup-token` to mint the token and `gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo chrisleekr/github-app-playground` to store it. Detailed steps in `specs/20260410-164348-scheduled-research-workflow/quickstart.md` Pre-merge §1.
- [ ] T002 [P] **(USER ACTION)** Provision `PERSONAL_ACCESS_TOKEN` repository secret as a fine-grained PAT scoped to **`chrisleekr/github-app-playground` only** with `Contents: Read` + `Issues: Read and write` + `Metadata: Read`, then `gh secret set PERSONAL_ACCESS_TOKEN --repo chrisleekr/github-app-playground`. Detailed steps in `specs/20260410-164348-scheduled-research-workflow/quickstart.md` Pre-merge §1.
- [ ] T003 [P] **(USER ACTION)** Verify the GitHub account that will own the workflow file (the most-recent committer) has Actions failure-email notifications enabled at `https://github.com/settings/notifications` → "Actions" section. Detailed in `specs/20260410-164348-scheduled-research-workflow/quickstart.md` Pre-merge §2. This is the only mechanism for FR-019 failure surfacing.
- [ ] T004 [P] **(USER ACTION)** Install `actionlint` locally (`brew install actionlint` on macOS, or `go install github.com/rhysd/actionlint/cmd/actionlint@latest`). Required for static validation of the workflow file before merge per `research.md` §16.

**Checkpoint 1**: All four pre-flight conditions satisfied. The repo state is unchanged. The next phase begins editing files.

---

## Phase 2: Foundational (Blocking Prerequisites) — workflow file scaffold

**Purpose**: Create the workflow file with the minimal scaffolding that **every** user story depends on: name, permissions block, concurrency block, both triggers (`schedule` and `workflow_dispatch` declared but with no functional steps yet), the up-front secret-validation step, and the checkout step. After Phase 2 the workflow file passes `actionlint` and is parseable by GitHub Actions, but it intentionally does no useful work yet.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete. Phases 3, 4, 5 all build on the same file.

All Phase 2 tasks edit the same file (`.github/workflows/research.yml`) in sequence — none are parallelizable.

- [x] T005 Create the new file `.github/workflows/research.yml` containing only the `name:`, the top-level workflow comment block, and the `on:` block with both `schedule` (cron `0 22 * * *` per `research.md` §8) and `workflow_dispatch` (with the `focus_area` input declared per `contracts/workflow-inputs.md` "workflow_dispatch input schema"). No `jobs:` block yet. **Note on phase boundary**: the `workflow_dispatch.inputs.focus_area` declaration is added here in Phase 2 (Foundational) for YAML structural reasons — both triggers must be declared in a single `on:` block at file creation time and cannot be added incrementally without rewriting the whole block. The **behaviour** of US2 (reading and validating the input value) is delivered separately in Phase 4 by T016. T017 then verifies the declaration created here still matches the contract.
- [x] T006 In `.github/workflows/research.yml`, add the top-level `permissions:` block with **exactly** `contents: read`, `issues: write`, `id-token: write` per `research.md` §11 and `contracts/workflow-inputs.md` "Required `permissions:` contract".
- [x] T007 In `.github/workflows/research.yml`, add the top-level `concurrency:` block with `group: research-workflow` and `cancel-in-progress: false` per `research.md` §9 and FR-004.
- [x] T008 In `.github/workflows/research.yml`, add the `jobs.research:` block with `runs-on: ubuntu-latest` and `timeout-minutes: 60` per `research.md` §10 and FR-005, but with no steps yet.
- [x] T009 In `.github/workflows/research.yml` under `jobs.research.steps:`, add the first two steps in this exact order: (1) "Validate required secrets" — a `run:` step that checks both `secrets.CLAUDE_CODE_OAUTH_TOKEN` and `secrets.PERSONAL_ACCESS_TOKEN` are non-empty and exits with `::error::Missing required secrets:<names>` and `exit 1` when either is missing (per FR-006, SC-003, and `contracts/workflow-inputs.md` "Required environment / secrets contract"); (2) "Checkout repository" — `uses: actions/checkout@v6` with `fetch-depth: 0`.

**Checkpoint 2**: The workflow file passes `actionlint .github/workflows/research.yml` cleanly. Triggering the workflow at this point does nothing useful but also does nothing harmful — it validates secrets, checks out the repo, and exits. No user story is yet delivered.

---

## Phase 3: User Story 1 — Automated recurring research with single-issue output (Priority: P1) 🎯 MVP

**Goal**: Deliver the recurring scheduled run that produces at most one deeply-researched, labelled, non-duplicate GitHub issue per run, while enforcing the 1-hour wall-clock budget and the single-area constraint.

**Independent Test** (matches User Story 1 acceptance scenarios in `spec.md`):

1. Trigger the workflow once on this branch via `gh workflow run research.yml --ref 20260410-164348-scheduled-research-workflow` (manual `workflow_dispatch` is acceptable for the smoke test; the actual scheduled trigger fires the same job).
2. Wait for the run to complete or hit the 60-minute ceiling — either is a valid outcome.
3. Verify exactly one of: (a) one new issue with labels `research` + `area: <focusArea>` and a body conforming to `contracts/issue-body.md`; (b) the run logs say "no candidate finding qualified" with a list of areas evaluated (FR-014).
4. Verify zero commits / branches / PRs were created.

> **Smoke-test execution is part of Phase 5**, not Phase 3, because Phase 3 only **builds** US1 — Phase 5's audit step runs and validates the smoke test end-to-end.

All Phase 3 tasks edit the same file (`.github/workflows/research.yml`) in sequence — none are parallelizable.

- [x] T010 [US1] In `.github/workflows/research.yml`, add a "Pick focus area" step that defaults to a random pick from the 10-area Bash array `("webhook" "pipeline" "mcp" "idempotency" "security" "observability" "testing" "docs" "infrastructure" "agent-sdk")` defined in `research.md` §12 / `data-model.md` §5. The step writes the chosen area to `$GITHUB_OUTPUT` as `area=<value>`. For Phase 3 the step **only handles the random branch** (the `workflow_dispatch` input branch is added in Phase 4 by T016). The step also echoes the structured `key=value` log lines required by FR-018 (`trigger_type=${{ github.event_name }}` and `selected_focus_area=<area>`).
- [x] T011 [US1] In `.github/workflows/research.yml`, add the "Run research with Claude Code" step that calls `uses: anthropics/claude-code-action@v1` with the inputs documented in `research.md` §1 (action version), §2/§3 (`claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}` + `github_token: ${{ secrets.PERSONAL_ACCESS_TOKEN }}`), §7 (`allowed_bots: '*'`), §4–§6 (`claude_args` containing `--model opus --max-turns 80 --allowedTools "..." --disallowedTools ""`). Use the exact tool allow-list from `research.md` §6. Do **NOT** include the `prompt:` content yet — that is T012.
- [x] T012 [US1] In `.github/workflows/research.yml`, add the `prompt:` content to the action step from T011. The prompt MUST include: (a) the mission statement, (b) the quality gate (FR-011, FR-012, FR-013), (c) the strict step-by-step workflow inside the agent (architecture read → duplicate check via `gh issue list --label research --state all --limit 500` → deep-dive → web search → issue creation), (d) the `## Issue Body Template` section that exactly mirrors `contracts/issue-body.md` "Body sections", (e) the Mermaid diagram rules from `contracts/issue-body.md` "Mermaid diagram rules", (f) the "Rules" section that explicitly forbids modifying files, creating branches/PRs, or creating more than one issue. The prompt MUST instruct the agent to write the issue body to `/tmp/issue-body.md` first and then call `gh issue create --body-file /tmp/issue-body.md` exactly once.
- [x] T013 [US1] In `.github/workflows/research.yml`, ensure the prompt's "Step 5: Create the issue" instructions invoke `gh label create research --description "..." --color 0e8a16 --force` and `gh label create "area: ${{ steps.area.outputs.area }}" --description "..." --color 1d76db --force` **before** `gh issue create`, exactly as `contracts/labels.md` "Idempotent creation procedure" requires. Verify the `--label "research,area: <area>"` argument format on the `gh issue create` invocation matches `contracts/labels.md` "Cardinality" exactly (two labels, comma-separated, no spaces between the comma and the next label name).
- [x] T014 [US1] In `.github/workflows/research.yml`, add a final "Echo run outcome" step (using `if: always()`) that prints structured `key=value` lines for FR-018: `outcome=<issue_created|nothing_qualified|failed>`, `produced_issue_url=<url-or-empty>`, and on failure `failure_reason=<short>`. The values are sourced from prior steps' outputs where available, falling back to `${{ job.status }}` for the catch-all case.
- [x] T015 [US1] In `.github/workflows/research.yml`, add inline comments at the top of the file documenting the design decisions and the workarounds inherited from the reference workflow: PAT vs OIDC (cite `research.md` §2 / [`anthropics/claude-code-action#814`](https://github.com/anthropics/claude-code-action/issues/814)), `allowed_bots: '*'` (cite §7 / #900), `--disallowedTools ""` (cite §6 / #690), `--max-turns 80` (cite §5), and the link to the spec/plan/research files in this feature directory. This satisfies Constitution Principle VIII's documentation-in-context requirement.

**Checkpoint 3**: The workflow file is feature-complete for User Story 1. A scheduled trigger (or a `workflow_dispatch` with no `focus_area` input) will pick a random area and produce either one labelled issue or a clean "nothing qualified" outcome. **Phase 4 adds support for user-supplied focus area; Phase 5 audits and runs the smoke test that validates this checkpoint.**

---

## Phase 4: User Story 2 — On-demand run with optional focus area (Priority: P2)

**Goal**: Allow the maintainer to point a manual run at a specific focus area, while preserving exact compatibility with the random-pick behaviour from US1 when no input is supplied (or when the input is whitespace-only).

**Independent Test** (matches User Story 2 acceptance scenarios in `spec.md`):

1. Trigger the workflow manually via `gh workflow run research.yml --ref 20260410-164348-scheduled-research-workflow --field focus_area=docs`. Verify the run picks `docs` (not random).
2. Trigger it again with `--field focus_area=""` (empty string). Verify the run falls back to random selection (FR-003 case b).
3. Trigger it with no `--field` at all. Verify the run also falls back to random selection (FR-003 case b).
4. Trigger it with `--field focus_area='Hello World'` (contains uppercase + space — fails the format constraint). Verify the run rejects the value, logs `focus_area_rejected=invalid_format input_length=11` (without echoing the value itself), and falls back to a random predefined area (FR-003 case c). This exercises the C3 input-sanitization branch.

All Phase 4 tasks edit the same file (`.github/workflows/research.yml`) in sequence — none are parallelizable. **Phase 4 must run after Phase 3**, because it modifies the "Pick focus area" step that Phase 3 created.

- [x] T016 [US2] In `.github/workflows/research.yml`, modify the "Pick focus area" step from T010 to read `${{ github.event.inputs.focus_area || '' }}` into a `FOCUS_AREA_INPUT` env var (passed via the step's `env:` block, **not** interpolated directly into the `run:` script — this prevents shell injection from a malicious input). Then in the step's Bash script: (1) strip leading/trailing whitespace from `FOCUS_AREA_INPUT`; (2) if the trimmed value is empty, fall back to the existing random branch from T010 and echo `Randomly selected area: $selected`; (3) if the trimmed value is non-empty, validate it against the Bash-portable POSIX-extended regex `^[a-z][a-z0-9-]{0,31}$` using `[[ "$FOCUS_AREA_INPUT" =~ ^[a-z][a-z0-9-]{0,31}$ ]]`; (4) if validation passes, use the input verbatim and echo `Selected area from input: $FOCUS_AREA_INPUT`; (5) if validation fails, echo `focus_area_rejected=invalid_format input_length=${#FOCUS_AREA_INPUT}` (do **NOT** echo the value itself — that would re-introduce the injection surface in the run log) and fall back to the random branch. This implements FR-003, the Constitution Principle IV "treat user-provided content as untrusted input" requirement, and `contracts/workflow-inputs.md` "Validation rules" rows 2 + 3 + 4 exactly.
- [x] T017 [US2] In `.github/workflows/research.yml`, verify (no edit needed unless a regression is found) that the `workflow_dispatch.inputs.focus_area` declaration from T005 exactly matches `contracts/workflow-inputs.md` "workflow_dispatch input schema": `description` non-empty, `required: false`, `type: string`, `default: ""`. If T005's declaration drifted from the contract, fix it now.

**Checkpoint 4**: The workflow file is feature-complete for User Story 2. Both schedule-triggered (US1) and `workflow_dispatch`-triggered (US2) runs work, and the optional `focus_area` input is (a) honoured verbatim when present and well-formed per the FR-003 format constraint, (b) ignored (random fallback) when blank or whitespace-only, or (c) rejected (random fallback + structured `focus_area_rejected` log line that does not echo the rejected value) when malformed.

---

## Phase 5: User Story 3 — Safe, auditable, and budget-bounded execution (Priority: P3)

**Goal**: **Ratify** that the safety properties baked into Phases 2–4 actually hold, by running explicit verification checks against the workflow file and by performing the mandatory pre-merge smoke test from `quickstart.md`.

US3's safety properties are _baked into earlier phases by necessity_ (the 1-hour timeout has to exist at the moment of the first smoke test, the tool allow-list has to exist before the first agent step, the secret validation has to exist before the first agent step, the concurrency block has to exist at workflow declaration time). Phase 5 therefore contains **verification and smoke-test execution**, not new workflow code.

**Independent Test** (matches User Story 3 acceptance scenarios in `spec.md`):

1. Confirm the workflow file passes a clean `actionlint` run.
2. Confirm the workflow file does not contain any forbidden write/git/PR-creating tool patterns.
3. Run the smoke test from `quickstart.md` Pre-merge §4 and confirm: (a) zero commits/branches/PRs created, (b) at most one issue created, (c) the run terminated within 60 minutes, (d) the run log contains the expected structured fields.

Phase 5 tasks operate on different scopes (static check vs grep audit vs live workflow run vs documentation update) and **can mostly run in parallel** — see `[P]` markers. The smoke test (T020) is the long-running one and should be started early.

> **⚠️ User-action gate**: T020 triggers a real GitHub Actions run that consumes LLM credit and CI minutes. Per the user's global rule, this is a **proposal for the user to execute**, not an action the assistant performs autonomously. **T020 runs AFTER merge** — see the "post-merge" note below.
>
> **⚠️ Post-merge timing for T020**: GitHub Actions requires `workflow_dispatch` workflow definitions to exist on the default branch before they can be invoked, even when targeting a different ref. The REST `/dispatches` endpoint enforces the same constraint. Therefore, the **first ever** smoke test of `.github/workflows/research.yml` cannot run on the feature branch — it must run **after the PR has been merged to `main`**, against `main`. This is the standard pattern for introducing any new GitHub Actions workflow. The pre-merge gate for this PR is the static checks (T018, T019, T021, T022) only. See `quickstart.md` §5 (pre-merge gate) and §6 (post-merge smoke test) for the full procedure and rollback plan.

- [x] T018 [P] [US3] Run `actionlint .github/workflows/research.yml` from the repo root and verify zero output (zero warnings, zero errors). If `actionlint` reports anything, fix the workflow file before proceeding. Per `research.md` §16, this is the static-validation mitigation for the test-coverage gap recorded in `plan.md` Complexity Tracking.
- [x] T019 [P] [US3] Audit the tool allow-list in `.github/workflows/research.yml` by `grep`ping the `--allowedTools` line and confirming it does **NOT** contain any of the forbidden patterns: `Write`, `Edit`, `NotebookEdit`, `Bash(git push`, `Bash(git commit`, `Bash(rm`, `Bash(gh pr create`, `Bash(gh issue close`, `Bash(gh issue edit`, `Bash(curl`, `Bash(wget`, or unconstrained `Bash` / `Bash(...)`. Cross-reference against `research.md` §6 "Notably absent" list. Any violation is a P0 fix.
- [ ] T020 [US3] **(USER ACTION, POST-MERGE)** **Wait until the PR has been merged to `main`**, then run the smoke test against `main` exactly as documented in `quickstart.md` §6: `gh workflow run research.yml --ref main --field focus_area=docs --repo chrisleekr/github-app-playground`, capture the run ID via `gh run list --workflow research.yml --limit 1 --json databaseId --jq '.[0].databaseId'`, then `gh run watch <run-id> --exit-status`, then verify the outcome per §6c and zero side effects per §6d. **If the smoke test fails**, follow the rollback procedure in §6e (disable the workflow, file a fix-up PR, re-enable + re-run after merge).
- [x] T021 [P] [US3] Verify in `.github/workflows/research.yml` that the failure-handling design satisfies FR-019: there is **no** `if: failure()` step that opens an issue, **no** `slack-notify`/`discord`/`webhook` step, and **no** custom email integration. Failure visibility is delegated entirely to the GitHub Actions platform default. If any custom alerting integration was added during Phases 2–4, remove it now.
- [x] T022 [P] [US3] Verify the labels expected by `contracts/labels.md` will be created on first run by re-reading the prompt template's `gh label create` invocations from T013 and confirming the `--description` text and `--color` hex match exactly (`research` → `0e8a16`, `area: *` → `1d76db`). Mismatched colours/descriptions are **NOT** silently overwritten — the `--force` flag re-creates with the supplied parameters, so a mismatch in the workflow's label-create call would silently overwrite the canonical contract on first run.

**Checkpoint 5 (pre-merge static)**: The static safety audits (T018, T019, T021, T022) all pass. The workflow file is statically clean and code-reviewable. **The end-to-end smoke test (T020) intentionally runs after merge** — the workflow definition must exist on `main` before `workflow_dispatch` can invoke it. Proceed to Polish (Phase 6) and merge; T020 runs immediately after merge.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Finalise the documentation surface, the commit history, and the PR ready for review — without scope creep into anything not in this feature.

- [x] T023 [P] Re-read `CLAUDE.md` (which `/speckit-plan` already updated) and verify the `Recent Changes` entry for `20260410-164348-scheduled-research-workflow` accurately reflects the final workflow file. If T010–T017 changed any parameter that the `Recent Changes` entry mentioned (cron hour, max-turns value, focus-area count, label colours), update the entry in the same commit. Follow the existing one-paragraph entry style — do **NOT** add a new section heading.
- [ ] T024 [P] Draft the PR description body using the project's PR template at `.github/PULL_REQUEST_TEMPLATE.md`. Include: (a) one-paragraph summary, (b) link to `specs/20260410-164348-scheduled-research-workflow/spec.md`, (c) link to `specs/20260410-164348-scheduled-research-workflow/plan.md`, (d) explicit acknowledgement that the smoke test (T020) runs **after merge** (not before, due to the `workflow_dispatch` default-branch limitation documented in `quickstart.md` §5–§6), (e) the Constitution Check result from `plan.md` (PASS with one Complexity Tracking entry for Principle V), (f) the explicit list of FRs satisfied (FR-001 through FR-019), (g) a "Testing" checklist that distinguishes pre-merge static checks from post-merge smoke test. After T020 completes successfully, post a follow-up PR comment with the smoke-test run URL fetched via `gh run list --workflow research.yml --limit 1 --json url --jq '.[0].url'` so reviewers have evidence of the end-to-end success.
- [x] T025 Verify the commit message that will land this work follows Conventional Commits per `.commitlintrc.json` (verified to exist at the repo root) and the constitution: prefix MUST be one of `feat:`, `fix:`, `chore:`, `ci:`, `docs:`, etc. Recommended: `feat(ci): add scheduled research workflow with claude-code-action` (the `feat(ci):` form correctly captures both "new feature" and "CI scope"). The commit body MUST reference the spec, plan, and smoke-test run URL. Stage **only** `.github/workflows/research.yml`, `CLAUDE.md`, and `specs/20260410-164348-scheduled-research-workflow/**` — nothing else.
- [ ] T026 **(USER ACTION)** Final pre-merge sanity check + merge: (1) confirm both required secrets exist (`gh secret list --repo chrisleekr/github-app-playground` shows `CLAUDE_CODE_OAUTH_TOKEN` and `PERSONAL_ACCESS_TOKEN` with recent timestamps); (2) confirm `actionlint .github/workflows/research.yml` is still clean; (3) confirm the workflow file is the only `.github/workflows/*.yml` file added by this PR (`git diff --name-only main..HEAD -- .github/workflows/`); (4) confirm code review of the workflow file diff is complete. **Only after all four confirmations succeed, merge the PR.** Then immediately run T020 (the post-merge smoke test) — do not leave the merged-but-untested workflow waiting until the next scheduled tick. If T020 fails, follow `quickstart.md` §6e rollback (disable workflow → fix-up PR → re-enable + re-test).

**Checkpoint 6** (Final): The feature is production-ready. The workflow file is on the default branch, both secrets are provisioned, the smoke test has passed, the PR description records all the pre-merge verifications, and the next scheduled run will fire automatically on the next 22:00 UTC tick (≤24 hours after merge).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately. All four tasks (T001–T004) are independent of each other and of all subsequent phases. They are external/environmental setup, not repo edits.
- **Foundational (Phase 2)**: Depends on Setup completion (specifically T001 + T002 — without secrets the secret-validation step in T009 has nothing to validate against). Blocks all user stories.
- **User Story 1 (Phase 3, P1, MVP)**: Depends on Foundational (Phase 2) completion. Phase 3 is the **MVP slice** — completing T005 → T015 in order delivers a working scheduled-only research workflow.
- **User Story 2 (Phase 4, P2)**: Depends on Phase 3 completion (T010 specifically — Phase 4 modifies the step T010 created). Cannot be parallelised with Phase 3.
- **User Story 3 (Phase 5, P3)**: The static audits (T018, T019, T021, T022) depend on Phases 3 + 4 being feature-complete and run **before** Polish/merge. The smoke test (T020) also belongs to US3 conceptually, but it must run **after merge** because `workflow_dispatch` requires the workflow definition to exist on the default branch. T018/T019/T021/T022 can run in parallel with each other.
- **Polish (Phase 6)**: T023, T024, T025 (PR-prep tasks) depend on Phases 2–4 being feature-complete and run **before** merge. T026 (the merge gate) runs after T023–T025. T020 (smoke test) runs **after** T026's merge action — see Checkpoint 5 for the rationale. T024 receives the smoke-test run URL as a follow-up PR comment after T020 completes, not as part of the original PR description.

### User Story Dependencies (within this feature)

This feature is **unusual** because all three user stories share the same single workflow file. They are _not_ truly independent in the "different developers can work in parallel on different files" sense:

- **US1** delivers the schedule trigger + agent invocation + issue creation. Sequentially first.
- **US2** is an additive delta to US1's "Pick focus area" step. Sequentially second.
- **US3** is verification + smoke test of the combined US1+US2 result. Sequentially third (mostly), but its individual audit tasks (T018, T019, T021, T022) can run in parallel with each other.

This is honest about the feature's actual structure. The MVP cut is **Phases 1 + 2 + 3 only** — that delivers a working scheduled research workflow without manual dispatch and without the explicit safety audit. Phases 4 and 5 are highly recommended but technically deferrable if pressed for time.

### Within Each User Story

- T010 → T011 → T012 → T013 → T014 → T015 (sequential — same file)
- T016 → T017 (sequential — same file)
- T018 || T019 || T020 || T021 || T022 (parallel — different scopes)

### Parallel Opportunities

- **Phase 1**: T001, T002, T003, T004 are all independent and all parallelizable.
- **Phase 2**: 0 parallel opportunities — all tasks edit `.github/workflows/research.yml` sequentially.
- **Phase 3**: 0 parallel opportunities — same single file.
- **Phase 4**: 0 parallel opportunities — same single file.
- **Phase 5**: T018, T019, T021, T022 are parallel (different audit scopes); T020 is the long-running smoke test and is independent of the four audits.
- **Phase 6**: T023 and T024 are parallel; T025 is sequential (depends on the diff being final); T026 is the final user-action gate.

---

## Parallel Example: Phase 5 (US3 audit + smoke test)

```bash
# Run these four audits in parallel (different scopes, all read-only against the workflow file):
Task: "Run `actionlint .github/workflows/research.yml` and verify zero output"
Task: "Grep `--allowedTools` line for forbidden patterns (Write, Edit, git push, gh pr create, etc.)"
Task: "Verify no custom failure alerting (no `if: failure()` issue-creating step, no slack-notify, no webhook)"
Task: "Verify gh label create invocations match contracts/labels.md exactly (colours, descriptions)"

# Concurrently, the long-running smoke test:
Task: "Push branch + run `gh workflow run research.yml --ref <branch> --field focus_area=docs` + watch + verify outcome"
```

The four audits typically take <1 minute each. The smoke test takes 5–60 minutes. Starting them all in parallel cuts the wall-clock time of Phase 5 to roughly the smoke-test duration.

---

## Implementation Strategy

### MVP First (User Story 1 only)

If the user wants the smallest possible viable slice — a workflow that runs on a daily schedule and produces issues, without manual dispatch and without the explicit safety audit:

1. Complete Phase 1 (Setup): T001–T004 (provision secrets, enable notifications, install actionlint)
2. Complete Phase 2 (Foundational): T005–T009 (skeleton workflow file)
3. Complete Phase 3 (US1): T010–T015 (full implementation of scheduled run)
4. **STOP and VALIDATE**: Trigger the workflow manually once via `gh workflow run research.yml` and verify it produces an issue (or a clean "nothing qualified" outcome)
5. Skip Phases 4–5 only if explicitly accepting the risk that (a) you can't pass a focus area on manual dispatch, and (b) the safety guarantees haven't been explicitly audited.

The MVP excludes US2 and US3 _as discrete deliverables_, but it still inherits all of US3's safety properties from the constraints baked into Phases 2 + 3 (timeout, secret validation, restricted tool list, concurrency block, no-write permissions). You just won't have the explicit verification that those properties hold.

### Incremental Delivery (Recommended)

1. Phase 1 + Phase 2 → Foundation ready (workflow file is parseable but does nothing)
2. - Phase 3 → US1 working → Manual smoke test → **MVP**
3. - Phase 4 → US2 working → Manual smoke test with `--field focus_area=docs` → Incremental release
4. - Phase 5 → US3 audited → Smoke test re-run + audit checks complete → Production ready
5. - Phase 6 → Polish → PR merged

Each step adds value without breaking the previous step. After step 2 the workflow file works for `schedule` only; after step 3 it also works for `workflow_dispatch` with `focus_area`; after step 4 it has been formally audited; after step 5 it's ready for review.

### Parallel Team Strategy

This feature does **not** benefit from a parallel team strategy because every implementation task touches the same single file. A second developer would have to wait for the first developer's edit to land before making their own. The honest answer for this feature is "one developer, sequential execution, ~half a day of actual edit time, plus the smoke-test wall-clock time."

---

## Notes

- **Why no `tests/` tasks**: Tests are explicitly OPT-IN for `/speckit-tasks` and are NOT requested for this feature. The test-coverage gap is consciously mitigated by the `actionlint` static check (T018) and the manual smoke test (T020), as documented in `plan.md` Complexity Tracking and `research.md` §16.
- **Why almost no `[P]` markers**: This is a one-file feature. Almost everything edits `.github/workflows/research.yml` in sequence. The only genuinely parallel work is in Phase 1 (environmental setup) and Phase 5 (post-implementation audits + smoke test).
- **`(USER ACTION)` markers**: T001, T002, T003, T004, T020, T026 require the user to perform actions outside the assistant's autonomous control (provisioning secrets, enabling notifications, triggering CI runs, merging PRs). Per the user's global rule "Never commit or run any code without my explicit approval", these are flagged so the assistant proposes them for the user to execute, rather than executing them autonomously.
- **Commit cadence**: Each task or logical group is a candidate commit boundary. Constitution and `commitlint` enforce Conventional Commits — recommended commit messages: `feat(ci):` for the bulk of T005–T017, `docs(ci):` for T015 + T023, `chore(ci):` for T024 + T025.
- **Stop conditions**: Stop and re-plan if (a) the smoke test (T020) creates more than one issue (catastrophic FR-015 violation — see `quickstart.md` Troubleshooting), (b) the smoke test creates any commit/branch/PR (FR-007 violation), (c) `actionlint` reports any error after T015 (workflow YAML is broken), or (d) the smoke test fails inside `claude-code-action` with an OIDC error (FR-006 / `permissions:` block misconfigured — see `quickstart.md` Troubleshooting).
- **Out of scope for this task list**: adding `actionlint` to `bun run check` (research.md §16 explicitly defers this); rotating secrets (day-2 operation, see quickstart.md); migrating from PAT to GitHub App token (recorded as future optimisation in research.md §2).
