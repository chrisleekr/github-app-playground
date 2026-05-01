# `bot:plan`

Writes an implementation plan for an issue that has already passed triage.

| Field           | Value                                                                 |
| --------------- | --------------------------------------------------------------------- |
| Label           | `bot:plan`                                                            |
| Mention         | `@chrisleekr-bot plan this out`                                       |
| Accepted target | Issue                                                                 |
| Requires prior  | A successful `triage` run on the same issue with `state.valid = true` |
| Artifact        | `PLAN.md`                                                             |
| Side effects    | None                                                                  |
| Source          | `src/workflows/handlers/plan.ts`                                      |

## Inputs

- Issue body.
- The triage state from the prior run (verdict, evidence, recommended next).
- A fresh shallow clone of the repository.

## Outputs

| Field                                              | Type     | Notes                                                                                              |
| -------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------- |
| `state.plan`                                       | markdown | Full `PLAN.md` body, captured before workspace cleanup. Embedded verbatim in the tracking comment. |
| `state.costUsd`, `state.turns`, `state.durationMs` | metrics  | —                                                                                                  |

## Stop conditions

The agent writes `PLAN.md`; the pipeline reports success or failure. No turn cap — the agent runs to completion.

## Re-trigger semantics

`plan` is **fresh** when a successful `plan` row exists for the issue created **after** the most recent successful `triage`. Re-applying the label when `plan` is stale enqueues a fresh run; an in-flight stale run is not interrupted, so wait for it to terminate before re-applying.
