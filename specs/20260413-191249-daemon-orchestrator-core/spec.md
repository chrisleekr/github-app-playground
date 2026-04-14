# Feature Specification: Daemon and Orchestrator Core

**Feature Branch**: `20260413-191249-daemon-orchestrator-core`
**Created**: 2026-04-13
**Status**: Draft
**Input**: User description: "Implement daemon and orchestrator core"

## Clarifications

### Session 2026-04-13

- Q: How does a daemon obtain a valid GitHub installation token for repo cloning? → A: Orchestrator mints a fresh installation token per job and includes it in the WebSocket task payload. Credential minting stays centralized in the server (which holds the GitHub App private key); daemons never receive App credentials.
- Q: How does a daemon authenticate when connecting via WebSocket? → A: Pre-shared secret — daemon sends a shared key in the WebSocket handshake `Authorization` header; orchestrator validates it. Sufficient for Phase 2 trusted-network scope; can upgrade to JWT or mTLS in Phase 5.
- Q: Can a single daemon process multiple jobs simultaneously? → A: Daemon self-regulates (offer/accept/reject). Orchestrator sends a lightweight job offer; daemon checks its own real-time resource usage (CPU, memory, disk, active jobs) and accepts or rejects. No static concurrency cap — daemon is the authority on its own capacity.
- Q: When Valkey is unavailable, how should the system behave? → A: Hard dependency. When `agentJobMode` is non-inline and Valkey is down, new requests are rejected with an error comment. Operator must fix Valkey before daemon dispatch resumes. Inline-only deployments (no Valkey configured) are unaffected.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Daemon Registration and Heartbeat (Priority: P1)

A daemon process running on a developer machine or server connects to the central webhook server, announces its identity and capabilities (available tools, OS, resources), and continuously signals that it is alive. The webhook server maintains an up-to-date registry of available daemons so the orchestrator can make informed dispatch decisions.

**Why this priority**: Without daemon registration and health tracking, the orchestrator has no knowledge of available execution targets. This is the foundational building block — all other dispatch modes depend on knowing which daemons exist and are healthy.

**Independent Test**: Can be fully tested by starting a daemon process that connects to the server, verifying the daemon appears in the registry as "active", then stopping the daemon and confirming it transitions to "inactive" after the heartbeat timeout.

**Acceptance Scenarios**:

1. **Given** a daemon process starts with valid credentials, **When** it connects to the webhook server, **Then** the server registers it in the daemons registry with status "active", recording its hostname, platform, OS version, capabilities, and resource profile.
2. **Given** a registered daemon, **When** it sends periodic heartbeat signals, **Then** the server updates `last_seen_at` and the daemon remains "active".
3. **Given** a registered daemon, **When** the server has not received a heartbeat within the configured timeout, **Then** the daemon's status transitions to "inactive" and it is no longer eligible for task dispatch.
4. **Given** a daemon that was previously "inactive", **When** it reconnects and resumes heartbeating, **Then** its status transitions back to "active" and it becomes eligible for dispatch again.
5. **Given** multiple daemons registered simultaneously, **When** the orchestrator queries available daemons, **Then** only daemons with "active" status and a recent heartbeat are returned.

---

### User Story 2 - Orchestrator Dispatch Decision (Priority: P2)

When a new webhook event triggers processing (e.g., an `@chrisleekr-bot` mention), the orchestrator decides how to execute the request. It evaluates the request context and the current state of available daemons to choose the best dispatch mode: run it inline (current behavior), queue it for a shared-runner daemon, or assign it to a specific daemon based on capability matching.

**Why this priority**: The dispatch decision is the core value proposition — it upgrades the system from single-mode (inline-only) to multi-mode execution. However, it depends on P1 (daemon registry) to have any non-inline targets to dispatch to.

**Independent Test**: Can be tested by configuring different dispatch rules and verifying that requests are routed to the correct execution path — inline when no daemons are available, daemon when a matching daemon is registered and active.

**Acceptance Scenarios**:

1. **Given** a new request arrives and no daemons are registered or active, **When** the orchestrator evaluates dispatch, **Then** it falls back to inline execution (preserving current behavior).
2. **Given** a new request arrives and one or more active daemons are available, **When** the orchestrator evaluates dispatch, **Then** it sends a lightweight job offer (metadata only) to the most appropriate daemon based on capability matching (ranked by: required tool availability, then cached repo preference, then least active jobs, with ephemeral daemons deprioritized for long-running jobs — defined as estimated >30 agent turns).
3. **Given** a daemon receives a job offer, **When** it evaluates its real-time resource availability (CPU, memory, disk, active jobs), **Then** it responds with accept or reject.
4. **Given** a daemon rejects a job offer, **When** the orchestrator receives the rejection, **Then** it tries the next eligible daemon or queues the job for later dispatch.
5. **Given** a daemon accepts a job offer, **When** the orchestrator receives the acceptance, **Then** it sends the full task payload and the execution record is created with `dispatch_mode` and `daemon_id` set accordingly.
6. **Given** a daemon does not respond to a job offer within a timeout, **When** the timeout expires, **Then** the orchestrator treats it as a rejection and tries the next eligible daemon or falls back to inline execution.
7. **Given** concurrent requests arrive exceeding available daemon capacity, **When** the orchestrator evaluates dispatch, **Then** it queues excess requests and processes them as daemons become available, respecting the configured concurrency limit.

---

### User Story 3 - Task Communication Between Server and Daemon (Priority: P2)

The webhook server and daemon processes need a reliable communication channel to exchange task assignments, status updates, and results. The server pushes task assignments to daemons and daemons report back progress and completion. This communication must survive transient network interruptions gracefully.

**Why this priority**: Same priority as dispatch — without a communication mechanism, the orchestrator cannot send work to daemons or receive results. This is tightly coupled with P2 dispatch but separated as a distinct story because it defines the contract between server and daemon.

**Independent Test**: Can be tested by dispatching a task to a daemon, verifying the daemon receives the full task payload (context, prompt, tools), and confirming the daemon's result (success/failure, cost, duration) is delivered back to the server.

**Acceptance Scenarios**:

1. **Given** the orchestrator assigns a task to an active daemon, **When** the assignment is sent, **Then** the daemon receives the complete task payload including repository context, prompt, allowed tools configuration, and execution parameters.
2. **Given** a daemon is processing a task, **When** it completes execution, **Then** it reports back the result (success/failure, cost, duration, number of turns) to the server.
3. **Given** a daemon loses connectivity temporarily, **When** the connection is restored (daemon reconnects via ws-client auto-reconnect), **Then** the orchestrator detects orphaned task assignments via FM-1 cleanup and either re-queues them for a new offer cycle or marks them as failed. Late results from the previous session are handled by FM-6 (logged and discarded if the execution was already finalized).
4. **Given** a daemon receives a task for a repository it cannot access, **When** it detects the access failure, **Then** it reports the error back to the server so the orchestrator can reassign or fail the execution.

---

### User Story 4 - Execution Lifecycle Tracking (Priority: P3)

Each request processed through the orchestrator — whether dispatched inline or to a daemon — is tracked from creation through completion. Operators can observe the current state of all executions (queued, running, completed, failed) and see which daemon handled each request, how long it took, and what it cost.

**Why this priority**: Lifecycle tracking is essential for operational visibility and debugging, but the system can function (dispatch and execute) without it. The existing `executions` table schema already supports this; this story ensures the orchestrator and daemons write to it consistently.

**Independent Test**: Can be tested by triggering a request, verifying the execution record progresses through status transitions (queued -> running -> completed/failed), and confirming cost, duration, and daemon assignment are recorded.

**Acceptance Scenarios**:

1. **Given** the orchestrator creates an execution record for a new request, **When** the record is persisted, **Then** it includes delivery ID, repository details, entity info, dispatch mode, and initial status "queued".
2. **Given** an execution is assigned to a daemon and starts processing, **When** the daemon begins work, **Then** the status transitions to "running" and `started_at` is recorded.
3. **Given** an execution completes successfully, **When** the daemon reports results, **Then** the status transitions to "completed" with `cost_usd`, `duration_ms`, `num_turns`, and `completed_at` populated.
4. **Given** an execution fails, **When** the daemon reports an error, **Then** the status transitions to "failed" with `error_message` and `completed_at` populated.
5. **Given** a daemon goes inactive mid-execution, **When** the heartbeat timeout is reached, **Then** the orphaned execution is detected and either reassigned or marked as failed with a descriptive error.

---

### User Story 5 - Daemon Graceful Shutdown and Auto-Update (Priority: P2)

