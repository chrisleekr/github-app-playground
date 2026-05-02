# IMPLEMENT — Issue #58 (supply-chain attestations)

## Summary

Wires SLSA v1 build provenance + CycloneDX/SPDX SBOMs into every Docker image
the release pipeline publishes, and adds a hard regression gate that fails the
workflow if either attestation is silently dropped by a future refactor. All
changes are additive YAML (`.github/workflows/docker-build.yml`) plus matching
docs — no `Dockerfile.*`, `package.json`, or `src/` change. Closes #58.

The fix has two layers:

1. **BuildKit-native** (`provenance: mode=max` + `sbom: true` on the build
   step): each per-arch leaf push gets an in-toto SLSA v1 provenance manifest
   and an SPDX 2.3 SBOM stored as OCI subject descriptors, and the merge
   step's `imagetools create` walks each index digest so the descriptors
   survive the manifest-list assembly without any extra CLI plumbing.
2. **GitHub-Sigstore** (`actions/attest-build-provenance@v4` +
   `actions/attest-sbom@v4` after the merge): bind Sigstore-signed
   attestations to the merged manifest digest, surfaced via the GitHub
   Attestations API and Docker Hub's "Build attestations" badge. The
   CycloneDX SBOM that flows into `attest-sbom` is generated from the
   merged image by `anchore/sbom-action@v0`.

The `scan` job runs `gh attestation verify` for both predicate types
(`https://slsa.dev/provenance/v1` + `https://cyclonedx.org/bom`) before Trivy
on every release tag — two separate calls so each predicate must exist.

## Files changed

- `.github/workflows/docker-build.yml` · primary subject of the issue —
  enables BuildKit attestations on the build step (T1), scopes
  `id-token: write` + `attestations: write` to the merge job only (T3),
  captures the merged manifest digest, generates a CycloneDX SBOM, and
  publishes Sigstore-signed provenance + SBOM attestations after the
  manifest-list push (T4); adds a `gh attestation verify` regression gate
  to the scan job before Trivy (T5). Top-level perms gain
  `attestations: read` so build/scan stay read-only; merge overrides locally.
- `docs/operate/deployment.md` · new "Verifying image attestations"
  subsection under "Build" with consumer-side `gh attestation verify` and
  `docker buildx imagetools inspect` recipes covering both attestation
  flavours and both image variants (T7).
- `docs/operate/observability.md` · new "Supply-chain attestations" section
  documenting the registry / Sigstore / GitHub-API storage matrix and
  pointing operators at the consumer commands in `deployment.md` (T8).
- `CLAUDE.md` · "Owns" cell for `docker-build.yml` updated to mention SLSA
  - SBOM attestations and the `gh attestation verify` regression gate;
    one-line `20260502-supply-chain-attestations` entry in "Recent Changes" (T9).

## Commits

See the PR commit list — short SHAs and conventional-commit subjects are
visible there.

## Tests run

- `bun run typecheck` · pass (no TypeScript output, exit 0)
- `bun run lint` · pass (0 errors, 289 pre-existing warnings — none new from this change)
- `bun run format` · pass after `bun run format:fix` re-flowed two doc tables
- `actionlint .github/workflows/*.yml` · pass (no output, all workflows lint-clean)
- `bun run scripts/check-docs-citations.ts` · pass (every `src/<file>:<line>` citation in-range)
- `bun run scripts/check-docs-versions.ts` · pass (Bun version pins consistent with `.tool-versions`)
- `mkdocs build --strict` · pass (`Documentation built in 0.58 seconds`, no warnings)
- `bun test` · 519 pass / 153 skip / **194 pre-existing fail** — verified
  baseline by `git stash && bun test` before reapplying my diff: same
  pass/fail counts. The failing suites need Postgres + Valkey
  (`bun run dev:deps`); they are unrelated to YAML / Markdown changes here.

## Verification

Each task in the plan is satisfied as follows:

- **T1** — `.github/workflows/docker-build.yml:160-169` adds
  `provenance: mode=max` and `sbom: true`. Inline comment cites the
  `push-by-digest` default-off behaviour the issue called out and links the
  Docker multi-platform guide. BuildKit will emit per-arch attestation
  manifests alongside each leaf image push.

