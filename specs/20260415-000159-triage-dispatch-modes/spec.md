# Feature Specification: Triage and Dispatch Modes

**Feature Branch**: `20260415-000159-triage-dispatch-modes`
**Created**: 2026-04-15
**Status**: Draft
**Input**: User description: "Implement triage and dispatch modes"

## Clarifications

### Session 2026-04-15

- Q: How many execution targets besides inline? → A: Three — the existing Phase 2 **daemon** (persistent remote workers, unchanged), a new **shared-runner** (in-cluster warm Deployment, no container tooling), and a new **isolated-job** (ephemeral container-capable pod). Plus **auto** as the meta-mode that chooses between them per event.
- Q: Triage output taxonomy? → A: Two independent fields — `mode ∈ {daemon, shared-runner, isolated-job}` with an accompanying `confidence` score, and a separate `complexity ∈ {trivial, moderate, complex}` that maps to a `maxTurns` budget. The confidence threshold gates the `mode` decision only; `complexity` is advisory and never triggers a triage-failure fallback.
- Q: Behaviour when an isolated-job run fails mid-execution? → A: No automatic retry. The failure, along with captured exit reason and a link to logs where available, is surfaced in the tracking comment and the execution record; the maintainer decides whether to re-trigger. Matches the plan's `backoffLimit: 0`.
- Q: Capacity back-pressure on the isolated-job target? → A: Application-level queue in Valkey with a visible position shown in the tracking comment ("queued, position N of M"). The webhook pod drains the queue as isolated-job capacity frees. A configurable maximum queue length causes graceful rejection with an explanatory comment.
- Q: Initial confidence-threshold value when auto mode first ships? → A: **1.0 (strict)**. Triage is accepted only when the model is fully certain; anything below falls back to the configured default target. The value is operator-configurable and is expected to be lowered toward 0.75 in a follow-up once SC-004 telemetry justifies it.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Deterministic routing by explicit signal (Priority: P1)

A repository maintainer asks the bot to handle a webhook event (PR comment, issue mention, review) where the intent is obvious — either the comment contains an unambiguous keyword (for example the word "docker"), or a label such as `bot:job` or `bot:shared` has been applied. The platform must route the request to the correct execution target without invoking a paid model. The `bot:job` label forces the isolated-job target; the `bot:shared` label forces the shared-runner target; the daemon target is not directly label-selectable and is chosen only by auto-mode triage.

**Why this priority**: This is the happy path for the majority of real traffic. It must work before any probabilistic classification is layered on top, and it keeps per-event cost at zero for clearly-signalled requests. It is also the safety floor: if the triage model fails, clear signals still route correctly.

**Independent Test**: Can be fully tested by posting a webhook where the trigger comment contains `docker compose up` or carries the `bot:job` label, then observing that the request is dispatched to an isolated container-capable environment; and by posting a label-less, keyword-less simple request (e.g. "fix a typo") with `bot:shared` and observing that it is dispatched to the warm shared environment. Delivers end-to-end value: maintainers who already know what they want get it routed correctly for free.

**Acceptance Scenarios**:

1. **Given** a webhook event whose trigger comment contains the substring `docker`, **When** the router evaluates dispatch, **Then** the request is routed to the isolated-job target and no triage model is invoked.
2. **Given** a webhook event carrying the label `bot:shared`, **When** the router evaluates dispatch, **Then** the request is routed to the shared-runner target and no triage model is invoked.
3. **Given** a webhook event carrying the label `bot:job`, **When** the router evaluates dispatch, **Then** the request is routed to the isolated-job target and no triage model is invoked.
4. **Given** the platform is configured with a non-auto default dispatch mode, **When** a webhook event arrives with no label and no keyword match, **Then** the request is dispatched to the configured default target without triage.

---

### User Story 2 - Probabilistic triage for ambiguous requests (Priority: P2)

When the router cannot resolve a dispatch destination from labels or keywords alone and the platform is configured for auto mode, a lightweight classification step reads the webhook context and chooses among the three non-inline targets: daemon (persistent remote worker), shared-runner (in-cluster warm environment), or isolated-job (ephemeral container-capable pod). The classification, together with its confidence and a one-sentence rationale, is surfaced in the user-visible tracking comment so the maintainer can see why the bot made the choice.