When a daemon process receives a termination signal (SIGTERM/SIGINT) or is notified of a version mismatch by the orchestrator, it shuts down gracefully — signaling the orchestrator that it is draining, completing any active jobs within a configurable timeout, then disconnecting cleanly. On ephemeral infrastructure (spot instances, preemptible VMs), the daemon adapts its drain timeout to the platform's termination deadline.

**Why this priority**: Ungraceful daemon shutdowns cause orphaned executions, wasted compute, and stale "Working..." comments on GitHub. Graceful drain is essential for operational safety during deploys, scaling events, and spot instance reclaims. Auto-update enables zero-downtime version rollouts across the daemon fleet.

**Independent Test**: Send SIGTERM to a daemon with an active job, verify it sends `daemon:draining`, completes the job, then disconnects with WebSocket close code 1000. Start a daemon with a mismatched `appVersion`, verify the orchestrator sends `daemon:update-required` and the daemon follows its configured strategy.

**Acceptance Scenarios**:

1. **Given** a daemon receives SIGTERM while processing a job, **When** the signal handler fires, **Then** the daemon sends `daemon:draining` to the orchestrator, completes the active job, and disconnects with close code 1000.
2. **Given** the orchestrator receives `daemon:draining`, **When** it processes the message, **Then** it removes the daemon from dispatch eligibility but keeps the WebSocket connection open for active job results.
3. **Given** a daemon's drain timeout expires with jobs still running, **When** the timeout fires, **Then** the daemon force-terminates agent subprocesses, cleans up temp directories, and disconnects with `process.exit(1)`.
4. **Given** a daemon running on an ephemeral instance (e.g., AWS Spot), **When** the platform issues a termination warning, **Then** the daemon initiates graceful shutdown with a drain timeout capped to the platform's deadline minus a 10-second safety margin.
5. **Given** the orchestrator detects a daemon with a mismatched `appVersion`, **When** it sends `daemon:update-required`, **Then** the daemon acknowledges with its configured strategy (`exit`, `pull`, or `notify`) and initiates graceful drain after a configurable delay.
6. **Given** multiple daemons receive `daemon:update-required` simultaneously, **When** each acknowledges, **Then** their drain start times are staggered via configurable delay plus random jitter to prevent thundering herd.

---

### User Story 6 - MCP Capability Injection (Priority: P3)

When a Claude agent executes on a daemon (rather than inline), it needs awareness of the daemon's local environment — available tools, platform, resources — to make informed decisions about which commands to use. The system injects daemon capability information into the agent's context via a system prompt header and an MCP server tool.

**Why this priority**: Without environment awareness, the Claude agent may attempt to use tools unavailable on the daemon or miss tools that are available. This story enhances execution quality but does not block basic daemon execution — jobs work without it.

**Independent Test**: Dispatch a job to a daemon, verify the system prompt includes a daemon environment header, and verify the `daemon-capabilities` MCP tool is available to the agent and returns accurate capability data.

**Acceptance Scenarios**:

1. **Given** a job is dispatched to a daemon, **When** the system prompt is constructed, **Then** it includes a one-paragraph environment header describing the daemon's platform, available tools, and resource profile.
2. **Given** a Claude agent executing on a daemon, **When** it queries the `daemon-capabilities` MCP tool, **Then** it receives the full `DaemonCapabilities` JSON for the executing daemon.
3. **Given** inline execution mode, **When** the system prompt is constructed, **Then** no daemon environment header is injected and the `daemon-capabilities` MCP server is not registered.

---

### Edge Cases

