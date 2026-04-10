# Phase 1: Data Model

**Feature**: Scheduled Research Workflow
**Branch**: `20260410-164348-scheduled-research-workflow`
**Date**: 2026-04-10
**Status**: Complete

## Scope of "data" in this feature

This feature has **no persistent application state**. There is no database, no cache, no on-disk file the workflow reads or writes between runs. Every "entity" below is a transient object that lives for the duration of one workflow run, except `Research issue` and `Label` which are persisted in GitHub itself (the only durable storage in the system).

The data model exists to (a) name the things the spec's functional requirements refer to so the workflow file and `tasks.md` can reference them precisely, and (b) document the validation rules and state transitions that turn an FR into a testable assertion.

---

## Entities

### 1. `ScheduledRun`

A single invocation of the research workflow.

| Field               | Type                 | Constraints                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Source                                          |
| ------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `runId`             | string               | Non-empty. GitHub Actions run ID (assigned by GitHub at trigger time).                                                                                                                                                                                                                                                                                                                                                                                                                                     | `${{ github.run_id }}`                          |
| `triggerType`       | enum                 | One of: `schedule`, `workflow_dispatch`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `${{ github.event_name }}`                      |
| `startedAt`         | RFC3339 timestamp    | Non-empty. Wall-clock time at job start.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `date -u +%Y-%m-%dT%H:%M:%SZ`                   |
| `finishedAt`        | RFC3339 timestamp    | Non-empty when `outcome ≠ in_progress`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `date -u +%Y-%m-%dT%H:%M:%SZ` at end-of-job     |
| `selectedFocusArea` | string (constrained) | After validation: either one of the 10 predefined focus areas (`research.md` §12) — for scheduled runs and for manual runs with empty/whitespace-only/rejected `focus_area` input — **or** a non-predefined string that satisfies the format constraint `^[a-z][a-z0-9-]{0,31}$` (for manual runs that supply a valid in-format custom area). The string is always validated against the format constraint **before** being injected into the agent's prompt. (FR-003, FR-009, Constitution Principle IV.) | "Pick focus area" step output                   |
| `outcome`           | enum                 | One of: `issue_created`, `nothing_qualified`, `secret_validation_failed`, `timeout_reached`, `agent_error`.                                                                                                                                                                                                                                                                                                                                                                                                | Final step assertion                            |
| `producedIssueUrl`  | string \| null       | Required iff `outcome == issue_created`. Must be a `https://github.com/<owner>/<repo>/issues/<n>` URL. Null otherwise.                                                                                                                                                                                                                                                                                                                                                                                     | `gh issue create` stdout                        |
| `areasEvaluated`    | string[]             | Always exactly `[selectedFocusArea]` for v1 (FR-009 — one area per run). Field exists to anticipate a possible "evaluate multiple areas" v2 without schema rework.                                                                                                                                                                                                                                                                                                                                         | Hardcoded `[selectedFocusArea]`                 |
| `noIssueReason`     | string \| null       | Required iff `outcome == nothing_qualified`. Free-text explanation echoed by the agent before exit. Null otherwise.                                                                                                                                                                                                                                                                                                                                                                                        | Agent stdout (last `## No Finding` block)       |
| `failureReason`     | string \| null       | Required iff `outcome ∈ {secret_validation_failed, timeout_reached, agent_error}`. Null otherwise.                                                                                                                                                                                                                                                                                                                                                                                                         | Step error message / GitHub Actions failure log |

**Lifecycle / state machine**:

```text
                    ┌─────────────────────────────────┐
                    │                                 │
[trigger] ──► validating_secrets ─fail─► secret_validation_failed (terminal)
                    │
                    ▼ pass
              checking_out_repo
                    │
                    ▼
              picking_focus_area
                    │
                    ▼
              running_agent ─timeout─► timeout_reached (terminal)
                    │
       ┌────────────┼────────────┐
       │            │            │
       ▼            ▼            ▼
issue_created  nothing_      agent_error
 (terminal)    qualified     (terminal)
                (terminal)
```

**Invariants** (testable from the run log alone):

