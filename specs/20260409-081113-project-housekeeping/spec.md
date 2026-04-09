# Feature Specification: Project Housekeeping

**Feature Branch**: `20260409-081113-project-housekeeping`
**Created**: 2026-04-09
**Status**: Draft
**Input**: User description: "Do housekeeping including document, code quality, testing"

## Clarifications

### Session 2026-04-09

- Q: Should CI pipeline improvements (security scanning, coverage gating, project setup fixes) be in scope? → A: Full CI overhaul — include coverage gating in CI, security scanning (dependency audit + container scan), secret scanning pre-commit hook, `.nvmrc` for Node.js version pinning, and missing `.github/labeler.yml` fix.
- Q: How should coverage thresholds be enforced given Bun has no native threshold support? → A: ~~Custom TypeScript script~~ (superseded — Bun natively supports `coverageThreshold`; see later clarification).
- Q: Which tool for secret scanning pre-commit hook? → A: `gitleaks` — Go binary with 100+ built-in patterns, `.gitleaks.toml` allowlist for false positives, integrated as Husky pre-commit hook.
- Q: Which tool for container image scanning in CI? → A: `trivy` (Aqua Security) — GitHub Action (`aquasecurity/trivy-action`) with SARIF output for GitHub Security tab integration.
- Q: Which tool for dependency vulnerability audit in CI? → A: `bun audit` — native to the project's Bun-first runtime, reads bun.lock directly.
- Q: GitHub Actions SHA pinning — should all actions be pinned to commit SHAs? → A: Out of scope for this housekeeping effort.
- Q: Custom coverage script vs. Bun native `coverageThreshold`? → A: Native only — use Bun's `coverageThreshold` in bunfig.toml. Drop the custom TypeScript script and per-module security-critical check.
- Q: Can we increase test threshold to 90%? → A: Yes — raise the global `coverageThreshold` from 70% to 90% line coverage.
- Q: Should ESLint config be modernized to unified `typescript-eslint` with `strictTypeChecked`? → A: Yes — migrate to unified package, use `strictTypeChecked` preset, fix deprecated `no-var-requires` rule.
- Q: Should Docker HEALTHCHECK be added to the Dockerfile? → A: Yes — add HEALTHCHECK using the existing `/healthz` endpoint.

### Session 2026-04-10 — Post-Review additions

After Phase 6 completed and PR #6 was opened, a senior code review (Phase 7) and automated PR reviewers (Copilot + CodeRabbit; Phase 8) surfaced additional scope. These clarifications are the authoritative record of the scope deltas.

- Q: Are `src/core/checkout.ts` and `src/core/executor.ts` required to have module-level unit tests for this housekeeping effort? → A: No — **deferred**. Bun runtime limitations prevent mocking the `bun` builtin (`$` template tag) and prevent `mock.module()` isolation across test files in the same process. Both modules remain transitively exercised through `router.test.ts` with module-level mocks. A follow-up issue MUST be filed before merge to track a dependency-injection refactor. FR-007/FR-008 updated inline with the waiver rationale.
- Q: Should security-motivated `package.json` `overrides` use caret ranges or exact version pins? → A: Exact version pins. Caret ranges defeat the purpose of CVE remediation because a future compatible release could reintroduce an advisory that auto-lands via `bun install`. Dependabot still opens PRs for exact-version bumps.
- Q: Should `aquasecurity/trivy-action` be pinned to a tag or used on `@master`? → A: Pinned tag (`@v0.35.0`). `@master` is a supply-chain risk, especially in a security-hardening PR.
- Q: Must trivy actually BLOCK the build on HIGH/CRITICAL CVEs, not just scan? → A: Yes. The step MUST set `exit-code: "1"` combined with `ignore-unfixed: true` so it blocks only on vulnerabilities that have available patches.
- Q: Must the gitleaks CI step scan the full git history or just the latest commit? → A: Full history. The checkout step MUST set `fetch-depth: 0` so `gitleaks detect` can scan all commits via `git log -p`.
- Q: Must `retryWithBackoff` validate its numeric options at call time? → A: Yes. `maxAttempts`, `initialDelayMs`, `maxDelayMs`, and `backoffFactor` MUST reject `NaN`, `Infinity`, values below their respective minimums, and (for `maxAttempts`) non-integers, with an error message that names the offending option and value. A prior latent bug allowed `maxAttempts: NaN` to throw literal `undefined`.
- Q: What threshold does Bun's `coverageThreshold` enforce — per-file or global? → A: Per-file. Any documentation claiming "global threshold" is inaccurate and MUST be corrected.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Contributor Runs Tests with Confidence (Priority: P1)

