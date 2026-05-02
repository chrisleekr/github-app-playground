# Review — PR #94 (`bot/issue-58-supply-chain-attestations`)

_Reviewed at HEAD `be841df`._

## Summary

PR #94 wires SLSA v1 build provenance + CycloneDX/SPDX SBOM attestations into every Docker image the release pipeline publishes, plus a `gh attestation verify` regression gate that fails the workflow if either Sigstore-signed predicate is silently dropped by a future refactor of `docker-build.yml`. The diff is YAML + Markdown only — no `src/`, `Dockerfile.*`, or `package.json` edits. Implementation remains sound: BuildKit attestation flags correctly override `docker/build-push-action`'s `push-by-digest`-default-off behaviour, the merge-job permission scoping is least-privilege (top-level `attestations: read` only; `id-token: write` + `attestations: write` confined to the merge job), the merged-digest capture validates with a `sha256:[0-9a-f]{64}` regex, and the scan-job verify step calls `gh attestation verify` once per predicate type. The HEAD has not changed since the previous review iteration; the prior CycloneDX-amd64-only finding was resolved by `0f7fe9e`. **One new Minor finding** posted inline; the prior `actions/attest-sbom@v4` deprecation finding (line 293) is still active and unaddressed but not duplicated as a fresh inline. Otherwise ready for human approval and merge.

## What was checked

- Re-read `.github/workflows/docker-build.yml` (368 lines) end-to-end — verified permission scoping (`attestations: read` at top-level, `id-token: write` + `attestations: write` confined to the merge job), confirmed `provenance: mode=max` + `sbom: true` on the build step, traced the digest flow through `imagetools create` → `imagetools inspect --format` → `anchore/sbom-action` → `attest-build-provenance` → `attest-sbom` → `gh attestation verify`.
- Re-read `docs/operate/deployment.md` and `docs/operate/observability.md` — verified the consumer commands, the predicate-type table, the storage matrix, and the post-resolve "amd64 packages only" caveat on the Sigstore CycloneDX flavour now consistently appears in `deployment.md:77`, `deployment.md:97`, and `observability.md:125`.
- Re-read `CLAUDE.md` diff — table widening from prettier reflow plus one new "Recent Changes" bullet.
- Cross-referenced `anchore/sbom-action`'s `action.yml@main` (the only ref `@v0` floats to) — confirmed there is no `platform` input, so Syft scans the runner's native architecture (amd64 on `ubuntu-24.04`) when given a multi-arch manifest reference. Doc copy is now consistent with this constraint.
- Cross-referenced `actions/attest-sbom`'s `action.yml@v4` — confirmed it is a composite shim around `actions/attest@v4.1.0` whose first step prints `::warning::actions/attest-sbom has been deprecated, please use actions/attest instead`. Same finding the prior review iteration posted at `.github/workflows/docker-build.yml:293`; still open.
- Cross-referenced `actions/attest-build-provenance`'s `action.yml@v4` — confirmed it is **not** deprecated (no warning step), still the current path. Both `attest-*` v4 shims pin to the same `actions/attest@v4.1.0` SHA `59d89421af93a897026c735860bf21b6eb4f7b26`.
- `git fetch origin main:main` → `git rev-list --left-right --count main...HEAD` → 0 behind / 5 ahead. No rebase needed.
- `git log --oneline main..HEAD` confirms HEAD is unchanged from the previous review iteration's `be841df`. No new commits to review.
- No typecheck/lint/test runs done — the PR is YAML + Markdown and the author's tests-run section already records `bun run typecheck`, `bun run lint`, `actionlint`, `mkdocs build --strict`, and the bespoke citation/version checks all green.

## Findings

### [minor] `.github/workflows/docker-build.yml:343` — Regression gate is Sigstore-only; BuildKit per-arch attestations are unprotected

`gh attestation verify` queries GitHub's Attestations API for the Sigstore-signed bundles emitted by `actions/attest-build-provenance` + `actions/attest-sbom`. It does **not** inspect the BuildKit-attached `vnd.docker.reference.type=attestation-manifest` siblings on the per-arch leaf manifests — and those siblings are the only source `docs/operate/deployment.md:97` directs arm64 supply-chain audits to (the Sigstore CycloneDX flavour is amd64-only after the resolve-iteration doc tightening). A future refactor that drops `provenance: mode=max` or `sbom: true` from the build step (`.github/workflows/docker-build.yml:168-169`) would still leave the Sigstore attestations intact, so `gh attestation verify` would pass — but every arm64 audit downstream would silently get nothing. The PR description and `docs/operate/deployment.md:95` ("any future regression that drops an attestation") over-read the gate's actual scope. **Recommended fix:** add a sibling check that asserts `docker buildx imagetools inspect <ref> --format '{{ json .SBOM }}'` and `'{{ json .Provenance }}'` are non-empty for both `linux/amd64` and `linux/arm64`. Closes the BuildKit half of the gate without depending on Sigstore.