- Exactly one outcome is reached per run. (FR-015 + FR-014.)
- `producedIssueUrl` is non-null iff `outcome == issue_created`. (FR-015.)
- `noIssueReason` is non-null iff `outcome == nothing_qualified`. (FR-014.)
- `failureReason` is non-null iff `outcome ∈ {secret_validation_failed, timeout_reached, agent_error}`. (FR-018.)
- `selectedFocusArea` always satisfies the format constraint `^[a-z][a-z0-9-]{0,31}$`. (FR-003 + Principle IV.) For scheduled runs and for manual runs with empty/rejected input, the value is additionally guaranteed to be one of the 10 predefined areas: `{webhook, pipeline, mcp, idempotency, security, observability, testing, docs, infrastructure, agent-sdk}`. (FR-009.) For manual runs with an in-format custom value, the value may be outside the predefined list — this is the explicit relaxation in FR-009.
- `finishedAt - startedAt ≤ 60 minutes` always. (FR-005, SC-002. Enforced by `timeout-minutes: 60` at the job level.)
- `triggerType == workflow_dispatch` ⇒ the run was initiated by a user with `workflow_dispatch` permission on the repo. (FR-002. Enforced by GitHub itself, not by the workflow.)

---

### 2. `ResearchFinding`

A candidate improvement identified by the agent during a run. This entity exists **only inside the agent's reasoning** and is never persisted as a discrete object. It is included here because the spec's quality gate (FR-011 to FR-013) is expressed in terms of finding-level invariants the agent must enforce before promoting a finding to a `ResearchIssue`.

| Field                      | Type                       | Constraints                                                                                                                               | Source                                                                                |
| -------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `summary`                  | string                     | Non-empty. ≤ 200 characters for the title-summary slot.                                                                                   | Agent reasoning                                                                       |
| `focusArea`                | enum                       | Must equal `ScheduledRun.selectedFocusArea`. (FR-009 — single-area per run.)                                                              | Inherited from run                                                                    |
| `commitType`               | enum                       | One of: `fix`, `feat`, `perf`, `refactor`, `security`, `test`, `docs`, `chore`, `build`, `ci`. (Matches `.github/labeler.yml` regex set.) | Agent reasoning                                                                       |
| `rationale`                | string                     | Non-empty. (FR-011.)                                                                                                                      | Agent reasoning                                                                       |
| `internalReferences`       | InternalReference[]        | At least one. Every entry must satisfy `InternalReference` validation rules (see below). (FR-011, FR-012.)                                | Agent reasoning, **verified** by `Read`/`Glob`/`Grep` against the cloned repo         |
| `externalReferences`       | ExternalReference[]        | At least one. (FR-011.)                                                                                                                   | Agent reasoning, sourced via `WebSearch`/`WebFetch`                                   |
| `diagram`                  | string                     | Non-empty. Must be a fenced ` ```mermaid ` code block. (FR-011.)                                                                          | Agent reasoning                                                                       |
| `feasibility`              | "feasible" \| "infeasible" | If `infeasible`, the finding MUST be discarded and MUST NOT become an issue. (FR-013.)                                                    | Agent quality gate                                                                    |
| `extendsExisting`          | boolean                    | If `false`, the finding MUST be discarded (FR-013 — "build on the existing architecture rather than proposing a rewrite").                | Agent quality gate                                                                    |
| `duplicateOfExistingIssue` | string \| null             | Issue number/URL of a research-labelled issue that the finding overlaps with. If non-null, the finding MUST be discarded. (FR-010.)       | Agent semantic comparison against `gh issue list --label research --state all` output |

**Promotion rule** (`ResearchFinding` → `ResearchIssue`):

A finding is promoted to a `ResearchIssue` **iff all of the following hold**:

```text
finding.feasibility == "feasible"
  AND finding.extendsExisting == true
  AND finding.duplicateOfExistingIssue == null
  AND finding.internalReferences.length >= 1
  AND every i in finding.internalReferences satisfies i.verified == true
  AND finding.externalReferences.length >= 1
  AND finding.diagram is a non-empty fenced mermaid block
