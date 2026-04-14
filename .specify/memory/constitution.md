<!-- Sync Impact Report
  Version change: 1.2.0 → 1.2.1
  Modified sections:
    - Technology Constraints > AI orchestration: added a carve-out
      permitting non-agent single-turn inference (classification,
      embedding, summarisation) through a dedicated client adaptor
      under `src/ai/` using the raw Anthropic or Bedrock SDKs.
      Multi-turn tool-using flows remain exclusively on
      `@anthropic-ai/claude-agent-sdk`. Enforcement is triple-gated:
      spec contract, runtime guards in the adaptor, and fail-fast
      config validation.
  Rationale: unblocks the dispatch-triage feature
    (specs/20260415-000159-triage-dispatch-modes). The triage call
    is a single-turn, no-tool classification; the prior blanket ban
    was intended to prevent agent-loop bypasses, not pure
    inference. The carve-out is guarded by the circuit-breaker,
    latency, and cost requirements in FR-020, SC-003, and SC-005
    of that spec. PATCH-level per §Amendment Procedure — existing
    guidance is clarified, no principle removed or redefined.
  Added sections: None
  Removed sections: None
  Templates requiring updates:
    - .specify/templates/plan-template.md ✅ no changes needed
    - .specify/templates/spec-template.md ✅ no changes needed
    - .specify/templates/tasks-template.md ✅ no changes needed
  Follow-up TODOs: None
-->

<!-- Sync Impact Report (historical)
  Version change: 1.1.0 → 1.2.0
  Modified sections:
    - Architecture Constraints > Single Server Model: added daemon
      worker process acknowledgment (WebSocket clients permitted as
      separate OS processes sharing codebase and Docker image)
  Added sections: None
  Removed sections: None
  Templates requiring updates:
    - .specify/templates/plan-template.md ✅ no changes needed
    - .specify/templates/spec-template.md ✅ no changes needed
    - .specify/templates/tasks-template.md ✅ no changes needed
  Follow-up TODOs: None
-->

<!-- Sync Impact Report (historical)
  Version change: 1.0.0 → 1.1.0
  Modified principles:
    - V. Test Coverage → V. Test Coverage (expanded with coverage
      thresholds and documentation-only exception)
  Added sections:
    - Principle VIII. Documentation Standards (new principle)
    - Technology Constraints (new top-level section)
    - Documentation Gate (new subsection under Development Workflow)
    - Pre-commit Gate (new subsection under Development Workflow)
    - Quarterly Compliance Audit (added to Governance > Compliance
      Review)
  Modified sections:
    - Quality Gate now references unified `bun run check` command
    - Compliance Review expanded with quarterly audit requirement
  Removed sections: None
  Templates requiring updates:
    - .specify/templates/plan-template.md ✅ no changes needed
    - .specify/templates/spec-template.md ✅ no changes needed
    - .specify/templates/tasks-template.md ✅ no changes needed
  Follow-up TODOs:
    - Add `check` script to package.json:
      "check": "bun run typecheck && bun run lint && bun run format && bun test"
-->

# GitHub App Playground Constitution

## Core Principles

### I. Strict TypeScript and Bun Runtime

All code MUST use TypeScript in strict mode with zero `any` types.
Bun is the primary runtime for the application server and test runner.
Node.js is permitted only where required by external tooling (e.g.,
Claude Code CLI). `bun test` is the sole test framework; Jest and
Vitest are forbidden. ESLint 9 flat config with TypeScript type-aware
rules handles linting; Prettier handles formatting; `tsc --noEmit`
handles type checking. All three MUST pass before any PR merges.

