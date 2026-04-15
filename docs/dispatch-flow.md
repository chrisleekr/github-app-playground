# Dispatch Flow

This document describes how an incoming webhook reaches a dispatch target —
the cascade of checks the router runs before handing a request to
`inline`, `daemon`, `shared-runner`, or `isolated-job`.

The diagram below is the canonical reference for operators investigating
"why did request X land on target Y". For the source-of-truth definitions
of each node, see:

- `src/webhook/router.ts` — `decideDispatch` + `processRequest`
- `src/orchestrator/triage.ts` — triage call, parse, and fallback rules
- `src/k8s/pending-queue.ts` + `src/k8s/pending-queue-drainer.ts` — isolated-job capacity gate and queue drain
- `specs/20260415-000159-triage-dispatch-modes/spec.md` — feature-level behaviour
- `specs/20260415-000159-triage-dispatch-modes/contracts/dispatch-telemetry.md` — log shape and FR-014 aggregate queries

## Cascade — visual

```mermaid
flowchart TD
    Evt["Webhook event<br/>@chrisleekr-bot mentioned"]:::evt
    Idem{"Idempotent?<br/>delivery-id seen?"}:::check
    ModeCfg{"AGENT_JOB_MODE"}:::check
    Label{"Label override?<br/>bot:shared / bot:job"}:::check
    Static{"Static classifier"}:::check
    Triage["Triage call<br/>haiku-3-5, single-turn"]:::work
    Conf{"confidence >= threshold?"}:::check
    Default["Configured default<br/>DEFAULT_DISPATCH_TARGET"]:::result
    Inline["inline pipeline"]:::result
    Daemon["daemon<br/>Phase 2 pool"]:::result
    Shared["shared-runner<br/>POST /internal/run"]:::result
    Iso["isolated-job<br/>K8s Job + DinD sidecar"]:::result
    Queue{"isolated-job capacity?"}:::check
    Wait["Enqueue in Valkey<br/>tracking comment shows<br/>position N of M"]:::work
    Done["ack, skip"]:::muted

    Evt --> Idem
    Idem -->|no, already processed| Done
    Idem -->|yes, new| ModeCfg
    ModeCfg -->|inline| Inline
    ModeCfg -->|daemon| Daemon
    ModeCfg -->|shared-runner| Shared
    ModeCfg -->|isolated-job| Queue
    ModeCfg -->|auto| Label
    Label -->|bot:shared| Shared
    Label -->|bot:job| Queue
    Label -->|none| Static
    Static -->|clear-shared-runner| Shared
    Static -->|clear-isolated-job| Queue
    Static -->|ambiguous| Triage
    Triage -->|failure / circuit-open| Default
    Triage -->|success| Conf
    Conf -->|no| Default
    Conf -->|yes, mode=daemon| Daemon
    Conf -->|yes, mode=shared-runner| Shared
    Conf -->|yes, mode=isolated-job| Queue
    Queue -->|capacity free| Iso
    Queue -->|at max| Wait
    Wait -.->|slot frees| Iso

    classDef evt fill:#BBDEFB,stroke:#0D47A1,color:#0D47A1
    classDef check fill:#FFE0B2,stroke:#BF360C,color:#BF360C
    classDef work fill:#C8E6C9,stroke:#1B5E20,color:#1B5E20
    classDef result fill:#D1C4E9,stroke:#311B92,color:#311B92
    classDef muted fill:#ECEFF1,stroke:#37474F,color:#37474F
```

## Node reference

| Node                       | Source of truth                   | What it decides                                                                                                                |
| -------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `AGENT_JOB_MODE`           | `src/config.ts`                   | Operator-level override; one of `inline` / `daemon` / `shared-runner` / `isolated-job` / `auto`.                               |
| Label override             | `decideDispatch` (router.ts)      | Repo labels `bot:shared` / `bot:job` short-circuit the cascade.                                                                |
| Static classifier          | `decideDispatch` (router.ts)      | Keyword / path heuristics that can route without calling the LLM.                                                              |
| Triage call                | `runTriage` (triage.ts)           | Single-turn `haiku-3-5` call that returns `{ mode, confidence, complexity, rationale }`.                                       |
| `confidence >= threshold?` | `TRIAGE_CONFIDENCE_THRESHOLD` env | Below-threshold results fall back to `DEFAULT_DISPATCH_TARGET` with `dispatch_reason = "default-fallback"`.                    |
| Triage failure fallback    | `runTriage` (triage.ts)           | Timeout / parse-error / llm-error / circuit-open → `DEFAULT_DISPATCH_TARGET` with `dispatch_reason = "triage-error-fallback"`. |
| Isolated-job capacity gate | `src/k8s/pending-queue.ts`        | Checks `inFlightCount` against `MAX_CONCURRENT_ISOLATED_JOBS`; enqueues to Valkey when at capacity.                            |

## Related telemetry

- Dispatch-decision structured log: see `contracts/dispatch-telemetry.md` §1.
- Operator aggregate queries (events per target, triage rate, confidence/fallback, spend): `src/db/queries/dispatch-stats.ts`.