```

If any clause is false, the run's outcome becomes `nothing_qualified` and `noIssueReason` records which clause(s) failed.

---

### 2a. `InternalReference` (sub-entity of `ResearchFinding`)

| Field        | Type           | Constraints                                                                                             |
| ------------ | -------------- | ------------------------------------------------------------------------------------------------------- |
| `path`       | string         | Non-empty. Must be a path that exists in the cloned repo at run time. Example: `src/webhook/router.ts`. |
| `lineNumber` | number \| null | If present, must be a valid line in `path`.                                                             |
| `symbol`     | string \| null | If present (function/class/variable name), must be findable via `Grep` in `path`.                       |
| `verified`   | boolean        | Must be `true` for the reference to count toward `ResearchFinding.internalReferences`. (FR-012.)        |

**Validation**: every `InternalReference` is verified by the agent calling `Read` and/or `Grep` on `path` during the run. References that fail verification are dropped from the finding's reference list. If the dropped count reduces `internalReferences.length` to 0, the finding is discarded.

---

### 2b. `ExternalReference` (sub-entity of `ResearchFinding`)

| Field         | Type   | Constraints                                                                                                                                   |
| ------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`         | string | Non-empty. Must be `https://`. The agent does not re-verify external URLs at finding-promotion time (FR-012 only covers internal references). |
| `description` | string | Non-empty. Brief context for what the link adds.                                                                                              |

---

### 3. `ResearchIssue`

The persistent GitHub issue created from a promoted `ResearchFinding`. This is the only entity in the system that survives beyond a single run.