**Why this priority**: This is what makes auto mode viable. Without it, maintainers must either label every event or live with a blunt default. It unlocks the plan's cost/latency story: simple requests go to a warm environment and cold-start-expensive requests pay the cost only when justified.

**Independent Test**: Can be tested by posting an ambiguously-worded request (e.g. "run the tests against the new service") with no labels to a platform configured in auto mode. The test verifies that a classification call is made, that the resulting dispatch mode matches the documented behaviour for that ambiguity class, and that the tracking comment on the originating PR or issue contains a collapsible section showing the chosen mode, confidence, and reasoning.

**Acceptance Scenarios**:

1. **Given** the platform is in auto mode and a webhook event has no label and no keyword match, **When** the router evaluates dispatch, **Then** a classification call is issued with the event context and its result determines the dispatch target.
2. **Given** a classification completes with confidence at or above the configured threshold, **When** the router acts on the result, **Then** the request is dispatched to the classifier-chosen mode and the tracking comment shows the mode, confidence, and one-sentence reasoning in a collapsible section.
3. **Given** a classification completes with confidence below the configured threshold, **When** the router acts on the result, **Then** the request falls back to the configured default dispatch mode and the fallback decision is recorded in the tracking comment.
4. **Given** the classification call fails (timeout, provider error, malformed response), **When** the router handles the failure, **Then** the request falls back to the configured default dispatch mode, the failure is logged with the delivery id, and the tracking comment notes that triage was unavailable.

---

### User Story 3 - Isolated execution for container-capable workloads (Priority: P2)

When a webhook is routed to the isolated-job target, the platform provisions a fresh, ephemeral container-capable pod with access to Docker-style tooling (build, compose, run), executes the request, and tears the pod down automatically. The executing agent receives an expanded tool allow-list appropriate to an isolated pod, which is not granted in inline, daemon, or shared-runner targets.

**Why this priority**: This is the capability that inline, daemon, and shared-runner targets physically cannot provide — running e2e tests, building images, exercising compose stacks. Without it, the auto-mode triage has nowhere to send "complex" classifications. Priority P2 rather than P1 because the inline, daemon, and shared-runner paths still cover the majority of traffic.

**Independent Test**: Can be tested by dispatching a request that requires `docker compose up` to the isolated-job target and verifying that: the agent has the container tooling available, the workload executes, the pod is destroyed after completion, and execution cost and outcome are recorded in the history store.

**Acceptance Scenarios**:

1. **Given** a request routed to the isolated-job target, **When** the workload starts, **Then** the executing agent's tool allow-list includes container and shell tooling that is not present in inline, daemon, or shared-runner targets.
2. **Given** a request routed to the isolated-job target completes successfully, **When** the pod tears down, **Then** no workspace or container artefacts persist and the final execution record contains outcome, duration, and cost.
3. **Given** a request routed to the isolated-job target exceeds the configured wall-clock budget, **When** the budget is reached, **Then** execution is terminated, the tracking comment reports the timeout, and the pod is torn down.
4. **Given** the platform cannot provision the isolated-job target (capacity, infrastructure absent), **When** the failure is detected, **Then** the tracking comment reports the failure and the event is marked for maintainer attention; the platform MUST NOT silently downgrade to the shared-runner or daemon targets.

---

### User Story 4 - Operator visibility and cost accountability (Priority: P3)

Operators (repository maintainers and platform owners) can see, for every processed webhook, which dispatch mode was chosen, how it was chosen (explicit signal, triage, or default), the triage cost and latency when applicable, and the final execution cost. Aggregate statistics (events per mode, triage hit rate, average confidence, fallback rate) are queryable for the rolling 30-day window.

**Why this priority**: Operators need this to tune the confidence threshold, confirm that auto mode is not burning money, and justify the feature to stakeholders. It is P3 because the system can function without it — but can't be evolved without it.

**Independent Test**: Can be tested by processing a mixed batch of webhooks (some clear, some ambiguous, some failing) and then running the aggregate statistics query for the last 24 hours, confirming that each mode, reason, and cost is accounted for.

**Acceptance Scenarios**:

1. **Given** a processed webhook, **When** the operator inspects the execution record, **Then** the record includes dispatch mode, dispatch reason (label / keyword / triage / default-fallback / triage-error-fallback), triage confidence and cost (if triage ran), and final execution cost.
2. **Given** a rolling 30-day window, **When** the operator queries aggregate statistics, **Then** the query returns events-per-mode, triage-invocation rate, average confidence, fallback rate, and total triage spend.

