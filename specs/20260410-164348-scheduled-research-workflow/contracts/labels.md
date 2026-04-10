# Contract: Labels

**Feature**: Scheduled Research Workflow
**Branch**: `20260410-164348-scheduled-research-workflow`

## What this contract covers

The label families the workflow creates and uses, their colours, descriptions, and the rules for adding more in the future.

The workflow uses exactly two label families: the `research` marker label (one fixed name) and the `area: <name>` family (one per issue, dynamically created per run — see "Area labels" below). It MUST NOT create labels in any other family.

The canonical colour and description for both label families are defined in this contract, and the workflow asserts them on every run via `gh label create --force`. This is intentional: if a maintainer has manually customised a label's colour or description, the next workflow run will overwrite back to the canonical values defined here. The contract is the source of truth; manual customisations are not preserved across runs.

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

## Area labels (one per issue, dynamically created)

Every area label shares the colour `1d76db`, the naming convention `area: <name>`, and the **uniform generic description format** `Focus area: <name>` (e.g. the `area: webhook` label carries the description `Focus area: webhook`). The label description is intentionally minimal and identical for predefined and custom areas alike, so the workflow's `gh label create --force` invocation works for both without per-area special-casing.

The **predefined** focus areas (the only values used by scheduled runs and by manual runs with empty/whitespace-only/rejected `focus_area` input — see `data-model.md` §5 and `research.md` §12) are:

- `webhook` — webhook routing & event handlers (`src/webhook/`)
- `pipeline` — context/fetch/format/prompt/checkout/execute pipeline (`src/core/`)
- `mcp` — MCP server registry & servers (`src/mcp/`)
- `idempotency` — two-layer idempotency guard & concurrency control
- `security` — HMAC verification, secret handling, sanitization, agent sandboxing
- `observability` — structured `pino` logging & cost tracking
- `testing` — test coverage & quality
- `docs` — JSDoc, Mermaid, spec quality, CLAUDE.md
- `infrastructure` — Docker, CI workflows, dependency hygiene, security scans
- `agent-sdk` — Claude Agent SDK integration, prompt construction, tool allow-lists

The maintainer can also dispatch the workflow with a **custom in-format `focus_area`** value (per `workflow-inputs.md` row 4 and `data-model.md` §1's `selectedFocusArea` constraint). In that case the workflow dynamically creates an `area: <custom>` label with the same colour and the same generic description format. This is the explicit relaxation introduced by the C3 fix to FR-009. The list of "predefined" areas above remains the canonical reference for what each predefined area covers — that human-readable per-area context lives in this list (and in `research.md` §12 and `data-model.md` §5), **not** in the GitHub label description itself, because the label description is uniform across predefined and custom areas.

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
  --description "Focus area: <selectedFocusArea>" \
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