- What happens when all registered daemons become inactive simultaneously during a burst of incoming requests? The system falls back to inline execution for all pending and new requests.
- How does the system handle a daemon that reports completion for an execution that has already been reassigned due to timeout? The late result is logged but discarded — the reassigned execution's result takes precedence.
- What happens when Valkey is unavailable in non-inline mode? See FR-004a — new requests are rejected with an error comment; no silent degradation to inline. `/readyz` reports 503.
- What happens when the database (Postgres) is unavailable in non-inline mode? Execution record creation (FR-005) fails, causing the dispatch to abort. The error is surfaced to the user via an error comment on the PR/issue. Unlike Valkey, no separate runtime health check is needed — database connectivity is validated at startup and errors propagate naturally through execution record operations. Inline-only deployments (no Valkey/database configured) are unaffected by either scenario.
- How does the system handle a daemon registering with the same ID as an existing active daemon (e.g., after a crash and restart)? The registration is treated as a reconnection — the existing record is updated rather than creating a duplicate.
- What happens when the server restarts? In-flight daemon-dispatched executions are detected via "running" status records with stale `started_at` timestamps and are marked as failed or eligible for retry.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: System MUST maintain a registry of connected daemons, tracking each daemon's identity, capabilities, resource profile, and health status.
- **FR-002**: System MUST detect inactive daemons via heartbeat timeout and remove them from dispatch eligibility.
- **FR-003**: System MUST support multiple dispatch modes: `inline` (existing behavior, default), `shared-runner`, and `ephemeral-job` for daemon-based execution, plus an `auto` mode that falls back to inline when no daemons are available. The `AGENT_JOB_MODE` configuration determines which mode is active. Note: `auto` is a configuration selector, not a recorded value. When `auto` dispatches to a daemon, the execution record MUST store `dispatch_mode = 'shared-runner'` (the effective runtime mode). When `auto` falls back to inline, it stores `dispatch_mode = 'inline'`. **Phase 2 scope**: Only `inline`, `shared-runner`, and `auto` are implemented in Phase 2. `ephemeral-job` is defined in the configuration schema and data model for forward compatibility but has no distinct runtime behavior — it is treated identically to `shared-runner` until Phase 3+ adds K8s-specific dispatch logic.
- **FR-004**: System MUST preserve full backward compatibility for inline-only deployments — when `agentJobMode=inline` (default) and no database or Valkey is configured, behavior is unchanged with zero configuration changes.
- **FR-004a**: When `agentJobMode` is non-inline, Valkey is a hard dependency. If Valkey is unavailable, the system MUST reject new requests with an error comment rather than silently degrading to inline. Daemon dispatch resumes automatically when Valkey recovers.
- **FR-005**: System MUST record every execution in the `executions` table with dispatch mode, assigned daemon (if any), status, cost, duration, and error information.
- **FR-006**: System MUST provide a communication channel between the server and daemon processes for task assignment and result reporting.
- **FR-007**: System MUST handle daemon failures mid-execution by detecting orphaned tasks and either reassigning them or marking them as failed.
- **FR-008**: System MUST enforce the existing concurrency limit across all dispatch modes combined, preventing total active executions from exceeding the configured maximum.
- **FR-009**: System MUST allow daemons to reconnect after disconnection and resume active status without manual intervention.
- **FR-010**: System MUST assign jobs to daemons based on capability matching — a daemon MUST only receive jobs it has the tools and resources to handle. At minimum, a daemon MUST have ≥512 MB free memory, ≥1 GB free disk, and all tools listed in the job's `requiredTools` field marked as functional before accepting a job offer. The `requiredTools` field is populated by the orchestrator: baseline always includes `git`, `bun`, `node`; additional tools are inferred from PR/issue labels (e.g., `bot:docker` → `docker`) and trigger body keywords. No CPU core floor is enforced (agent execution is IO-bound, not CPU-bound). No active job count cap is enforced — the daemon self-regulates via real-time resource checks per offer (see Clarification Q3).
- **FR-010a**: Orchestrator MUST use an offer/accept/reject protocol for job dispatch. The orchestrator sends a lightweight job offer (metadata only); the daemon evaluates its real-time resource availability and responds with accept or reject. On rejection, the orchestrator tries the next eligible daemon or queues the job.
- **FR-011**: Orchestrator MUST mint a fresh GitHub installation token per job assignment and include it in the task payload. Daemons MUST NOT hold GitHub App private keys or mint tokens independently.
- **FR-012**: Daemons MUST authenticate to the orchestrator using a pre-shared secret sent in the WebSocket handshake. The orchestrator MUST reject connections with invalid or missing credentials.
- **FR-013**: Daemon MUST handle SIGTERM/SIGINT gracefully by signaling the orchestrator that it is draining, completing active jobs within a configurable drain timeout (`DAEMON_DRAIN_TIMEOUT_MS`, default 300s), and disconnecting cleanly. Jobs still running when the drain timeout expires MUST be force-terminated and their resources cleaned up.
- **FR-014**: Orchestrator MUST detect protocol version and application version mismatches when a daemon registers. A major protocol version mismatch MUST reject the connection. An application version mismatch MUST trigger a `daemon:update-required` notification so the daemon can update according to its configured strategy (`exit`, `pull`, or `notify`).
- **FR-015**: System MUST expose daemon capabilities (available tools, platform, resources) to the Claude agent at runtime via an MCP server when running in daemon dispatch mode, enabling the agent to adapt its behavior to the daemon's environment.
- **FR-016**: Daemon MUST support platform-aware drain timeouts for ephemeral infrastructure (e.g., AWS Spot 2-minute warning, GCP Preemptible 30-second warning). The effective drain timeout MUST be the minimum of the configured timeout and the platform's termination deadline minus a safety margin.