---

### Edge Cases

- A webhook event matches both a `bot:shared` label and a `docker` keyword — **labels always win over keywords** (FR-003 cascade step 1 evaluates before step 2; once any recognised label matches, the router short-circuits to its target and never evaluates keywords). The event is routed to `shared-runner` and no triage call is made.
- The same webhook is retried after a crash mid-triage; the previous triage result must either be reused or explicitly re-run, and must not cause double-billing for the same delivery id.
- Auto mode is configured but the triage model is globally unavailable for an extended period; the platform must continue to serve traffic via the configured default, with rate-limited error logs and a circuit-breaker rather than calling the broken model on every event.
- The triage model returns a well-formed but unknown mode value (schema drift, version mismatch); the platform must reject the result, fall back, and log the anomaly.
- A request labelled `bot:job` arrives while the isolated-job target's capacity is saturated; the platform enqueues it in the Valkey-backed pending queue and shows "queued, position N of M" in the tracking comment. If the queue is already at its configured maximum length, the request is rejected gracefully with an explanatory comment; the platform never silently downgrades to shared-runner or daemon.
- A maintainer manually overrides a triage decision by relabelling the PR after dispatch; the override cannot retroactively stop an already-running workload, and the platform must document that behaviour in the tracking comment.
- The platform is deployed in a configuration where the isolated-job target is not available (for example, a development setup without the backing infrastructure); requests that would normally route there must fall back to the configured default and the tracking comment must explain the fallback.
- An isolated-job pod starts, partially progresses, and then crashes (OOM, sidecar loss, network flap). The platform records the failure with exit reason and log link, updates the tracking comment, and performs no automatic retry; the maintainer decides whether to re-trigger.

## Requirements _(mandatory)_

### Terminology

The spec deliberately distinguishes two concepts that share the word "mode" in casual usage:

- **Dispatch mode** (platform-wide configuration): the operator-controlled setting that determines how the platform decides routing for every event. One of `inline`, `daemon`, `shared-runner`, `isolated-job`, `auto`. Set via configuration; changes require a deployment or config reload.
- **Dispatch target** (per-event decision): the concrete runner a single event is routed to for execution. One of `inline`, `daemon`, `shared-runner`, `isolated-job`. A `DispatchDecision` record pairs a target with a `reason` (see FR-010 enum).

The `auto` value appears only in dispatch mode, never in dispatch target: `auto` is a meta-mode that _chooses_ a target per event via the FR-003 cascade. The triage LLM response keeps the historical field name `mode` for the target it recommends (see FR-007 and `contracts/triage-response.schema.json`); all other platform code paths and entity attributes use `target`.

### Functional Requirements