| Field       | Type               | Constraints                                                                                                                                                                               | Storage           |
| ----------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `number`    | number             | Assigned by GitHub at creation.                                                                                                                                                           | GitHub Issues     |
| `title`     | string             | Format `<type>(<area>): <summary>` per `research.md` §14.                                                                                                                                 | GitHub Issues     |
| `body`      | string             | Markdown. Must conform to `contracts/issue-body.md`.                                                                                                                                      | GitHub Issues     |
| `labels`    | string[]           | Exactly two labels: `research` + `area: <focusArea>`. (FR-016, FR-017.)                                                                                                                   | GitHub Issues     |
| `state`     | "open" \| "closed" | Always `open` at creation. May be closed manually by the maintainer (or by automation outside this feature's scope) — never closed by the workflow itself.                                | GitHub Issues     |
| `createdBy` | actor              | The PAT holder identified by `secrets.PERSONAL_ACCESS_TOKEN`. (Not the workflow itself; GitHub's `gh` CLI authenticates as the PAT owner.)                                                | GitHub Issues     |
| `runId`     | string             | The `ScheduledRun.runId` that produced this issue. Stored as a footer line in the issue body (`*Generated by scheduled research workflow run #<runId>*`) — not a structured GitHub field. | Issue body footer |

**Invariants**:

- Created iff `ScheduledRun.outcome == issue_created`.
- Always carries exactly two labels (one marker, one area). (FR-016.)
- Title and body together encode the full `ResearchFinding` so the issue is self-contained for triage.

---

### 4. `Label`

| Field         | Type   | Constraints                                                                                                                                                                                                |
| ------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | string | One of `research`, `area: webhook`, `area: pipeline`, `area: mcp`, `area: idempotency`, `area: security`, `area: observability`, `area: testing`, `area: docs`, `area: infrastructure`, `area: agent-sdk`. |
| `color`       | hex    | `0e8a16` for `research`, `1d76db` for any `area: *` label.                                                                                                                                                 |
| `description` | string | Per the table in `research.md` §13.                                                                                                                                                                        |

**Lifecycle**: created on demand by the workflow's "Run research" step via `gh label create --force` immediately before `gh issue create`. `--force` makes the operation idempotent: existing labels are left untouched, missing labels are created. (FR-017.)

---

### 5. `FocusArea`

A pure enum, not a record. Defined exhaustively in `research.md` §12. Listed here for completeness.

```text
type FocusArea =
  | "webhook"
  | "pipeline"
  | "mcp"
  | "idempotency"
  | "security"
  | "observability"
  | "testing"
  | "docs"
  | "infrastructure"
  | "agent-sdk"
```

**Invariant**: The set is **fixed at workflow-file authorship time** and only changes via a constitutional-style amendment (a follow-up PR that updates `research.yml`'s `areas=(…)` Bash array, this `data-model.md`, and the labels table in `research.md` §13 in a single commit). FR-009 + FR-010 + SC-006 all depend on the set being stable across runs.

---

## Relationships

```text
ScheduledRun  ─1───produces───0..1─►  ResearchIssue  ─1───carries───2─►  Label
     │                                      │
     │                                      │
     └─1───agent reasons about───0..N─► ResearchFinding  ─1───discards if duplicate of───*─►  ResearchIssue
                                              │                                                  (existing,
                                              │                                                   from prior run)
                                              ├─0..1───selects from───1─► FocusArea
                                              ├─1..*───cites────────►   InternalReference (verified)
                                              └─1..*───cites────────►   ExternalReference
```

**Cardinality summary**:

- 1 `ScheduledRun` produces **at most** 1 `ResearchIssue` (FR-015).
- 1 `ScheduledRun` selects **exactly** 1 `FocusArea` (FR-009).
- 1 `ResearchIssue` carries **exactly** 2 `Label`s (FR-016).
- 1 `ResearchFinding` cites **at least** 1 verified `InternalReference` and **at least** 1 `ExternalReference` (FR-011, FR-012).
- 1 `ResearchFinding` may discard itself by detecting overlap with **any** existing `ResearchIssue` from prior runs (FR-010).

---

## Validation rules summary (mapped to FRs)

| Rule                                                                                                                  | Source FR(s)                 | Where enforced                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `outcome` is exactly one of the 5 enum values                                                                         | FR-014, FR-015               | Final step assertion in `research.yml`                                                                                                                                         |
| `producedIssueUrl` non-null iff `outcome == issue_created`                                                            | FR-015                       | Step output capture                                                                                                                                                            |
| `selectedFocusArea` matches `^[a-z][a-z0-9-]{0,31}$` and (for scheduled / empty-input runs) is in the predefined list | FR-003, FR-009, Principle IV | Format-regex check + Bash array in "Pick focus area" step; rejected input falls back to a random pick from the predefined list and is logged as `focus_area_rejected=<reason>` |
| Every `InternalReference` is verified                                                                                 | FR-012                       | Agent quality gate (in prompt)                                                                                                                                                 |
| Every promoted finding has ≥1 internal + ≥1 external reference + diagram                                              | FR-011                       | Agent quality gate (in prompt)                                                                                                                                                 |
| Every promoted finding is feasible & extends existing architecture                                                    | FR-013                       | Agent quality gate (in prompt)                                                                                                                                                 |
| At most 1 issue per run                                                                                               | FR-015                       | Tool allow-list contains `gh issue create` exactly once per workflow per the prompt's "Exactly ONE issue per run" rule                                                         |
| Issue carries exactly 2 labels (`research` + `area: *`)                                                               | FR-016                       | `gh issue create --label "research,area: <area>"` invocation                                                                                                                   |
| Labels exist before issue creation                                                                                    | FR-017                       | `gh label create --force` calls precede `gh issue create`                                                                                                                      |
| 0 commits/branches/PRs created                                                                                        | FR-007, SC-004               | Tool allow-list excludes all write/git/`gh pr` operations                                                                                                                      |
| Wall-clock ≤ 60 minutes                                                                                               | FR-005, SC-002               | `timeout-minutes: 60` at job level                                                                                                                                             |
| Required secrets present                                                                                              | FR-006, SC-003               | First step "Validate required secrets" exits non-zero with named-secret error message                                                                                          |
| Concurrent runs blocked                                                                                               | FR-004, SC-008               | `concurrency.group: research-workflow`, `cancel-in-progress: false`                                                                                                            |
| Duplicate detection against open + closed issues                                                                      | FR-010, SC-006               | Agent invokes `gh issue list --label research --state all --limit 500` and judges semantic overlap                                                                             |
| Failure visibility via platform defaults                                                                              | FR-019                       | Workflow does **not** add custom alerting; relies on GitHub Actions failure email                                                                                              |
| Run produces structured log                                                                                           | FR-018                       | Each step echoes `key=value` lines for run metadata                                                                                                                            |