### Key Entities

- **Daemon**: A persistent process that registers with the webhook server, advertises its capabilities (available tools, compute resources, platform), and executes assigned tasks. Identified by a unique ID, tracks hostname, platform, and health via heartbeat.
- **Execution**: A record of a single request being processed — from initial queuing through dispatch, execution, and completion. Links to the daemon that processed it (if not inline), records cost, duration, and outcome.
- **Job**: The unit of work dispatched from the orchestrator to a daemon. Follows an offer/accept/reject protocol: orchestrator sends a lightweight offer (metadata), daemon accepts or rejects based on real-time resource assessment, then orchestrator sends full payload on acceptance. Lifecycle: offered -> accepted/rejected -> running -> completed/failed. (Implementation uses `job:*` message prefix in the WebSocket protocol.)

### Terminology Mapping

The spec, protocol, and data model use related terms for overlapping concepts:

| User-Facing Term | WebSocket Protocol        | Postgres Table   | Scope                                                  |
| ---------------- | ------------------------- | ---------------- | ------------------------------------------------------ |
| Task             | `job:*` message prefix    | `executions` row | A unit of work from webhook trigger through completion |
| Daemon           | `daemon:*` message prefix | `daemons` row    | A persistent worker process                            |

"Task" is the user-facing concept (as in User Story 3 — "Task Communication"). "Job" is the wire-protocol term (message types: `job:offer`, `job:payload`, `job:result`). "Execution" is the durable record in Postgres tracking the full lifecycle. All three refer to the same logical unit of work at different abstraction layers.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: Existing inline-only deployments (no database, no daemons) continue to function identically with zero configuration changes (see FR-004).
- **SC-002**: A daemon can register, receive a job, execute it, and report results within the same end-to-end latency as inline processing plus at most 2 seconds of dispatch overhead (WebSocket handshake + offer/accept round-trip + token minting).
- **SC-003**: When a daemon fails mid-task, the system detects the failure and either reassigns or surfaces the error within the configured heartbeat timeout window.
- **SC-004**: The system correctly dispatches to available daemons under concurrent load — 10 simultaneous requests are distributed across available daemons without dropping or duplicating any.
- **SC-005**: Daemon reconnection after a network interruption restores the daemon to active status and dispatch eligibility within one heartbeat interval.
- **SC-006**: All execution records contain accurate dispatch mode, daemon assignment, timing, and cost data — queryable for operational visibility.

## Assumptions

- The existing `executions` and `daemons` database tables (from `001_initial.sql`) provide the correct schema foundation; additional columns or tables may be added via new migrations as needed.
- Daemons run in trusted environments (same network or authenticated endpoints). Authentication uses a pre-shared secret in the WebSocket handshake — sufficient for Phase 2 (same-cluster K8s); upgradable to JWT or mTLS in Phase 5 (multi-platform daemons over Tailscale).
- The existing concurrency limit (`MAX_CONCURRENT_REQUESTS`) applies globally across all dispatch modes, not separately per mode.
- Inline mode remains the default and requires no database or Valkey. Daemon dispatch mode requires both `DATABASE_URL` and Valkey to be configured and available — these are hard dependencies, not optional enhancements.
- Daemons are responsible for cloning repositories and having the Claude Code CLI available locally — the server does not transfer repository contents to daemons. The orchestrator provides a fresh short-lived GitHub installation token in each task payload for repo access.
- The heartbeat mechanism uses two configurable intervals: a **ping frequency** (`HEARTBEAT_INTERVAL_MS`, default 30,000ms) and a **pong timeout** (`HEARTBEAT_TIMEOUT_MS`, default 90,000ms). A daemon is declared inactive when it fails to respond to a ping within the timeout window.
- This feature targets the core dispatch and daemon lifecycle — advanced features like daemon auto-scaling, priority queuing, and cost-based routing are out of scope for this iteration.
