# Data Model: Project Housekeeping

**Date**: 2026-04-09

## Overview

This feature does not introduce new data entities. It modifies configuration files, adds tests, and updates CI workflows. No data model changes required.

## Configuration Entities (modified)

### Coverage Threshold (bunfig.toml)

- **line**: number (0.0–1.0) — minimum line coverage percentage. Set to 0.9.
- **function**: number (0.0–1.0) — minimum function coverage percentage. Set to 0.9.
- **Enforcement**: Bun test runner exits non-zero when any threshold is not met.

### Gitleaks Config (.gitleaks.toml)

- **allowlist.paths**: string[] — file paths excluded from secret scanning.
- **allowlist.commits**: string[] — commit SHAs excluded from scanning.
- **allowlist.regexes**: string[] — patterns that are allowed (false positive suppression).

### Labeler Config (.github/labeler.yml)

- **label-name**: object — maps label names to file path glob patterns and/or PR metadata conditions.
- Labels map to conventional commit types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`, `build`.
