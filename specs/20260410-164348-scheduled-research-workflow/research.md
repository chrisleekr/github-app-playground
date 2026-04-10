# Phase 0: Research

**Feature**: Scheduled Research Workflow
**Branch**: `20260410-164348-scheduled-research-workflow`
**Date**: 2026-04-10
**Status**: Complete — every spec deferral and Phase 0 unknown is resolved below.

## Scope

This document resolves the items the spec deliberately deferred to planning, the open technical questions implied by the constitution, and any decision the implementer would otherwise have to invent. Each entry follows: **Decision** → **Rationale** → **Alternatives considered**.

Every decision is grounded in one of: (a) the reference workflow at [`chrisleekr/personal-claw` `research.yml`](https://github.com/chrisleekr/personal-claw/blob/main/.github/workflows/research.yml) (which the user explicitly directed me to follow); (b) this repository's existing conventions in `.github/workflows/`; or (c) the constitution at `.specify/memory/constitution.md`.

---

## 1. Action version pinning strategy for `anthropics/claude-code-action`

**Decision**: Pin to `anthropics/claude-code-action@v1` (major-version float).

**Rationale**:

- The reference workflow uses `@v1` and has been running successfully against the same constraint set (cron + PAT auth + web search + 1 issue per run).
- This repository's existing convention is to **major-pin** non-security-critical actions and **digest- or minor-pin** security-critical ones. Verified by `grep "uses:" .github/workflows/*.yml` against the existing five workflows: `actions/checkout@v6`, `actions/setup-node@v6`, `oven-sh/setup-bun@v2`, `docker/build-push-action@v6`, `docker/setup-buildx-action@v3` — all major-pinned. Security-adjacent actions are pinned tighter (`aquasecurity/trivy-action@v0.35.0`, `gitleaks/gitleaks-action@v2.3.9`).
- `claude-code-action` is published by Anthropic and is the SDK's official wrapper. Major-pinning gives us bug-fix and security-patch updates without breaking changes within v1.x.

**Alternatives considered**:

- **Digest pin (`@<sha256>`)**: rejected because it conflicts with the repo's stated convention for non-security actions, would block bug-fix updates, and adds a Dependabot maintenance burden out of proportion to the risk.
- **Latest (`@main` or no tag)**: rejected because it violates supply-chain hygiene — any push to `main` of the action repo would land in our cron immediately.

---

## 2. Authentication mode (PAT vs OIDC vs GitHub App token)

**Decision**: **Personal Access Token (PAT)** stored in `secrets.PERSONAL_ACCESS_TOKEN`. Fine-grained, scoped to **`chrisleekr/github-app-playground` only**, with the minimum permissions: `Contents: Read`, `Issues: Write`, `Metadata: Read`.

**Rationale**:

- The reference workflow's inline comment documents that **OIDC token exchange returns 401 Unauthorized when the workflow is triggered by `schedule`**, citing [`anthropics/claude-code-action#814`](https://github.com/anthropics/claude-code-action/issues/814). A daily cron trigger would hit this bug on every run.
- A **GitHub App installation token** (e.g., reusing the `@chrisleekr-bot` app's credentials) is the more elegant alternative in principle, but it would force the workflow to either (a) call the App's installation-token endpoint inside a step (adds complexity and another secret), or (b) reuse the application server's private key in CI (violates Constitution Principle IV's "credentials scoped to the minimum required permissions" — the App's key has webhook-handler scope, not cron-research scope).
- A fine-grained PAT scoped to **issues:write on this repo only** is the smallest credential that satisfies FR-006 and the constitution's least-privilege rule. It is also exactly what the reference workflow does, which the user explicitly directed me to follow.

**Alternatives considered**:

- **OIDC**: rejected — known broken with `schedule` triggers (issue #814 cited above).
- **`secrets.GITHUB_TOKEN` (the default actions token)**: rejected — by default it cannot label issues with newly-created labels (FR-017 requires the workflow to create labels if missing), and its `id-token` permission is also subject to the same OIDC bug path inside the action.
- **GitHub App installation token via `actions/create-github-app-token`**: rejected for v1 to match the reference workflow exactly. Recorded as a future optimisation if the maintainer decides the PAT's blast radius is too large.

---

## 3. Required secrets — names and provisioning

**Decision**: Two secrets, named to match the reference workflow exactly:

| Secret name               | Purpose                                                                                                                       | Source                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `CLAUDE_CODE_OAUTH_TOKEN` | OAuth token for the Claude Code CLI subscription. Identifies the maintainer's Claude.ai subscription to `claude-code-action`. | Generated via `claude setup-token` in the Claude Code CLI.                             |
| `PERSONAL_ACCESS_TOKEN`   | Fine-grained PAT scoped to `chrisleekr/github-app-playground` only, with `Contents: Read`, `Issues: Write`, `Metadata: Read`. | GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens. |

**Rationale**:

- Matching the reference's secret names lets the maintainer copy the secrets between repos without renaming.
- `CLAUDE_CODE_OAUTH_TOKEN` is the canonical name documented by `anthropics/claude-code-action` itself (the action reads the input `claude_code_oauth_token`).
- The "Validate required secrets" step (FR-006) explicitly names both secrets in its error message so a missing secret is diagnosed in <30 seconds without reading workflow logs.

**Alternatives considered**:

- `ANTHROPIC_API_KEY` (the raw API key): rejected because the reference uses the OAuth token route (Claude.ai subscription billing) rather than direct-API billing. Switching billing model is out of scope for this feature.
- Renaming `PERSONAL_ACCESS_TOKEN` to something more descriptive (e.g., `RESEARCH_WORKFLOW_PAT`): rejected to preserve copy-paste compatibility with the reference and keep the workflow file diffable against `chrisleekr/personal-claw`.

---

## 4. Model selection

**Decision**: `claude-opus-4-6` (passed via `--model opus` in `claude_args`).

**Rationale**:

- The feature's value proposition (FR-011, FR-012, FR-013) hinges on **deep, verified, feasible** findings — not on volume. Opus is the most capable model and is best suited to the verification-heavy quality gate (every cited file path must be confirmed against the actual repo before the issue is filed).
- The reference workflow uses opus and documents inline that 80 turns of opus produces ~$8/run with the verification quality the maintainer wants.
- This repo is small enough that opus's per-token cost is bounded; the 1-hour wall-clock ceiling (FR-005) is a stronger budget limiter than per-token cost.
- The constitution's "AI orchestration" technology constraint forbids "direct LLM API calls outside the agent SDK." `claude-code-action` is the action wrapper around the same agent SDK, so this decision satisfies that constraint regardless of model.

**Alternatives considered**:

- `claude-sonnet-4-6`: rejected for v1 because the feature explicitly trades cost for quality. Recorded as a future tuning lever if monthly spend exceeds the maintainer's tolerance.
- `claude-haiku-4-5`: rejected — too small for the verification-heavy quality gate; the repo-reading + web-search + diagram-creation workload exceeds Haiku's reliable depth for a single 1-hour session.

---

## 5. Agent budget (`--max-turns`)

**Decision**: `--max-turns 80`.

**Rationale**:

- The reference workflow records inline that `--max-turns 80` is the empirically validated value: "Previous attempts at 20 and 40 turns exhausted budget before completing. 80 turns gives enough room for: architecture review, subsystem deep-dive, web search, Mermaid diagram creation, and issue creation."
- This repository is comparable in size to `personal-claw` (single-server TS codebase, ~20–30 source files), so the same turn budget is a reasonable starting point.
- The 1-hour wall-clock ceiling (FR-005) is the hard backstop — `--max-turns` is a soft inner limit that prevents runaway loops, not the primary budget control.

**Alternatives considered**:

- `--max-turns 40`: rejected — the reference explicitly tried this and found it insufficient.
- `--max-turns 120`: rejected for v1 — would risk exceeding the 1-hour wall-clock ceiling on hard subsystems and contradicts the reference's empirical baseline.

---

## 6. Tool allow-list / disallow-list

**Decision**: Restrict the agent to the minimal set required to (a) read the repo, (b) perform external research, (c) create one labelled issue. Express this with both `--allowedTools` (positive list) and `--disallowedTools ""` (clear the action's defaults to re-enable web tools).

```text
--allowedTools "WebSearch,WebFetch,Read,Glob,Grep,Bash(gh issue create:*),Bash(gh issue list:*),Bash(gh label create:*),Bash(git log:*),Bash(cat:*),Bash(date:*)"
--disallowedTools ""
```

**Rationale**:

- **Read tools** (`Read`, `Glob`, `Grep`): required for FR-012 (verify every cited file path) and for the agent to understand the repo's actual structure.
- **External research tools** (`WebSearch`, `WebFetch`): required for FR-011 (issues must cite external best-practice references) and explicitly noted by the reference as **disabled by default in the action**, requiring `--disallowedTools ""` to clear the default deny-list. Cited inline as [`anthropics/claude-code-action#690`](https://github.com/anthropics/claude-code-action/issues/690).
- **Issue/label creation** (`gh issue create`, `gh issue list`, `gh label create`): the only writes the agent is permitted to perform under FR-007. `gh issue list` is needed by FR-010's duplicate-detection step.
- **Read-only Bash helpers** (`git log`, `cat`, `date`): convenience commands the reference whitelists, with no write side-effect. `git log` enables the agent to see recent commit history without burning turns reading individual files; `date` enables the agent to stamp the issue with the run date as required by the issue body template.
- **Notably absent**: `Write`, `Edit`, `NotebookEdit`, `Bash(git push:*)`, `Bash(git commit:*)`, `Bash(rm:*)`, `Bash(gh pr create:*)`, `Bash(gh issue close:*)`, `Bash(gh issue edit:*)`, all `Bash(curl:*)` / `Bash(wget:*)` variants, `Task`. This satisfies FR-007 (no commits/branches/PRs) and FR-008 (constrained tool surface).

**Alternatives considered**:

- **Allow `Bash` unconstrained**: rejected — violates Constitution Principle IV ("AI agent execution MUST be sandboxed... no access to the server's runtime environment or secrets") in spirit. The agent runs in CI not in the application server, but the principle of least privilege still applies.
- **Disallow `WebSearch`/`WebFetch`**: rejected — would make FR-011's "external references" requirement uncheckable. The reference workflow's design hinges on web research informing each finding.
- **Allow `Bash(gh issue edit:*)`**: rejected — would let a buggy run corrupt prior issues, violating FR-007.

---

## 7. `allowed_bots: '*'` action input

**Decision**: Set `allowed_bots: '*'` on the `claude-code-action` step.

**Rationale**:

- The reference workflow documents inline that `claude-code-action`'s default `checkHumanActor` function blocks scheduled and `workflow_dispatch` runs because the actor is not a human user. Setting `allowed_bots: '*'` bypasses this check. Cited as [`anthropics/claude-code-action#900`](https://github.com/anthropics/claude-code-action/issues/900) (claimed fixed in PR #916, but the reference still sets the input defensively in case the fix has not propagated to the action major version we're pinning).
- Without this input, the workflow's first scheduled run would fail with no useful diagnostic, and we'd waste a debugging cycle re-discovering the same issue the reference already documents.

**Alternatives considered**:

- **Omit the input and let the action's default behaviour handle scheduled triggers**: rejected — directly contradicts the reference's empirical evidence and would re-introduce a known bug.
- **Set `allowed_bots: 'github-actions[bot]'`**: rejected — narrower but unnecessary for a single-maintainer personal-style repo, and the reference uses `'*'`.

---

## 8. Cron schedule (wall-clock hour for the daily run)

**Decision**: `cron: "0 22 * * *"` (22:00 UTC daily).

**Rationale**:

- The spec fixes the cadence at **once per 24 hours** (FR-001, Q3 clarification) and defers only the wall-clock hour to planning.
- 22:00 UTC = **08:00 AEST** (UTC+10) and **09:00 AEDT** (UTC+11). The maintainer's recent commits (`6e41688`, `dad6278`, `c2838d0`, `84564a8`, `0524a48`) and the `~/.claude/CLAUDE.md` reference Australian timezones, so AEST/AEDT is the correct local frame.
- 08:00 local is a sensible "morning briefing" slot — the maintainer wakes up to a freshly-filed issue ready for triage with their first coffee.
- 22:00 UTC is also outside the GitHub Actions peak load window (typically 14:00–18:00 UTC, when US workdays are in full swing and cron schedules are most likely to be silently delayed).
- This matches the morning slot of the reference workflow's two daily runs (the reference fires at both `0 22 * * *` and `0 2 * * *`); we are keeping only the morning slot since the spec mandates one run per day.

**Alternatives considered**:

- `0 0 * * *` (midnight UTC): rejected — falls in the middle of the maintainer's evening (10 AM following day in AEST is not as useful as fresh-morning-of).
- `0 14 * * *` (14:00 UTC = midnight AEST): rejected — the run completes overnight and the maintainer sees the issue mid-morning anyway, but the issue is "older" by ~2 hours of triage backlog and 14:00 UTC is in the platform's peak window.
- A "weekdays only" cron like `0 22 * * 1-5`: rejected — the spec's Q3 clarification chose Option A ("once daily"), not Option C ("weekdays only").

---

## 9. Concurrency group

**Decision**:

```yaml
concurrency:
  group: research-workflow
  cancel-in-progress: false
```

**Rationale**:

- FR-004 requires "concurrent triggers MUST queue or be skipped, and MUST NOT cancel an in-flight run." GitHub Actions' `concurrency` block with `cancel-in-progress: false` provides exactly this semantics.
- A single, fixed group name (`research-workflow`) is sufficient because the spec explicitly bounds the workflow to one repository and one logical job. There is no reason to interpolate the trigger type, ref, or run-id into the group name.
- Matches the reference workflow exactly.

**Alternatives considered**:

- `cancel-in-progress: true`: rejected — directly contradicts FR-004 and would let a manual trigger kill an in-flight scheduled run mid-research, wasting LLM spend.
- Per-ref concurrency groups (`group: research-workflow-${{ github.ref }}`): rejected — would allow two concurrent runs against `main` and a feature branch, which the spec disallows (FR-004 binds concurrency to "the same repository", not "the same ref").

---

## 10. Job-level `timeout-minutes`

**Decision**: `timeout-minutes: 60`.

**Rationale**:

- FR-005 mandates a 1-hour wall-clock ceiling, codified by SC-002. GitHub Actions' job-level `timeout-minutes` is the standard mechanism that triggers a clean job termination at the boundary, satisfies "the run is terminated cleanly without producing a partial issue" (because the issue creation is the very last step of the agent's workflow), and is auditable in the run log.
- 60 minutes is exactly the value the user supplied via `/speckit-clarify`'s "make 1 hour timeout" instruction.
- The reference uses `timeout-minutes: 30`. We deliberately deviate here at the user's explicit request.

**Alternatives considered**:

- `timeout-minutes: 30` (matching the reference): rejected — directly contradicts the user's `/speckit-clarify` instruction "make 1 hour timeout".
- A step-level timeout instead of a job-level timeout: rejected — would not catch a runaway in the validation/checkout/area-pick steps, only in the action step.

---

## 11. Required `permissions:` block

**Decision**:

```yaml
permissions:
  contents: read
  issues: write
  id-token: write
```

**Rationale**:

- `contents: read` — required by `actions/checkout@v6` to clone the default branch. Required by FR-008 (the agent reads the repo).
- `issues: write` — required by `gh issue create` and `gh label create`. Required by FR-016, FR-017, FR-015.
- `id-token: write` — **required by `claude-code-action` even when authenticating via PAT**, per the reference's inline note. The action attempts to mint an OIDC token before falling back to the PAT, and the mint attempt fails open (logs a warning) only if `id-token: write` is granted; otherwise the action errors out before reaching the PAT path. This is an action implementation detail, not a security weakening — without `id-token: write`, the workflow simply does not run.
- **Notably absent**: `pull-requests`, `actions`, `checks`, `deployments`, `packages`, `pages`, `repository-projects`, `security-events`, `statuses`. None of these are needed for the issue-only workflow and granting them would violate Constitution Principle IV.

**Alternatives considered**:

- `permissions: write-all` or no `permissions:` block: rejected — uses GitHub Actions' default permissions which are workflow- and repo-config-dependent and grant much more than required, violating Principle IV.
- Omitting `id-token: write`: rejected — the reference workflow documents that the action errors out without it.

---

## 12. Final list of focus areas

**Decision**: Ten focus areas, derived from this repository's actual `src/` subsystems and the constitution's principles:

| Area             | What it covers                                                                   | Maps to repo paths                                      |
| ---------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `webhook`        | Event routing, per-event handlers, idempotency fast path                         | `src/webhook/`, `src/webhook/events/`                   |
| `pipeline`       | Context → fetch → format → prompt → checkout → execute                           | `src/core/`                                             |
| `mcp`            | MCP server registry, per-server implementations, extensibility                   | `src/mcp/`, `src/mcp/servers/`                          |
| `idempotency`    | Two-layer guard (in-memory + tracking comment), concurrency control              | `src/webhook/router.ts`, `src/core/tracking-comment.ts` |
| `security`       | Webhook HMAC verification, secret handling, input sanitization, agent sandboxing | `src/utils/`, `src/config.ts`                           |
| `observability`  | `pino` logging, request-scoped child loggers, cost tracking                      | `src/logger.ts` (and call sites)                        |
| `testing`        | Test coverage, test quality, mocking patterns                                    | `src/**/*.test.ts`, `bun test --coverage`               |
| `docs`           | JSDoc, Mermaid diagrams, CLAUDE.md, spec quality                                 | `CLAUDE.md`, `*.md`, `specs/`                           |
| `infrastructure` | Docker, CI workflows, dependency hygiene, security scanning                      | `.github/workflows/`, `Dockerfile`, `package.json`      |
| `agent-sdk`      | Claude Agent SDK integration, prompt construction, tool allow-lists              | `src/core/prompt-builder.ts`, `src/core/executor.ts`    |

**Rationale**:

- Each area maps to a real subsystem the maintainer can reason about in isolation.
- Ten areas matches the reference workflow's count, giving the random-pick step enough variety to avoid hammering the same area on consecutive days.
- Each area name is short enough to use as a GitHub label without truncation and avoids spaces (compatible with the `gh label create` invocation).
- The list is exhaustive of the repo's current structure (verified by `ls src/`) without inventing aspirational subsystems that don't exist.
- The list is **fixed**, not dynamic — FR-009 requires "a predefined list of areas relevant to this repository". A predefined list is also testable: SC-006 (≤10% duplicates) is only achievable when the same set of areas is used across runs.

**Alternatives considered**:

- A 5-area list (collapsing `webhook`+`pipeline`+`agent-sdk` into one "core" area): rejected — too coarse; would funnel duplicate findings into the same area too quickly, blowing SC-006.
- A 20-area list (every file in `src/` is its own area): rejected — too fine-grained; the random-pick distribution would never converge on areas that have the most improvement headroom.
- Dynamically derive areas from `git ls-tree`: rejected — would make FR-010's duplicate detection unstable across runs, because the area-label dimension would shift with the repo.

---

## 13. Label naming, purpose, and colour palette

**Decision**: Two label families.

**Marker label** (every research-filed issue carries this):

| Label      | Description                                                     | Colour (hex)                                                          |
| ---------- | --------------------------------------------------------------- | --------------------------------------------------------------------- |
| `research` | Automated research finding from the scheduled research workflow | `0e8a16` (green — matches the reference, signals "automated insight") |

**Area labels** (one per focus area, exactly one applied per issue):

| Label                  | Description                                                       | Colour (hex) |
| ---------------------- | ----------------------------------------------------------------- | ------------ |
| `area: webhook`        | Focus area: webhook routing & event handlers                      | `1d76db`     |
| `area: pipeline`       | Focus area: context/fetch/format/prompt/checkout/execute pipeline | `1d76db`     |
| `area: mcp`            | Focus area: MCP server registry & servers                         | `1d76db`     |
| `area: idempotency`    | Focus area: two-layer idempotency guard & concurrency             | `1d76db`     |
| `area: security`       | Focus area: HMAC verification, secrets, sanitization, sandboxing  | `1d76db`     |
| `area: observability`  | Focus area: structured logging & cost tracking                    | `1d76db`     |
| `area: testing`        | Focus area: test coverage & quality                               | `1d76db`     |
| `area: docs`           | Focus area: JSDoc, Mermaid, spec quality                          | `1d76db`     |
| `area: infrastructure` | Focus area: Docker, CI, dependencies, security scans              | `1d76db`     |
| `area: agent-sdk`      | Focus area: Claude Agent SDK integration                          | `1d76db`     |

**Rationale**:

- The `research` label name and colour match the reference workflow exactly. Maintaining cross-repo consistency lets the maintainer use the same triage filter (`label:research`) on either repo without remembering two naming schemes.
- The `area: <name>` namespace is consistent with this repository's existing labeling convention in `.github/labeler.yml` (which uses prefixed labels like `type: feature ✨`, `type: fix 🐞`, etc.). The colon-prefix style is GitHub's de-facto convention for namespacing labels.
- All area labels share a single colour (`1d76db`, blue) so the "research-finding" green dominates visually and the area is a secondary axis.
- FR-016 requires both "workflow-produced research finding" and "focus area" markers — this label scheme provides exactly two labels per issue, satisfying that requirement minimally.
- FR-017 requires the workflow to ensure labels exist before applying them; the workflow handles this with `gh label create --force` for both the marker label and the area label of the run, before `gh issue create`. `--force` makes label creation idempotent.

**Alternatives considered**:

- Single combined label (`research-webhook`, `research-mcp`, ...): rejected — bloats the label list, breaks the maintainer's mental model of "find all research findings" with a single filter, and is inconsistent with the existing `type: ` labels.
- Existing `type:` labels (`type: feature ✨`, `type: fix 🐞`, ...) reused as area labels: rejected — those are commit-type markers (driven by `srvaroa/labeler@v1` and `commitlint`), not subsystem markers. Conflating them would corrupt the existing labeling system.
- No marker label, only area labels: rejected — fails FR-016's "unambiguously identifies it as a workflow-produced research finding".

---

## 14. Issue title convention

**Decision**: Conventional Commits style with area in the scope: `<type>(<area>): <summary>`

Where `<type>` is one of `fix`, `feat`, `perf`, `refactor`, `security`, `test`, `docs`, `chore`, `build`, `ci` (matching this repo's `.github/labeler.yml` regex set), and `<area>` is one of the focus areas defined in §12 above (without the `area: ` prefix).

**Examples**:

- `fix(idempotency): tracking-comment lookup misses runs that crashed before posting the comment`
- `feat(observability): emit per-request token-cost histogram via pino child logger`
- `perf(pipeline): cache git-clone in a per-installation work-tree pool`
- `security(mcp): prompt-injection via user-supplied PR body when constructing inline-review markdown`
- `test(webhook): no test for the concurrent-trigger rejection path`
- `docs(agent-sdk): missing JSDoc on prompt-builder's exported public API`

**Rationale**:

- This repo's `.github/labeler.yml` already auto-applies `type: feature ✨`, `type: fix 🐞`, etc. labels based on Conventional Commits regex on PR titles. Issues created by the workflow that follow the same naming will be visually consistent with the rest of the repo's issue/PR list.
- The area in the scope position is **redundant** with the area label, which is a deliberate design choice: the title alone should be readable without consulting the labels.
- Matches the reference workflow's title convention exactly.

**Alternatives considered**:

- Plain title (no Conventional Commits prefix): rejected — inconsistent with the rest of the repo's commit/PR conventions.
- Custom prefix (`[research]` or `[auto]`): rejected — duplicates information already conveyed by the `research` label.

---

## 15. Workflow file location and name

**Decision**: `.github/workflows/research.yml`.

**Rationale**:

- Peer of the existing five workflows in `.github/workflows/` — no new directories needed.
- File name matches the reference exactly, easing copy-paste maintenance between repos.
- The workflow has a single concrete responsibility (run scheduled research and file at most one issue), so a single file is appropriate. No need to split prompt content into a separate file at v1; if the prompt grows beyond ~100 lines we can extract it later (recorded as a future maintenance lever, not a v1 task).

**Alternatives considered**:

- `.github/workflows/scheduled-research.yml`: rejected — unnecessarily verbose; `research.yml` is unambiguous in this directory.
- Splitting prompt to a separate Markdown file referenced from the workflow: rejected for v1 — premature abstraction (violates "Don't create helpers, utilities, or abstractions for one-time operations" from the user's global rules).

---

## 16. Static validation of the workflow YAML (filling the test-coverage gap)

**Decision**: Add an `actionlint` invocation as a documented manual check in `quickstart.md`. **Do not** add `actionlint` to `bun run check` in v1 — that is a separate decision that requires modifying `package.json` and the constitution's "Quality Gate" section.

**Rationale**:

- The Constitution Check flagged Principle V (Test Coverage) as the only edge-case that needed Complexity Tracking. The mitigation listed in `plan.md` is "actionlint static check + manual smoke test." This decision concretises that mitigation.
- `actionlint` is a single-binary Go tool with zero runtime dependencies; it can be invoked via `actionlint .github/workflows/research.yml` or `bunx actionlint` (after `bun install actionlint-cli2` if we choose that path).
- Adding it to `bun run check` would change the behaviour of an existing constitution-mandated quality gate and is a larger decision that the maintainer should make explicitly, not as a side effect of this feature.
- Documenting it as a manual check in `quickstart.md` (under "Pre-merge validation") makes it discoverable and gives the maintainer the option to run it before merging.

**Alternatives considered**:

- **Add `actionlint` to `bun run check` immediately**: rejected — out of scope for this feature, and a behaviour change to a constitution-mandated gate. Recorded as a future task in the spec's "Outstanding" section.
- **Skip static validation entirely**: rejected — leaves the workflow file completely unverified before its first scheduled run, which was the exact reason Principle V required Complexity Tracking justification.

---

## 17. Manual smoke test before merge

**Decision**: Documented in `quickstart.md` as a **mandatory pre-merge step**:

1. Push the feature branch to `origin`.
2. Provision both secrets (`CLAUDE_CODE_OAUTH_TOKEN`, `PERSONAL_ACCESS_TOKEN`) at the repo level.
3. Manually trigger the workflow via the Actions UI with `focus_area: docs` (chosen because `docs` has the lowest blast radius — documentation findings are easiest to triage and the workflow's behaviour can be observed without risk of an alarming "security" or "idempotency" finding muddying the smoke-test signal).
4. Wait for the run to complete (or for the 1-hour timeout to fire — either is a valid signal).
5. Verify exactly one of: (a) one new issue labelled `research, area: docs` exists with the required body sections; (b) the run logs say "no candidate finding qualified" with a list of areas evaluated.
6. Verify zero commits, branches, or PRs were created by the run (`git log` against the default branch, `gh pr list --state all --json number,title,createdAt`).
7. **Only after** steps 1–6 pass, merge the PR.

**Rationale**:

- This is the manual mitigation for the unit-test gap recorded in Complexity Tracking.
- Picking `docs` as the smoke-test area minimises the risk of a false-positive finding distracting from the smoke-test signal itself.
- The verification steps map 1:1 to the spec's User Story 1 acceptance scenarios, so passing them is evidence that the workflow's primary value path is functioning.

**Alternatives considered**:

- Smoke-testing on `main` after merge: rejected — would mean the first ever run of the workflow happens on the default branch, with no opportunity to roll back if it misbehaves.
- Picking a "harder" area (`security`, `idempotency`) for the smoke test: rejected — increases the risk that the smoke test produces an alarming finding that distracts from validating the workflow itself.

---

## 18. Treatment of FR-019's "no custom alerting integration"

**Decision**: The workflow does **not** add any Slack, Discord, email, or paging integration. Failed runs surface only via:

- The GitHub Actions run history showing a red X on the failed run.
- GitHub's built-in workflow-failure email notification, which fires automatically to the user listed as the workflow file's author/last-committer when their notification settings have "Actions" enabled (default for personal accounts).

**Rationale**:

- This is exactly the Q1 clarification from the spec: "Rely on the CI/CD platform's default... no additional alerting mechanism is in scope."
- Adds zero implementation complexity, zero new secrets, zero new external integrations.
- The maintainer should verify their GitHub account has "Actions" notifications enabled at the user level (`https://github.com/settings/notifications` → "Actions" section). This is a one-time per-account check, documented in `quickstart.md`.

**Alternatives considered**:

- Open a tracking issue on technical failure (FR-019 explicitly forbids this): rejected — directly contradicts the clarification.
- Send to a webhook (Slack/Discord): rejected — same reason.

---

## 19. Constitution Principle VI bullet 2 — agent execution cost logging

**Decision**: The workflow does **not** add an explicit step that re-emits `claude-code-action`'s token-cost or duration as additional structured `key=value` lines. Instead, the constitution's "AI agent execution cost (tokens, duration) MUST be logged after every request for budget attribution and anomaly detection" requirement is satisfied by GitHub Actions' built-in stdout capture of the action's own per-turn cost output, plus a documented post-mortem retrieval procedure in `quickstart.md` Day-2 operations.

**Rationale**:

- `anthropics/claude-code-action@v1` writes its own per-turn cost lines and a final cost summary to its stdout. GitHub Actions captures **all** stdout from every step into the run log automatically. The cost data is therefore already logged for every run, **without** the workflow doing anything extra.
- Re-emitting the cost as a synthetic `cost_tokens=<n>` / `duration_seconds=<n>` line would require knowing the exact action `outputs.*` field names, which (a) varies between action versions, (b) would couple this workflow tightly to the action's output schema, and (c) would have to be defensively wrapped in `|| true` to avoid the workflow failing when the action's output schema changes — at which point the synthetic line is no more reliable than the original stdout capture.
- Constitution Principle VI's intent ("post-hoc debugging" and "budget attribution and anomaly detection") is fully achieved by `gh run view <run-id> --log | grep -i cost` against the GitHub Actions run history, which is the same retrieval procedure the maintainer would use for the application server's `pino` cost logs.
- The principle's text says cost MUST be **logged** — not that it MUST be logged in a specific format. The action's own cost output is "logged" in the operative sense.

**Trade-off accepted**: A future maintainer who greps the run log for `cost_tokens=` will find nothing (because we don't synthesise that key). They must instead grep for the action's native cost-output strings. This trade-off is documented in `quickstart.md` Day-2 operations and in the workflow file's inline comments (T015).

**Alternatives considered**:

- **Synthetic cost re-emission via `${{ steps.claude.outputs.cost_*  }}`**: rejected — couples to an undocumented (at this version) action output schema; brittle across action upgrades; provides no additional information over the action's own stdout.
- **A wrapper script that parses `gh run view --log` to extract cost**: rejected — adds a post-step shell layer for zero additional information, and the parsing logic itself becomes a maintenance burden.
- **Add an MCP-server-style cost-tracking sidecar**: rejected — violates the "single workflow file, no new dependencies" structure decision in `plan.md`.

---

## Summary of resolved unknowns

| Unknown / spec deferral                               | Resolved in section | Decision                                                                                                                                   |
| ----------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Action version pinning                                | §1                  | `@v1` major-pin                                                                                                                            |
| Authentication mode                                   | §2                  | Fine-grained PAT                                                                                                                           |
| Required secrets                                      | §3                  | `CLAUDE_CODE_OAUTH_TOKEN`, `PERSONAL_ACCESS_TOKEN`                                                                                         |
| Model selection                                       | §4                  | `claude-opus-4-6` (`--model opus`)                                                                                                         |
| Agent turn budget                                     | §5                  | `--max-turns 80`                                                                                                                           |
| Tool allow-list                                       | §6                  | Read + WebSearch/Fetch + `gh issue/label create` + read-only Bash                                                                          |
| `allowed_bots` workaround                             | §7                  | `'*'`                                                                                                                                      |
| Cron hour                                             | §8                  | `0 22 * * *` (8 AM AEST / 9 AM AEDT)                                                                                                       |
| Concurrency group                                     | §9                  | `research-workflow`, `cancel-in-progress: false`                                                                                           |
| `timeout-minutes`                                     | §10                 | `60`                                                                                                                                       |
| `permissions:` block                                  | §11                 | `contents: read`, `issues: write`, `id-token: write`                                                                                       |
| Final focus-area list                                 | §12                 | 10 areas mapping to real subsystems                                                                                                        |
| Label naming & colours                                | §13                 | `research` (green) + `area: <name>` (blue)                                                                                                 |
| Issue title convention                                | §14                 | `<type>(<area>): <summary>` Conventional Commits                                                                                           |
| Workflow file location                                | §15                 | `.github/workflows/research.yml`                                                                                                           |
| Static workflow validation                            | §16                 | `actionlint` as documented manual check                                                                                                    |
| Manual smoke test before merge                        | §17                 | Documented in `quickstart.md`                                                                                                              |
| FR-019 alerting policy                                | §18                 | GitHub Actions defaults only, no extra integration                                                                                         |
| Constitution Principle VI cost-logging interpretation | §19                 | GitHub Actions' built-in stdout capture of `claude-code-action`'s own cost output satisfies the requirement; no synthetic re-emission step |

**Phase 0 result**: ✅ Zero NEEDS CLARIFICATION markers remain. Phase 1 is unblocked.