- **FR-001**: The platform MUST support five dispatch modes: **inline** (current behaviour, unchanged), **daemon** (persistent remote workers, unchanged from Phase 2), **shared-runner** (new in-cluster warm Deployment, no container tooling), **isolated-job** (new ephemeral container-capable pod), and **auto** (the platform chooses among daemon, shared-runner, and isolated-job per event via triage).
- **FR-002**: The platform MUST be configurable to operate in exactly one dispatch mode at any time, with inline as the default and safest setting.
- **FR-003**: The platform MUST evaluate dispatch using a three-step cascade: (1) explicit label override, (2) deterministic static rules over event content, (3) probabilistic triage — with step 3 invoked only when the platform is in auto mode and steps 1 and 2 both return "ambiguous."
- **FR-004**: The platform MUST recognise at minimum two explicit label overrides: `bot:shared` to force the shared-runner target and `bot:job` to force the isolated-job target. These overrides MUST bypass triage entirely. The daemon target is selectable only via auto-mode triage or the platform-wide `daemon` dispatch mode setting; there is no `bot:daemon` label in initial scope.
- **FR-005**: The static classification step MUST be a pure, deterministic, free-of-cost function of event payload and labels, and MUST return one of: clear-shared-runner, clear-isolated-job, ambiguous.
- **FR-006**: When triage is invoked, the platform MUST use a cheap single-turn classification call (not a full agent turn) and MUST complete or time out within a bounded latency budget that does not block webhook acknowledgement.
- **FR-007**: The triage step MUST return a structured result containing at minimum: (a) `mode` ∈ {daemon, shared-runner, isolated-job}, (b) `confidence` score in the range 0.0–1.0 attached to the mode decision, (c) `complexity` ∈ {trivial, moderate, complex}, and (d) a one-sentence rationale covering both mode and complexity.
- **FR-008**: The platform MUST enforce a configurable confidence threshold against the `mode` field only; results whose mode-confidence is below the threshold MUST fall back to the configured default dispatch target. The `complexity` field MUST NOT participate in threshold gating. The threshold MUST default to `1.0` (strict — only fully-certain triage results are accepted) on first ship of auto mode; operators MUST be able to lower it without a code change as accuracy telemetry justifies.
- **FR-008a**: The platform MUST translate `complexity` to an execution-turn budget via a documented mapping with concrete ship-time defaults: `trivial` → `TRIAGE_MAXTURNS_TRIVIAL` (default `10`), `moderate` → `TRIAGE_MAXTURNS_MODERATE` (default `30`), `complex` → `TRIAGE_MAXTURNS_COMPLEX` (default `50`). The mapped budget MUST be applied to the dispatched agent regardless of which target was chosen. If triage did not run or returned an unknown complexity, the platform MUST fall back to `DEFAULT_MAXTURNS` (default `30`). All four values MUST be operator-adjustable without a code change. (See `data-model.md` §Config Surface for the canonical table.)
- **FR-009**: Triage failures (timeout, provider error, malformed response, unknown mode) MUST fall back to the configured default dispatch mode without losing the event and MUST be logged with the delivery id.
- **FR-010**: The platform MUST surface the dispatch decision in the user-visible tracking comment, including chosen target and reason, and — when triage ran — confidence and rationale in a collapsible section. The `reason` value MUST be drawn from the canonical enum: `label` (FR-004), `keyword` (FR-005), `static-default` (no label/keyword match in a non-auto mode), `triage` (auto-mode triage at or above threshold), `default-fallback` (auto-mode triage below threshold), `triage-error-fallback` (auto-mode triage timed out, failed, or returned an unknown mode), `infra-absent` (FR-018 — isolated-job infrastructure missing), and `capacity-rejected` (FR-018 — pending queue at configured maximum).
- **FR-011**: Requests routed to the isolated-job target MUST receive an expanded tool allow-list that includes container tooling (build, compose, run) and shell-level utilities not granted to inline, daemon, or shared-runner executions.
- **FR-012**: The isolated-job target MUST be ephemeral: a fresh pod and workspace per request, torn down automatically after completion, failure, or timeout, with no filesystem or container artefacts persisted between requests.
- **FR-013**: The platform MUST record, for every processed webhook, the dispatch mode, dispatch reason, triage cost and confidence (when applicable), final execution cost, duration, and outcome.
- **FR-014**: The platform MUST expose aggregate statistics over a rolling 30-day window covering events-per-mode, triage invocation rate, average confidence, fallback rate, and total triage spend.
- **FR-015**: The platform MUST remain rollback-safe: reverting the dispatch-mode configuration to inline MUST restore pre-feature behaviour without data migration and without dropping in-flight events.
- **FR-016**: Label precedence over keywords, and over triage, MUST be deterministic and documented; the router MUST NOT invoke a triage call when any explicit label is present.
- **FR-017**: The router MUST NOT invoke a triage call when the configured mode is anything other than auto.
- **FR-018**: When the isolated-job target is at capacity, the platform MUST enqueue the request in an application-level queue (backed by Valkey) and MUST surface the queue position in the tracking comment in the form "queued, position N of M." The webhook pod MUST drain the queue as isolated-job capacity frees. If the queue length exceeds a configurable maximum, the request MUST be rejected gracefully with an explanatory tracking comment. If the isolated-job infrastructure is entirely absent (e.g. non-cluster deployment), the platform MUST reject rather than enqueue and MUST NOT silently downgrade to the shared-runner or daemon targets.
- **FR-019**: Per-event idempotency guarantees from the existing router MUST continue to hold across all dispatch modes; a retried delivery id MUST NOT cause duplicate triage billing or duplicate execution.
- **FR-020**: The platform MUST implement a rate-limited circuit breaker for sustained triage-provider failures so that a broken triage model cannot be called on every event during an outage.
- **FR-021**: When an isolated-job execution fails mid-run (container crash, sidecar failure, OOM, wall-clock timeout), the platform MUST NOT automatically retry on any target. It MUST record the failure with exit reason and a log reference (where available) in the execution history, update the tracking comment with the same information, and leave re-triggering to the maintainer.