**Rationale**: A single runtime eliminates environment drift. Strict
typing with `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, and `useUnknownInCatchVariables` catches
defects at compile time rather than production.

### II. Async Webhook Safety

The webhook server MUST respond to GitHub within 10 seconds. All
heavy processing (repo cloning, AI agent execution, comment updates)
MUST run asynchronously after the HTTP 200 response. Long-running
operations MUST NOT block the event loop or delay webhook
acknowledgement.

- The server MUST expose health endpoints (`/healthz`, `/readyz`)
  that accurately reflect liveness and readiness state.
- Graceful shutdown MUST drain in-flight requests before terminating.
- Resource cleanup (temp directories, child processes) MUST be
  guaranteed even when operations fail or time out.

**Rationale**: GitHub retries unacknowledged webhooks, causing
duplicate processing. Blocking the event loop risks cascading
failures across all concurrent requests.

### III. Idempotency and Concurrency Control

Every webhook event MUST be processed at most once. The system MUST
implement a two-layer idempotency guard: a fast in-memory check for
the common case and a durable external check (e.g., GitHub tracking
comment) that survives process restarts.

- Concurrent AI agent executions MUST be bounded by a configurable
  limit. Requests exceeding the limit MUST be rejected with a clear
  user-facing message, not silently dropped.
- Idempotency keys MUST be derived from the webhook delivery ID
  provided by GitHub, not generated internally.

**Rationale**: Pod restarts, OOM kills, and GitHub retries create
real-world duplicate delivery scenarios. Unbounded concurrency risks
API budget exhaustion and resource starvation.

### IV. Security by Default

- Zero hardcoded secrets. All credentials MUST come from environment
  variables validated by the Zod config schema at startup.
- Webhook payloads MUST be verified via HMAC-SHA256 signature before
  any processing occurs. Unverified payloads MUST be rejected.
- Repository credentials used for cloning MUST be scoped to the
  minimum required permissions and cleaned up after use.
- AI agent execution MUST be sandboxed to a temporary directory with
  no access to the server's runtime environment or secrets.
- User-provided content (PR bodies, comments, review text) MUST be
  treated as untrusted input when constructing prompts or commands.

**Rationale**: The application handles GitHub App private keys,
API tokens, and executes AI agents with file system access.
Defense-in-depth at every layer assumes any single control can fail.

### V. Test Coverage (NON-NEGOTIABLE)

Every module that handles security-critical operations (webhook
verification, credential management, idempotency), core pipeline
logic (routing, context building, prompt construction), and utility
functions MUST have unit tests.

- Security-critical modules (webhook verification, credential
  handling, sanitization, config parsing) MUST maintain ≥90% line
  coverage.
- All other modules MUST maintain ≥70% line coverage.
- New features MUST include tests that exercise both the success path
  and at least one error/edge-case path before the PR is mergeable.
- External dependencies (GitHub API, Claude Agent SDK) MUST be mocked
  in tests. No real API calls in the test suite.
- Test files MUST be co-located with the modules they test or placed
  in a parallel `test/` directory mirroring the source structure,
  using the `*.test.ts` naming convention.
- Coverage is measured via `bun test --coverage`. The CI pipeline
  (`bun run check`) MUST pass before any merge.
- Documentation-only changes are exempt from the automated test-case
  requirement only when all changed files are limited to
  repository-hosted documentation and feature-planning artifacts, and
  the change does not alter runtime source files, exported symbols,
  configuration schemas, or CI automation. These changes MUST still
  run `bun run check` before merge and validate any introduced or
  modified Mermaid diagrams.

**Rationale**: A webhook server that processes untrusted input and
orchestrates AI agents has a high blast radius for regressions.
Automated tests are the primary safety net.

### VI. Structured Observability

All logging MUST use structured JSON via `pino` with child loggers
scoped per request. `console.log`, `console.warn`, `console.error`,
and `console.info` are forbidden in production source code.

- Every webhook request MUST be traceable by delivery ID through the
  entire processing pipeline.
- AI agent execution cost (tokens, duration) MUST be logged after
  every request for budget attribution and anomaly detection.
- Error conditions MUST be logged with sufficient context (event type,
  delivery ID, repository, error message) to diagnose without
  reproducing.

**Rationale**: A fire-and-forget async architecture makes post-hoc
debugging essential. Structured logging with request-scoped context
enables filtering and alerting without log parsing heuristics.

### VII. MCP Server Extensibility

MCP (Model Context Protocol) servers are the extension mechanism for
AI agent capabilities. New tool integrations MUST be implemented as
MCP servers registered through the server registry.

- Each MCP server MUST have a single, well-defined responsibility.
- MCP servers MUST NOT access application state directly; they
  receive context through their initialization parameters.
- The MCP server registry MUST be the sole mechanism for resolving
  which servers are active for a given request.

**Rationale**: The MCP pattern provides a clean boundary between the
webhook orchestration layer and AI agent tooling. New capabilities
can be added without modifying the core pipeline.

### VIII. Documentation Standards

All exported functions, classes, interfaces, and types MUST have
JSDoc comments. Repository-hosted explanatory documentation MUST use
Mermaid diagrams when a visual explanation materially improves reader
comprehension of a flow, structure, lifecycle, or interaction
compared with prose alone. Documentation MUST stay concise, MUST
explain _what_ exists and _why_ it matters, and MUST avoid decorative
diagrams that do not add explanatory value.

- `@param`, `@returns`, and `@throws` tags MUST be present for
  public API functions that have multiple parameters, non-void return
  values, or documented error conditions.
- Internal (non-exported) helpers are RECOMMENDED to have JSDoc when
  logic is non-trivial, but it is not strictly required.
- Documentation MUST be updated in the same commit as any change that
  alters a symbol's observable behavior, signature, or semantics.
  Stale JSDoc is treated as a documentation defect.
- Repository docs that describe architecture, workflow, state
  changes, or other decision-heavy interactions MUST include a
  Mermaid diagram when that diagram makes the explanation faster or
  less ambiguous for readers.
- Mermaid diagrams MUST be authored for comprehension, not
  decoration. They MUST reflect the documented behavior accurately,
  use labels that stand on their own, and remain small enough to
  review without reverse-engineering the surrounding prose.
- Every Mermaid diagram introduced or modified in repository-hosted
  docs MUST be validated before merge. Invalid Mermaid syntax is
  treated as a documentation defect.
- Auto-derived types (e.g., `z.infer<typeof Schema>`) are exempt
  from inline JSDoc but MUST have a one-line comment at the
  declaration site identifying the source schema.
- `@deprecated` MUST be applied to any symbol scheduled for removal
  and MUST include a brief migration note pointing to the
  replacement.

**Rationale**: Stale or missing documentation creates knowledge silos
and slows onboarding. Requiring same-commit updates prevents
documentation drift from becoming systemic.

## Technology Constraints

- **Runtime**: Bun ≥1.3.8. Node.js is permitted only for external
  tooling that requires it (e.g., Claude Code CLI); direct Node.js
  execution is not a supported target for application code.
- **Language**: TypeScript in strict mode (`"strict": true` in
  `tsconfig.json`). `any` MUST be avoided; use `unknown` with Zod
  parsing for external data.
- **Schema validation**: Zod. Manual validation or alternative schema
  libraries MUST NOT replace Zod for config or input parsing.
- **Linting**: ESLint 9 flat config with `@typescript-eslint`,
  `eslint-plugin-security`, and `eslint-plugin-simple-import-sort`.
  No other linting tools MUST be added without a constitution
  amendment.
- **Formatting**: Prettier. No other formatting tools MUST be added
  without a constitution amendment.
- **Testing**: `bun test`. Jest, Vitest, and other test runners MUST
  NOT be added.
- **Logging**: `pino`. No other logging libraries MUST be introduced
  for production source code.
- **HTTP framework**: `octokit` App class for webhook handling. No
  additional HTTP frameworks (Express, Fastify, Hono) MUST be added
  without a constitution amendment.
- **AI orchestration**: `@anthropic-ai/claude-agent-sdk` for all
  multi-turn, tool-using agent flows. Non-agent single-turn
  inference (classification, embedding, summarisation) MAY use the
  raw Anthropic or Bedrock SDKs via a dedicated client adaptor
  module under `src/ai/`, provided **all three** of the following
  hold: (a) the calling feature's spec documents the circuit-breaker,
  latency cap, and cost-budget requirements; (b) the adaptor or call
  site enforces those guards at runtime (not merely at review time);
  and (c) any credentials, model IDs, and budget / timeout knobs are
  validated fail-fast at startup via the Zod config schema. Multi-turn
  tool-using flows MUST continue to use `@anthropic-ai/claude-agent-sdk`.
- **MCP**: `@modelcontextprotocol/sdk` for tool server
  implementations.
- **Git hooks**: Husky + lint-staged. Lefthook or other hook managers
  MUST NOT replace these without a constitution amendment.
- **Commit enforcement**: Commitlint with Conventional Commits.

## Architecture Constraints

### Single Server Model

The application is a single HTTP server process. All webhook routing,
async processing, and MCP server management happen within one
process. Complexity MUST NOT be introduced through microservice
decomposition unless the single-process model demonstrably fails to
meet scaling requirements. Daemon worker processes that connect as
WebSocket clients to the server are permitted — they share the
codebase and Docker image but run as separate OS processes with a
distinct entrypoint. They are clients, not decomposed services.

### Pipeline Architecture

Request processing follows a linear pipeline: event parsing, trigger
detection, context building, data fetching, prompt construction,
repo checkout, agent execution, result reporting. Pipeline stages
MUST be composable and independently testable. Stages MUST NOT be
bypassed or reordered outside the orchestrator.

### Code Style

- Named exports everywhere. Default exports are forbidden.
- All runtime configuration MUST be validated via Zod schemas at
  startup. The application MUST fail fast on invalid configuration.
- All runtime input validation uses Zod schemas.
- One logical concern per file. Event handlers, pipeline stages,
  and MCP servers each get their own file.

### Repository Checkout

Each webhook request that triggers AI agent execution MUST clone the
target repository to an isolated temporary directory. The agent
operates on this local clone, never on shared state. Temp directories
MUST be cleaned up after execution completes or fails.

## Development Workflow

### Quality Gate

After completing any implementation, `bun run check` MUST pass
before committing. This runs typecheck, lint, format check, and test
sequentially. Never commit code that fails `bun run check`. The CI
pipeline enforces this gate on every PR.

### Pre-commit Gate

Husky + lint-staged runs Prettier formatting and ESLint auto-fix on
every commit for staged files. Commitlint validates commit message
format via the `commit-msg` hook. Commits that bypass these checks
(e.g., `--no-verify`) MUST NOT be pushed to shared branches.

### CI Pipeline

The CI pipeline runs `bun run check` (typecheck → lint → format →
test) and `bun run build` on every push to feature branches. Releases
are driven by **semantic-release** on merge to `main`. Docker images
are built for `linux/amd64` and `linux/arm64` on version bumps.

### Commit Messages

Follow Conventional Commits: `feat:`, `fix:`, `docs:`, `chore:`,
`refactor:`, `test:`, `perf:`, `build:`, `ci:`. Commitlint enforces
this via Husky's `commit-msg` hook. One logical change per commit.
Never commit `.env` files, secrets, or generated `dist/` directories.

### Branch Strategy

Feature branches off `main` MUST use timestamp naming:
`YYYYMMDD-HHMMSS-<slug>` (e.g., `20260409-130000-add-review-tool`).
Pass `--timestamp` when creating branches via the
`create-new-feature` script. Sequential numeric prefixes (`001-`)
MUST NOT be used for new branches; they cause numbering collisions
when multiple developers work in parallel. Direct pushes to `main`
are forbidden.

### Dependency Additions

New runtime dependencies MUST be justified in the PR description.
Security-sensitive dependencies (crypto, network, fs) require
explicit review of the package's maintenance status and known
vulnerabilities before adoption.

### Documentation Gate

PRs MUST comply with Principle VIII (Documentation Standards).
Reviewers MUST reject PRs where exported symbols lack JSDoc, where
JSDoc describes outdated behavior, or where Mermaid diagrams are
missing for flows that would materially benefit from visual
explanation. Documentation updates MUST land in the same commit as
the implementation change — not as a follow-up.

## Governance

This constitution is the highest-authority document for GitHub App
Playground development decisions. It supersedes all other practices,
conventions, or ad-hoc agreements.

### Amendment Procedure

1. Propose the change with rationale in a PR modifying this file.
2. The change MUST include a Sync Impact Report (HTML comment at top)
   documenting version bump, affected principles, and template
   updates.
3. Version follows semantic versioning:
   - **MAJOR**: Principle removed, redefined, or made backward
     incompatible.
   - **MINOR**: New principle or section added, or existing guidance
     materially expanded.
   - **PATCH**: Clarifications, wording fixes, non-semantic
     refinements.
4. All dependent templates (plan, spec, tasks) MUST be reviewed for
   consistency after any amendment.

### Compliance Review

- Every PR review MUST verify compliance with these principles.
- Complexity that violates a principle MUST be justified in the PR
  description with a specific rationale.
- Runtime guidance for AI agents is maintained in `CLAUDE.md` and
  MUST stay consistent with this constitution.
- At least once per quarter, the codebase MUST be audited against
  these principles and issues filed for any drift discovered.

### Conflict Resolution

If a spec, plan, or task contradicts this constitution, the
constitution takes precedence. The conflicting artifact MUST be
amended to align.

**Version**: 1.2.1 | **Ratified**: 2026-04-09 | **Last Amended**: 2026-04-15
