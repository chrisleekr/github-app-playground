# Quickstart: Project Housekeeping

**Branch**: `20260409-081113-project-housekeeping`

## Prerequisites

- Bun >=1.3.8
- Node.js 22 (for semantic-release CLI)
- `gitleaks` binary installed ([installation](https://github.com/gitleaks/gitleaks#installing))

## Development Order

```
Phase 1: Config files (no risk)
  → Phase 2: Write tests (raise coverage to 90%)
    → Phase 3: ESLint migration (may require code fixes)
Phase 1: Config files
  → Phase 4: CI security scanning (workflow changes)
  → Phase 5: Gitleaks pre-commit (local hook)
All phases → Phase 6: Final quality gate
```

## Quick Commands

```bash
# Verify current state
bun run check              # Should pass before starting

# Phase 1 validation
bun run check              # Config changes don't break anything

# Phase 2 validation
bun test --coverage        # Check coverage numbers

# Phase 3 validation
bun run lint               # ESLint with new config
bun run typecheck          # TypeScript still clean

# Phase 6 final gate
bun run check              # Everything passes with 90% coverage threshold
```

## Key Files to Modify

| File                                     | Change                                                       |
| ---------------------------------------- | ------------------------------------------------------------ |
| `bunfig.toml`                            | Add `coverageThreshold = { line = 0.9, function = 0.9 }`     |
| `eslint.config.mjs`                      | Migrate to unified `typescript-eslint` + `strictTypeChecked` |
| `package.json`                           | Replace ESLint deps                                          |
| `Dockerfile`                             | Add `HEALTHCHECK` after `EXPOSE`                             |
| `.husky/pre-commit`                      | Add `gitleaks protect --verbose --staged`                    |
| `.github/workflows/push.yml`             | Add `bun audit` step                                         |
| `.github/workflows/docker-build.yml`     | Add trivy scan + SARIF upload                                |
| `.github/workflows/semantic-release.yml` | Add `bun audit` step                                         |

## New Files to Create

| File                               | Purpose                                          |
| ---------------------------------- | ------------------------------------------------ |
| `test/core/prompt-builder.test.ts` | Unit tests for buildPrompt + resolveAllowedTools |
| `test/core/checkout.test.ts`       | Unit tests for checkoutRepo                      |
| `test/core/executor.test.ts`       | Unit tests for executeAgent                      |
| `.nvmrc`                           | Pin Node.js 22                                   |
| `.github/labeler.yml`              | PR label rules                                   |
| `.gitleaks.toml`                   | Secret scanning allowlist                        |
