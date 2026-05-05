<!-- markdownlint-disable MD041 -->
<!-- cspell:ignore WCAG -->
<!--
Bot-authored PR template — used by the `implement` workflow. Mirrors the
human PR template's top-level shape (Summary / Diagram / Changes / Related
Issues / Test plan) but adds machine-fillable sections the bot already
captures during its run (Files changed, Commits, Tests run, Verification).

The agent reads this file, fills each section from its actual work, and
passes the rendered result via `gh pr create --body-file <tempfile>` (so
`gh` does not auto-pick the human PR template). Sections marked optional
should be omitted if they would only contain placeholder text.
-->

## Summary

<!-- One paragraph: what this PR does and why. Reference the closing issue. -->

## Diagram

<!-- Required when behaviour or flow changes (new code paths, new state, new
external calls, new error handling, sequence shifts) — include a single
mermaid block. Only omit this section entirely for pure refactors, typo
fixes, or test-only changes.
GitHub-compat rules: WCAG 2 AA contrast pairs in classDef, `<br/>` for
newlines, no parens in node labels, inline `:::className`, single subgraph,
node IDs ≥ 3 chars. -->

## Changes

<!-- - Significant changes, grouped by concern. -->

## Files changed

<!-- - `path/to/file.ts` · one-line rationale per file. -->

## Commits

<!-- - `<short-sha>` · conventional-commit subject -->

## Tests run

<!-- - `<command>` · pass/fail summary (e.g., `bun test test/foo` · 12 pass / 0 fail) -->

## Verification

<!-- Reasoning that ties the change back to the plan/issue:
- which acceptance criteria were satisfied
- non-trivial decisions and why
- anything that intentionally was NOT done -->

## Related Issues

- Closes #(issue number)

## Test plan

- [x] Tests added/updated where the change introduces new behaviour
- [x] `bun run typecheck` clean
- [x] `bun run lint` no new errors
- [x] Existing tests still pass (or pre-existing failures noted above)