### Key Entities _(include if feature involves data)_

- **Dispatch Decision**: The record of how a given webhook was routed. Attributes: delivery id, chosen target (inline / daemon / shared-runner / isolated-job), reason (one of the canonical enum listed in FR-010: `label`, `keyword`, `static-default`, `triage`, `default-fallback`, `triage-error-fallback`, `infra-absent`, `capacity-rejected`), timestamp. One per processed event.
- **Triage Result**: The structured output of a triage call. Attributes: `mode` (daemon / shared-runner / isolated-job), mode-confidence score, `complexity` (trivial / moderate / complex), one-sentence rationale, cost, latency, provider / model identifier, delivery id. One per triage invocation; zero per event when triage is bypassed.
- **Execution Record**: The outcome of executing the dispatched workload, extended to reference the dispatch decision and the triage result (if any). Attributes in addition to those already recorded by the platform: dispatch mode, dispatch reason, triage confidence (if triage ran), triage cost (if triage ran).
- **Dispatch Mode Configuration**: The platform-wide configuration controlling which modes are enabled, the default fallback mode, the confidence threshold, the triage timeout, the complexity→maxTurns mapping, the isolated-job concurrency ceiling, and the pending-queue maximum length. One per deployment.
- **Pending Isolated-Job Queue Entry**: A queued request awaiting isolated-job capacity. Attributes: delivery id, enqueue timestamp, triage result (if any), originating PR/issue reference. Stored in Valkey with a bounded maximum length; drained FIFO by the webhook pod as capacity frees.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: In auto mode, at least 90% of processed webhooks are routed without ambiguity by labels or static rules alone (i.e. fewer than 10% of events invoke triage), measured over a rolling 7-day window.
- **SC-002**: When triage is invoked, the added latency visible to the maintainer (from webhook acknowledgement to tracking comment update) increases by no more than 500 ms at the 95th percentile compared to the inline baseline.
- **SC-003**: Per-event triage spend averages less than US$0.005 across a rolling 30-day window, and total monthly triage spend at 1,000 events/day stays under US$5.
- **SC-004**: Triage-attributable execution failures (wrong-mode routing that materially fails the task) stay below 2% of triaged events across a rolling 7-day window, measured as the share of triaged events that required maintainer relabel-and-retry.
- **SC-005**: When the triage provider is fully unavailable, the platform continues to process 100% of webhooks via the configured default mode, and total error-path cost (retries against the broken provider) stays below US$1 per hour of outage.
- **SC-006**: Reverting the dispatch mode to inline restores the pre-feature processing path within one configuration change and zero data migration, verified by a restored-configuration smoke test.
- **SC-007**: For every processed webhook, the tracking comment contains a dispatch decision summary sufficient for a maintainer to answer "why did the bot route this here?" without reading logs.

## Assumptions

- The existing webhook acknowledgement path (respond 200 within 10 seconds, then process asynchronously) is retained; no dispatch step may block acknowledgement.
- The persistent daemon path already exists from Phase 2 and remains unchanged; the new shared-runner target is a separate in-cluster Deployment introduced by this feature.
- A single cheap, fast chat-completion model is available for triage via either a direct provider API or an AWS Bedrock path, matching the platform's existing authentication modes.
- "Clear-cut" explicit labels are limited to two values in the initial scope (`bot:shared`, `bot:job`); additional labels can be added later without changing the cascade.
- The confidence threshold ships at a strict default of `1.0` (accept only fully-certain triage) and is operator-configurable; it is expected to be lowered toward a documented operating value of ≈0.75 in a follow-up once SC-004 telemetry justifies it.
- The isolated environment's infrastructure (the backing container-capable runtime) is provisioned outside this feature's scope; this feature depends on but does not deliver that infrastructure, and must fall back safely when it is absent.
- Execution-history storage and per-execution cost tracking already exist from Phase 2 and only need extension with dispatch-decision and triage fields.
- The existing idempotency layer (in-memory map plus durable tracking-comment check) continues to cover dispatch decisions without modification.
- Maintainer-visible tracking comments already support collapsible sections; this feature adds content to existing comments rather than introducing a new comment type.
