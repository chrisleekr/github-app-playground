# Research: Project Housekeeping

**Date**: 2026-04-09

## R1: JSDoc Coverage Status

**Decision**: FR-001 and FR-002 are already satisfied — no JSDoc work needed.

**Rationale**: Research confirmed all exported functions in `src/core/prompt-builder.ts` (lines 6-12, 207-210), all 5 webhook event handlers (`src/webhook/events/*.ts`), and `src/mcp/registry.ts` (lines 5-11, 43-46, 65-67) already have complete JSDoc comments with `@param`, `@returns`, and `@throws` tags.

**Alternatives considered**: None — this was a factual verification.

## R2: Bun Native Coverage Threshold Support

**Decision**: Use Bun's native `coverageThreshold` in `bunfig.toml` with `{ line = 0.9, function = 0.9 }`.

**Rationale**: Bun supports `coverageThreshold` natively ([docs](https://bun.com/guides/test/coverage-threshold)). This eliminates the need for a custom TypeScript script. The threshold is enforced at test runtime — `bun test` exits non-zero if coverage drops below the configured minimum.

**Alternatives considered**:

- Custom `scripts/check-coverage.ts` parsing lcov output — rejected (unnecessary complexity when native support exists)
- Per-module thresholds with custom script — rejected (user chose single global 90% threshold)

## R3: ESLint Migration to Unified typescript-eslint

**Decision**: Replace `@typescript-eslint/eslint-plugin` + `@typescript-eslint/parser` with unified `typescript-eslint` package (v8+). Use `strictTypeChecked` preset.

**Rationale**: The unified package is the [recommended approach](https://typescript-eslint.io/getting-started/) for ESLint 9 flat config. `strictTypeChecked` includes all rules from `recommended-type-checked` plus additional strict rules (`no-unnecessary-type-assertion`, `no-base-to-string`, `restrict-template-expressions`, `no-unsafe-enum-comparison`). The deprecated `no-var-requires` is replaced by `no-require-imports`.

**Alternatives considered**:

- Keep legacy imports — rejected (deprecated approach, misses strict rules)
- Use `recommendedTypeChecked` only — rejected (user chose maximum strictness)

## R4: Gitleaks Integration

**Decision**: Use `gitleaks` binary in Husky pre-commit hook with `.gitleaks.toml` allowlist.

**Rationale**: Gitleaks is the most widely adopted open-source secret scanner (Go binary, 100+ built-in patterns). It integrates as a simple pre-commit command: `gitleaks protect --verbose --staged`. The `.gitleaks.toml` file supports allowlisting specific paths, commits, or patterns for false positive management.

**Alternatives considered**:

- `detect-secrets` (Yelp) — rejected (Python dependency, heavier runtime)
- `trufflehog` — rejected (broader scope than needed for pre-commit)

## R5: Trivy Container Scanning

**Decision**: Use `aquasecurity/trivy-action` GitHub Action with SARIF output uploaded to GitHub Security tab.

**Rationale**: Trivy is the most popular open-source container scanner with a well-maintained GitHub Action. SARIF output integrates natively with GitHub's Security tab for vulnerability tracking. Scans both OS packages and application dependencies in a single pass.

**Alternatives considered**:

- `grype` (Anchore) — rejected (less GitHub integration)
- `docker scout` — rejected (requires subscription)

## R6: Dependency Audit Tool

**Decision**: Use `bun audit` in CI pipeline.

**Rationale**: Native to the project's Bun-first runtime, reads `bun.lock` directly. Keeps the toolchain consistent without adding npm as a CI dependency.

**Alternatives considered**:

- `npm audit` — rejected (requires npm lockfile conversion)
- `trivy fs` — rejected (adds complexity; prefer dedicated tools per concern)

## R7: Docker HEALTHCHECK

**Decision**: Add `HEALTHCHECK` instruction to Dockerfile using existing `/healthz` endpoint.

**Rationale**: The app already exposes `/healthz` and `/readyz` health endpoints (constitution Principle II). Adding `HEALTHCHECK` makes the container self-describing for Docker and orchestrators. The `curl` binary is already available in the production image (installed in the base stage).

**Alternatives considered**:

- Rely on external orchestrator probes only — rejected (Docker best practice is self-describing containers)

## R8: Test Mocking Patterns

**Decision**: Follow established project patterns using Bun's `mock.module()` for external dependencies.

**Rationale**: The existing test suite (`test/webhook/router.test.ts`) demonstrates the project's mocking conventions:

- `mock.module()` for module-level mocks
- Factory functions (`makeOctokit()`, `makeCtx()`, `makeGraphqlResponse()`) for test data
- `mockClear()` in `beforeEach` for test isolation
- No external mocking libraries (Bun built-in only)

New tests will follow these patterns for consistency.
