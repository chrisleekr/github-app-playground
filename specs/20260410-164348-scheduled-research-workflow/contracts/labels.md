# Contract: Labels

**Feature**: Scheduled Research Workflow
**Branch**: `20260410-164348-scheduled-research-workflow`

## What this contract covers

The exact set of GitHub labels the workflow creates and uses, their colours, descriptions, and the rules for adding more in the future.

The workflow MUST NOT use any label outside this set. The workflow MUST NOT modify the colour or description of an existing label of the same name (the `--force` flag on `gh label create` only re-creates the label with the same parameters; it does not silently overwrite a maintainer's manual customisation as long as the parameters match — if the maintainer has changed the colour, the `--force` invocation will overwrite back to the canonical colour, which is intentional and preserves the workflow's contract).

---

## Marker label (required, exactly one)

| Field         | Value                                                             |
| ------------- | ----------------------------------------------------------------- |
| `name`        | `research`                                                        |
| `color`       | `0e8a16`                                                          |
| `description` | `Automated research finding from the scheduled research workflow` |

**Purpose**: Identifies an issue as workflow-produced. Lets the maintainer filter triage views with `label:research` and lets the workflow itself find prior findings via `gh issue list --label research --state all` for duplicate detection (FR-010).

**Cardinality**: Every research issue MUST carry this label. Exactly one. Carried in addition to (not instead of) the area label.

---

## Area labels (required, exactly one per issue)

All ten share the same colour (`1d76db`) and the same naming convention (`area: <name>`).

| Name                   | Description                                                                     |
| ---------------------- | ------------------------------------------------------------------------------- |
| `area: webhook`        | Focus area: webhook routing & event handlers (`src/webhook/`)                   |
| `area: pipeline`       | Focus area: context/fetch/format/prompt/checkout/execute pipeline (`src/core/`) |
| `area: mcp`            | Focus area: MCP server registry & servers (`src/mcp/`)                          |
| `area: idempotency`    | Focus area: two-layer idempotency guard & concurrency control                   |
| `area: security`       | Focus area: HMAC verification, secret handling, sanitization, agent sandboxing  |
| `area: observability`  | Focus area: structured `pino` logging & cost tracking                           |
| `area: testing`        | Focus area: test coverage & quality                                             |
| `area: docs`           | Focus area: JSDoc, Mermaid, spec quality, CLAUDE.md                             |
| `area: infrastructure` | Focus area: Docker, CI workflows, dependency hygiene, security scans            |
| `area: agent-sdk`      | Focus area: Claude Agent SDK integration, prompt construction, tool allow-lists |

**Purpose**: Segments findings by subsystem so the maintainer can triage one area at a time and so SC-006's duplicate-rate metric can be measured per area.

**Cardinality**: Every research issue MUST carry **exactly one** area label, matching the run's `selectedFocusArea`. Never zero, never two.

---

## Idempotent creation procedure

The workflow MUST ensure both required labels exist before creating the issue. The procedure is:

```sh
gh label create "research" \
  --description "Automated research finding from the scheduled research workflow" \
  --color 0e8a16 \
  --force

gh label create "area: <selectedFocusArea>" \
  --description "Focus area: <human-readable description from the table above>" \
  --color 1d76db \
  --force

gh issue create \
  --title "<type>(<selectedFocusArea>): <summary>" \
  --label "research,area: <selectedFocusArea>" \
  --body-file /tmp/issue-body.md
```

**Why `--force`**: makes label creation idempotent. If the label already exists with the same parameters, `--force` is a no-op. If the maintainer has manually changed the colour or description of an existing label, `--force` will overwrite back to the canonical values defined in this contract — which is the intended behaviour, because this contract is the source of truth for label appearance.

---

## Forbidden labels (the workflow MUST NOT use these)

| Label                                                                                                  | Why forbidden                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bug`, `enhancement`, `question`, `wontfix`, `duplicate`, `invalid`, `help wanted`, `good first issue` | GitHub default labels with semantics that conflict with research-finding triage. The workflow must not pretend a finding is a "bug" until the maintainer has triaged it.                                                        |
| `type: feature ✨`, `type: fix 🐞`, `type: perf ⚡`, `type: docs 📋`, …                                | These are PR-title-driven labels managed by `srvaroa/labeler@v1` from `.github/labeler.yml`. They are applied to PRs based on commit-type prefix. Applying them to research issues would corrupt the existing label automation. |
| Any label not listed in the "Marker label" or "Area labels" sections above                             | The contract is closed; new labels require a follow-up PR that updates this file, the workflow, `data-model.md`, and `research.md` §13 in a single commit.                                                                      |

---

## Adding a new area label

If a future PR introduces a new subsystem to `src/` that warrants its own area, the procedure is:

1. Update `research.md` §12 (focus area table) and `data-model.md` §5 (FocusArea enum).
2. Update this contract's "Area labels" table.
3. Update `.github/workflows/research.yml`'s `areas=(…)` Bash array in the "Pick random research area" step.
4. Land all four updates in **one commit** (so the labels-vs-workflow contract is never inconsistent on `main`).
5. Run the smoke test from `quickstart.md` against the new area.

The contract is **append-only**: existing area labels MUST NOT be renamed or removed without first re-labelling all historical research issues that carried the old name.
