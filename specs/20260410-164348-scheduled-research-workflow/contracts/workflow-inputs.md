# Contract: Workflow Inputs

**Feature**: Scheduled Research Workflow
**Branch**: `20260410-164348-scheduled-research-workflow`

## What this contract covers

This document defines the **input surface** of `.github/workflows/research.yml`. It is the single source of truth for which triggers fire the workflow, which inputs each trigger accepts, what those inputs mean, and what the workflow does with them.

The "interface" of a GitHub Actions workflow is its `on:` block plus any `inputs:` it declares. There is no public API, no CLI, and no library entry point — those concepts are N/A for an infrastructure-as-config feature.

---

## Triggers

| Trigger             | Frequency                                                                                | Inputs                                                                    | Purpose                                    |
| ------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------ |
| `schedule`          | Once every 24 hours, fired at `cron: "0 22 * * *"` (22:00 UTC = 08:00 AEST / 09:00 AEDT) | None — `schedule` triggers cannot accept inputs by GitHub Actions' design | Automatic recurring research (FR-001)      |
| `workflow_dispatch` | On demand, initiated by any user with `workflow_dispatch` permission on the repo         | `focus_area` (optional, see below)                                        | Manual on-demand research (FR-002, FR-003) |

**Decision rationale**: see `research.md` §8.

The workflow does **not** fire on:

- `push` (would couple research to commits, violating the "scheduled" intent)
- `pull_request` / `pull_request_target` (would expose the runner to fork-PR content, violating Constitution Principle IV)
- `issue` / `issue_comment` (the existing `@chrisleekr-bot` webhook server already handles those event types — overlap would create dual-response confusion)
- `workflow_call` / `workflow_run` (no upstream workflow needs to chain to this one)

---

## `workflow_dispatch` input schema

```yaml
on:
  workflow_dispatch:
    inputs:
      focus_area:
        description: "Optional focus area for this manual run. Leave blank for a randomly chosen area. Constrained free-text: lowercase letters, digits, and hyphens only; must start with a letter; 1–32 characters. See the predefined list in research.md §12 for the conventional values."
        required: false
        type: string
        default: ""
```

### Field-by-field

| Field        | Type     | Required | Default             | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------ | -------- | -------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `focus_area` | `string` | No       | `""` (empty string) | After whitespace stripping, the workflow's "Pick focus area" step (a) accepts the value verbatim if it matches the format constraint `^[a-z][a-z0-9-]{0,31}$`, (b) falls back to a random pick from the predefined 10-area list if the value is empty or whitespace-only, or (c) **rejects** the value and falls back to a random pick if it is non-empty but fails the format constraint. In case (c), the rejection is logged. (FR-003.) |

### Validation rules

| Rule                                                                                                                                                                           | Source FR                                                                                                                 | Behaviour when violated                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `focus_area` is `string` (not `choice` or `boolean`)                                                                                                                           | FR-003 ("optional focus-area value")                                                                                      | Enforced by GitHub Actions schema — non-string values are rejected at trigger time before the workflow starts.                                                                                                                                                                                                                                                                        |
| Empty / whitespace-only `focus_area` falls back to random selection                                                                                                            | FR-003                                                                                                                    | "Pick focus area" step strips whitespace and tests `[ -n "$FOCUS_AREA_INPUT" ]`. If the trimmed value is empty, the random branch runs.                                                                                                                                                                                                                                               |
| Non-empty `focus_area` value that fails the format constraint `^[a-z][a-z0-9-]{0,31}$` (lowercase ASCII letters/digits/hyphens, starting with a letter, 1–32 characters total) | FR-003 + Constitution Principle IV ("user-provided content MUST be treated as untrusted input when constructing prompts") | "Pick focus area" step rejects the value, echoes `focus_area_rejected=<reason>` to the run log, and falls back to a random pick from the predefined list. The rejected value is **never** injected into the agent's prompt or any shell command.                                                                                                                                      |
| Non-empty `focus_area` value that satisfies the format constraint but is not in the predefined 10-area list                                                                    | Edge case "Focus area supplied that is not in the predefined list"                                                        | The workflow honours the supplied value verbatim and uses it as the area label. The agent's prompt contains the predefined list and is instructed to "focus exclusively on the FOCUS_AREA subsystem"; for an in-format value not in the list, the agent will best-effort interpret the string. The workflow does **not** crash; it does **not** silently substitute a different area. |

### What the workflow does **not** accept as inputs

| Rejected input                                                          | Reason                                                                                                                                                                                                              |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model` (override Claude model)                                         | Stable LLM choice keeps cost predictable. Tunable in the workflow file itself, not at trigger time.                                                                                                                 |
| `max_turns` (override turn budget)                                      | Same reason.                                                                                                                                                                                                        |
| `dry_run` (skip issue creation)                                         | The workflow's value depends on producing real artefacts; a dry-run mode would fragment the test surface. The smoke test in `quickstart.md` covers the "what happens on first run" question without needing a flag. |
| `target_repo` (research a different repo)                               | Out of scope per spec ("No cross-repository behaviour is in scope").                                                                                                                                                |
| `commit_type` (override the Conventional Commits prefix the agent uses) | The prefix is the agent's call based on the finding type. Forcing it from the trigger would break FR-014's "agent decides" semantics.                                                                               |

---

## Required environment / secrets contract

The workflow MUST be able to read **both** of the following from the repo's Actions secrets store. Missing either secret causes the "Validate required secrets" step to exit non-zero with a named-secret error message before any research work begins. (FR-006, SC-003.)

| Secret name               | Required value shape                                                                                                                         | Where used                                                                                                                                                                         | What happens if missing                                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE_CODE_OAUTH_TOKEN` | OAuth token issued by `claude setup-token` from the Claude Code CLI. Opaque string.                                                          | Passed to `claude_code_oauth_token` input of `anthropics/claude-code-action@v1`.                                                                                                   | "Validate required secrets" step prints `::error::Missing required secrets: CLAUDE_CODE_OAUTH_TOKEN ...` and exits 1. The agent never starts. |
| `PERSONAL_ACCESS_TOKEN`   | Fine-grained PAT scoped to `chrisleekr/github-app-playground` only, with `Contents: Read`, `Issues: Write`, `Metadata: Read`. Opaque string. | Passed to `github_token` input of `anthropics/claude-code-action@v1`, AND injected into the runner environment so the agent's `gh` CLI invocations authenticate as the PAT holder. | Same — step prints the missing-secret name and exits 1.                                                                                       |

The workflow MUST NOT read any other secret.

---

## Required `permissions:` contract

```yaml
permissions:
  contents: read
  issues: write
  id-token: write
```

| Permission        | Required by                                                                                                                                                                   | Removal effect                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `contents: read`  | `actions/checkout@v6` (clones the default branch) and the agent's `Read`/`Glob`/`Grep` tools                                                                                  | Workflow fails at the checkout step.                                                               |
| `issues: write`   | `gh issue create`, `gh label create`                                                                                                                                          | Workflow fails at issue/label creation.                                                            |
| `id-token: write` | `anthropics/claude-code-action@v1` (action attempts to mint an OIDC token before falling back to PAT — without this permission the action errors out). See `research.md` §11. | Workflow fails inside the action with an OIDC-related error before reaching the PAT fallback path. |

The workflow MUST NOT request any other permission.