### [minor] `.github/workflows/docker-build.yml:293` — `actions/attest-sbom@v4` is deprecated upstream (PRIOR FINDING — STILL OPEN)

Already posted by the prior review iteration as inline comment `r3176256908` (and triaged by the resolve iteration but not addressed in code). Re-confirmed against `https://raw.githubusercontent.com/actions/attest-sbom/v4/action.yml`: every release run will surface `::warning::actions/attest-sbom has been deprecated, please use actions/attest instead` in the merge job. Functionality is preserved (the shim wraps `actions/attest@v4.1.0` and synthesises the `https://cyclonedx.org/bom` predicate, which matches the verify-step argument at `.github/workflows/docker-build.yml:343`). Not duplicating as a fresh inline because the existing thread on the same line is still visible — see prior comment for the recommended `actions/attest@v4` migration. `actions/attest-build-provenance@v4` (line 286) is **not** affected.

## Reasoning

Things I considered but did NOT flag:

- **HEAD unchanged since the previous review iteration.** `be841df` was the same SHA the prior review reviewed. The CycloneDX-amd64-only finding from review iteration 1 was resolved by `0f7fe9e`; the deprecation finding from review iteration 2 is still open (re-noted in Findings, not duplicated inline).
- **Predicate-type mismatch risk** — confirmed against `actions/attest`'s upstream that CycloneDX maps to `https://cyclonedx.org/bom`, which is what the verify step at line 343 requests. Coherent.
- **Permission scoping** — top-level `attestations: read` is the minimum the scan job needs to call `gh attestation verify`; merge-job locally adds `id-token: write` (Sigstore OIDC) + `attestations: write` (Attestations API). Build/scan keep read-only. Least-privilege is correct.
- **`gh attestation verify` against a tag rather than a digest** — the `oci://...:variant_tag` reference is resolved at tool runtime, but the merge job is the only writer to that tag and `imagetools create` is atomic, so the resolved digest is deterministic. Not worth flagging.
- **`subject-digest` flow** — `imagetools inspect ... --format '{{ .Manifest.Digest }}'` returns the merged manifest-list digest, which is what both `attest-build-provenance` and `attest-sbom` bind to via `subject-digest`, and what `gh attestation verify oci://...:tag` resolves the tag to. End-to-end consistent.
- **Double `imagetools inspect` call** in the digest-capture step — one human-readable, one for the `--format` digest. Two registry round-trips, but the second is cheap and the human-readable inspect is genuinely useful in the log. Not worth flagging.
- **`anchore/sbom-action@v0` major-only pin** — author's deviation note already addresses this (repo convention is tag-only major-version pinning + Renovate group rule); not actionable here.
- **Verify-step `set -e` semantics** — GitHub Actions runs bash with `-eo pipefail` by default, so a failed first `gh attestation verify` short-circuits the second. The comment's claim that "either failure fails the workflow" is correct.
- **Defense-in-depth `env:`-first pattern** — every new `run:` block reads `IMAGE_REF` / `REPO` / `IMAGE` / `TAG` / `DIGEST` from `env:`, never from `${{ … }}` expansion inside the script. Pattern preserved.
- **Scan job's 4× redundant verify calls** — the scan matrix is `{amd64, arm64} × {orchestrator, daemon}`. Each cell calls `gh attestation verify` against the same tag, which resolves to the same merged manifest-list digest, so all four cells fetch the same attestation. Not a bug — the scan job is the regression gate, and running it per matrix cell preserves a uniform shape with the Trivy scan that follows. Not worth flagging.
- **Docker login ordering in the scan job** — `Login to Docker Hub` (line 314-318) runs before `Verify image attestations` (line 332), so `gh attestation verify`'s tag→digest resolution against the registry has credentials. ✓
- **Build matrix failure semantics** — `fail-fast: false` on the build matrix lets all cells complete, but if any cell fails the `build` job overall fails, and `needs: build` skips merge. Correct.
- **The change does not touch `src/`** — no test coverage gap to flag.