A developer contributing to the project runs the test suite and gets meaningful coverage reports that catch regressions in critical pipeline modules (prompt construction, data fetching, request routing). Currently, several core modules have zero or near-zero test coverage, meaning bugs in those paths would go undetected until production.

**Why this priority**: Untested code in the core pipeline (prompt-builder, fetcher, checkout, executor) is the highest-risk gap. A regression in prompt construction or data fetching silently breaks the entire bot without any test signal.

**Independent Test**: Can be validated by running `bun run test:coverage` and verifying that all tested files meet the >=90% per-file line coverage threshold enforced by Bun's native `coverageThreshold`.

**Acceptance Scenarios**:

1. **Given** the test suite is run, **When** `bun run test:coverage` completes, **Then** all modules in `src/core/` report >=90% line coverage
2. **Given** a developer modifies prompt construction logic, **When** they run the test suite, **Then** at least one test fails if the prompt structure is broken
3. **Given** a developer modifies data fetching logic, **When** they run the test suite, **Then** tests catch malformed response handling

---

### User Story 2 - New Contributor Reads Exported API Documentation (Priority: P2) — PRE-SATISFIED

> **Status**: No implementation work required. Research verified that all exported functions in `src/core/prompt-builder.ts`, all 5 webhook event handlers (`src/webhook/events/*.ts`), and `src/mcp/registry.ts` already have complete JSDoc comments with `@param`, `@returns`, and `@throws` tags.

**Independent Test**: Verified by reviewing all exported symbols in `src/` — 100% JSDoc coverage confirmed.

---

### User Story 3 - CI Pipeline Enforces Quality and Security Gates (Priority: P3)

A maintainer merges a PR and the CI pipeline automatically enforces minimum test coverage thresholds, runs dependency vulnerability audits, and scans container images for known CVEs. Currently, coverage is measured but not gated, and no security scanning exists in CI — violating constitution Principles IV (Security by Default) and V (Test Coverage).

**Why this priority**: Without enforced CI gates, coverage improvements from P1 will erode over time and security vulnerabilities can ship undetected. This automates constitutional compliance.

**Independent Test**: Can be validated by submitting a PR that deliberately reduces coverage below the threshold and confirming CI rejects it, and by verifying that security scan steps appear in CI workflow runs.

**Acceptance Scenarios**:

1. **Given** test coverage thresholds are configured in CI, **When** a PR reduces line coverage below 90% for any file with tests, **Then** the CI pipeline fails with a clear message (Bun's `coverageThreshold` enforces per-file)
2. **Given** any tested file, **When** line or function coverage drops below 90%, **Then** the CI pipeline fails via Bun's native per-file threshold enforcement
3. **Given** a dependency has a known vulnerability, **When** the CI pipeline runs, **Then** the dependency audit step flags it
4. **Given** the Docker image is built, **When** the container scan runs, **Then** known CVEs are reported

---

### User Story 4 - Project Setup Follows Best Practices (Priority: P4)

A developer cloning the repository finds all tooling version-pinned, CI labels properly configured, and a secret scanning pre-commit hook preventing accidental credential commits. Currently, Node.js version is not pinned (no `.nvmrc`), the labeler workflow references a missing config file, and no secret detection exists in the pre-commit pipeline.

**Why this priority**: These are low-risk gaps that improve developer experience and prevent operational surprises but do not block core functionality.

**Independent Test**: Can be validated by checking that `.nvmrc` exists, `.github/labeler.yml` exists and matches workflow expectations, and the pre-commit hook detects a test secret in staged files.

**Acceptance Scenarios**:

1. **Given** a developer runs `nvm use` in the repo, **When** `.nvmrc` is present, **Then** the correct Node.js version is activated
2. **Given** a PR is opened, **When** the labeler workflow runs, **Then** labels are applied based on `.github/labeler.yml` rules
3. **Given** a developer stages a file containing a secret pattern, **When** they attempt to commit, **Then** the pre-commit hook blocks the commit with a warning

---

### Edge Cases

- What happens when a module has no testable exports (e.g., pure side-effect entry points)? Coverage requirements should apply only to modules with testable logic; integration-style modules may be excluded with documented justification.
- How should external dependency mocking be handled for modules that wrap the AI agent SDK or git operations? The constitution requires mocking external dependencies; tests should verify the orchestration logic, not the external tool behavior.
- What happens when a JSDoc comment exists but is stale or inaccurate? Stale JSDoc is treated as a documentation defect per the constitution and must be corrected in the same commit as any behavior change.
- What happens when a dependency audit finds a vulnerability with no available fix? The CI step should warn but not block the pipeline for vulnerabilities without patches; only exploitable vulnerabilities with available fixes should be blocking.
- What happens when the secret scanning hook produces a false positive? The hook should support an allowlist mechanism so developers can mark known safe patterns.

## Requirements _(mandatory)_

### Functional Requirements

**Documentation (JSDoc)**:

- **FR-001**: ~~All exported functions in the prompt builder module MUST have JSDoc comments~~ — PRE-SATISFIED (verified: all exports already have JSDoc)
- **FR-002**: ~~All exported handler functions in webhook event modules MUST have JSDoc comments~~ — PRE-SATISFIED (verified: all 5 handlers already have JSDoc)

**Test Coverage**:

- **FR-003**: The prompt builder module MUST have unit tests covering both PR-context and issue-context prompt generation, achieving >=90% line coverage
- **FR-004**: The data fetcher module MUST have unit tests covering response parsing and error handling paths, achieving >=90% line coverage (up from current ~9%)
- **FR-005**: The formatter module MUST have additional unit tests covering all conditional branches, achieving >=90% line coverage (up from current ~67%)
- **FR-006**: The webhook router MUST have additional tests covering concurrency limiting and capacity rejection paths, achieving >=90% line coverage (up from current ~84%)
- **FR-007**: The checkout module MUST have unit tests covering credential setup, clone operations, and cleanup paths, achieving >=90% line coverage — **DEFERRED** (see Clarifications Session 2026-04-10): Bun's built-in `$` template tag and `bun` module cannot be mocked via `mock.module("bun", ...)` because `bun` is a runtime builtin. Module-level unit testing requires a source refactor for dependency injection that is out of scope for housekeeping. The module is transitively exercised by `router.test.ts` (mocked). A follow-up issue MUST be filed before merge to track the DI refactor.
- **FR-008**: The executor module MUST have unit tests with mocked AI agent SDK covering result handling and error paths, achieving >=90% line coverage — **DEFERRED** (see Clarifications Session 2026-04-10): `mock.module("@anthropic-ai/claude-agent-sdk", ...)` persists across Bun test files in the same process, conflicting with `router.test.ts`'s module-level mock. The module is transitively exercised by `router.test.ts`. Same follow-up issue as FR-007.

**CI Pipeline — Coverage Gating**:

- **FR-009**: Bun's native `coverageThreshold` MUST be configured in `bunfig.toml` to enforce >=90% line coverage and >=90% function coverage **per-file** (Bun applies `coverageThreshold` per-file, not to the aggregated global number — verified empirically during Phase 7)
- **FR-010**: The CI pipeline MUST fail when `bun test` detects coverage below the configured threshold

**CI Pipeline — Security Scanning**:

- **FR-011**: The CI pipeline MUST run `bun audit` for dependency vulnerability scanning on every PR
- **FR-012**: The CI pipeline MUST run a `trivy` container image scan for known CVEs after Docker builds, with SARIF output uploaded to the GitHub Security tab
- **FR-013**: A `gitleaks` pre-commit hook MUST be added via Husky to detect accidental credential commits, with a `.gitleaks.toml` allowlist for managing false positives

**Project Setup Fixes**:

- **FR-014**: A `.nvmrc` file MUST be added pinning the Node.js version used by CI (Node 22)
- **FR-015**: A `.github/labeler.yml` file MUST be created with label rules matching conventional commit types and file path patterns
- **FR-016**: The `init-options.json` branch numbering MUST be changed from `sequential` to `timestamp` to align with the constitution's Branch Strategy
- **FR-016a**: The Dockerfile MUST include a `HEALTHCHECK` instruction using the existing `/healthz` endpoint

**Code Quality — ESLint Modernization**:

- **FR-017**: The ESLint config MUST be migrated from legacy `@typescript-eslint/eslint-plugin` + `@typescript-eslint/parser` imports to the unified `typescript-eslint` package
- **FR-018**: The ESLint config MUST use the `strictTypeChecked` preset to pick up additional strict rules automatically
- **FR-019**: The deprecated `@typescript-eslint/no-var-requires` rule MUST be replaced with `@typescript-eslint/no-require-imports`

**Quality Gate**:

- **FR-020**: The unified quality gate (`bun run check`) MUST continue to pass after all changes, including typecheck, lint, format, and test

### Key Entities

- **Exported Symbol**: Any function, class, interface, or type exported from a source module that forms part of the public API surface. Must have JSDoc per constitution Principle VIII.
- **Coverage Threshold**: A configured minimum percentage of line and function coverage enforced per-file by Bun's native `coverageThreshold`. Attributes: line threshold (90%), function threshold (90%), enforcement scope (per-file), enforcement mechanism (Bun native `coverageThreshold` in bunfig.toml).

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: All tested modules maintain >=90% line coverage and >=90% function coverage on a **per-file** basis, enforced natively by Bun's `coverageThreshold` in `bunfig.toml`
- **SC-002**: 100% of exported functions across the codebase have JSDoc comments (pre-satisfied)
- **SC-003**: ESLint config uses the unified `typescript-eslint` package with `strictTypeChecked` preset and no deprecated rules
- **SC-004**: The unified quality gate passes with zero errors after all housekeeping changes
- **SC-005**: Coverage thresholds are enforced in CI such that PRs cannot merge if coverage drops below configured minimums
- **SC-006**: CI pipeline includes dependency audit and container scan steps that execute on every PR and Docker build respectively
- **SC-007**: Pre-commit hook detects and blocks commits containing secret patterns (API keys, private keys, tokens)
- **SC-008**: Node.js version is pinned via `.nvmrc` and CI labeler workflow has a valid configuration file
- **SC-009**: `package.json` `overrides` for security CVE remediation use exact version pins (not caret ranges) with an inline rationale comment
- **SC-010**: `retryWithBackoff` rejects invalid numeric options (`NaN`, `Infinity`, below-minimum, non-integer `maxAttempts`) with a descriptive synchronous error that names the offending option and value

## Assumptions

- Existing test infrastructure (test runner, directory structure, mocking patterns) will be reused without changes to the test framework
- External dependencies (GitHub API, AI agent SDK, git CLI) will be mocked in all new tests per constitution Principle V
- Bun's built-in `coverageThreshold` in bunfig.toml will enforce a per-file 90% line and function coverage floor natively; no custom script needed. (Bun applies `coverageThreshold` per-file, not as an aggregated global percentage.)
- JSDoc additions will not change any runtime behavior; they are documentation-only changes
- Security scanning tools will be open-source or GitHub-native (no paid third-party dependencies)
- The secret scanning pre-commit hook will use `gitleaks` (Go binary) integrated into the existing Husky pipeline, with `.gitleaks.toml` for allowlist configuration
- Container scanning will use `trivy` via `aquasecurity/trivy-action` GitHub Action, running as a separate CI step after Docker image build with SARIF output for GitHub Security tab