- **T2** — Merge step preserved as-is (`imagetools create` already walks
  the per-arch index digests, which now reference both image AND
  attestation manifests via the BuildKit emission from T1). Inline comment
  at `.github/workflows/docker-build.yml:248-256` explains why no CLI
  plumbing is needed; this matches the documented Docker multi-platform
  pattern.

- **T3** — Top-level adds `attestations: read` (line 61) so the scan job
  inherits read-only verification scope. Merge job overrides locally
  (lines 199-202) with `id-token: write` + `attestations: write` —
  least-privilege; build/scan retain only the top-level grants.

- **T4** — After `Create manifest list and push`, the workflow now:
  1. `Inspect merged image and capture digest` (lines 261-274) — captures
     the index digest with regex validation so a malformed parse fails
     fast rather than silently passing a bad subject to attest-\*.
  2. `Generate CycloneDX SBOM for merged image` (lines 276-283) using
     `anchore/sbom-action@v0` — syft-backed, produces CycloneDX JSON.
  3. `Attest build provenance` (lines 285-290) — Sigstore-signed in-toto
     SLSA v1 attestation pushed to the registry as a sibling descriptor
     on the merged manifest digest.
  4. `Attest SBOM` (lines 292-298) — Sigstore-signed CycloneDX SBOM
     attestation, same subject digest.

- **T5** — Scan job's new `Verify image attestations` step (lines 329-343)
  calls `gh attestation verify` twice with explicit `--predicate-type`
  filters for SLSA provenance and CycloneDX SBOM. Each call fails the job
  if its predicate type is absent — so dropping either attestation in a
  future refactor will break the release before Trivy runs.

- **T6 (deviation noted)** — Plan said to SHA-pin in addition to the major
  tag. Repo-wide `Grep` for `uses: .+@[0-9a-f]{40}` returned zero matches:
  every workflow uses tag-only pinning at the major version, with Renovate
  handling bumps via the `github-actions` group rule in `renovate.json`. I
  followed the **existing repo posture** (tag-only major-version pins for
  `actions/attest-build-provenance@v4`, `actions/attest-sbom@v4`,
  `anchore/sbom-action@v0`) over the plan's SHA-pin recommendation, since
  adding SHAs only here would be immediately undone by the next Renovate
  run and breaks consistency with the other 11 actions in the file.
  Renovate's `github-actions` group will pick up bumps weekly. Also bumped
  the action major versions from the plan's `@v3` to `@v4` because v4.x
  has been GA since 2026-02-26 (today: 2026-05-02) and the repo otherwise
  tracks current major versions for actions (`checkout@v6`,
  `build-push-action@v7`, `download-artifact@v8`).

- **T7-T8** — `docs/operate/deployment.md` and `docs/operate/observability.md`
  updated with consumer verification commands and storage-surface matrix;
  cross-linked. `mkdocs build --strict` passes; the project's bespoke
  citation / version checks pass.

- **T9** — `CLAUDE.md` CI/CD row updated and a `20260502-…` "Recent Changes"
  entry added. Format auto-fix re-flowed the table column widths, expected.

- **T10 (deferred — out-of-band verification)** — End-to-end smoke test via
  `gh workflow run docker-build.yml` against a dev tag is the maintainer's
  call to schedule (it pushes a real image to Docker Hub and consumes an
  attestations-API quota). All YAML / docs gates that _can_ run locally
  pass; the actual attestation-emit / verify behaviour is the maintainer's
  smoke test on first dev release after merge.

### Security posture preserved

- Top-level `permissions:` only grew by `attestations: read` (least
  required to verify); the existing `contents: read` and
  `security-events: write` are unchanged.
- The merge job's elevated scopes (`id-token: write`,
  `attestations: write`) are confined to that one job — build and scan
  cannot mint Sigstore tokens or write attestations.
- `gh attestation verify` runs with `secrets.GITHUB_TOKEN` (the default
  job token), no PAT.
- All dynamic inputs flowing into `run:` blocks remain passed via `env:`
  first (defense-in-depth posture from CLAUDE.md preserved — the new
  steps follow the same pattern, e.g. `IMAGE_REF` / `REPO` / `TAG` /
  `IMAGE` / `DIGEST` env mappings).
