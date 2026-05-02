# Resolve iteration — PR #94

_Iteration date: 2026-05-02 (second resolve pass, post-review iteration #2)_

## Summary

PR #94 (`feat(workflows): publish SLSA provenance + SBOM attestations on every release tag (closes #58)`) entered this resolve with **0 failing checks** and **3 review threads** (per the trigger header). GraphQL inspection showed only **2 threads were actually open**: the line-277 thread was already resolved by the prior resolve iteration in commit `0f7fe9e`. Branch was 0 behind / 6 ahead of `main`, so no rebase was needed. Both open threads are bot-authored review-iteration findings against `.github/workflows/docker-build.yml` — both classified **Valid** but **environment-policy-blocked** (the resolve agent cannot modify files under `.github/workflows/`, same constraint the prior iteration documented). Replies were posted with the exact maintainer-action diffs and threads left **open** so the maintainer sees the deferred work. No commits pushed this iteration; CI state is unchanged from `d85a748` (all green).

## CI status

No failing checks at the start of this iteration. No commits pushed, so CI was not re-triggered — final state is the same all-green ledger from `d85a748`:

| Check                             | Workflow        | State on `d85a748` |
| --------------------------------- | --------------- | ------------------ |
| `Lint & Test`                     | CI              | pass               |
| `build`                           | Docs            | pass               |
| `Analyze (actions)`               | CodeQL          | pass               |
| `Analyze (javascript-typescript)` | CodeQL          | pass               |
| `CodeQL`                          | CodeQL          | pass               |
| `Gitleaks` (push + PR)            | Secrets Scan    | pass               |
| `Label PR based on title`         | Generate Labels | pass               |

Zero fix attempts consumed against the FIX_ATTEMPTS_CAP=3 budget.

## Review comments

| Comment ID                                                                                         | File:line                                | Classification                         | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Reply                                                                                                                     | Thread resolved?                           |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| [`3176252148`](https://github.com/chrisleekr/github-app-playground/pull/94#discussion_r3176252148) | `.github/workflows/docker-build.yml:277` | **Valid** (already addressed)          | Resolved in the prior iteration via doc tightening in commit [`0f7fe9e`](https://github.com/chrisleekr/github-app-playground/commit/0f7fe9e537e568260c615ce6c1b4f8efe83965ae). No action this iteration.                                                                                                                                                                                                                                                                                                                                                | n/a (prior iteration: [`3176256894`](https://github.com/chrisleekr/github-app-playground/pull/94#discussion_r3176256894)) | ✅ Yes (resolved by prior iteration)       |
| [`3176271719`](https://github.com/chrisleekr/github-app-playground/pull/94#discussion_r3176271719) | `.github/workflows/docker-build.yml:293` | **Valid — maintainer action required** | `actions/attest-sbom@v4` is upstream-deprecated (composite shim around `actions/attest@v4.1.0` that prints `::warning::actions/attest-sbom has been deprecated`). Recommended one-step swap to `actions/attest@v4` with explicit `predicate-type: https://cyclonedx.org/bom`. Workflow edit deferred — environment-policy-blocked from editing files under `.github/workflows/` (same constraint as prior iteration). Reply contains the exact YAML diff for the maintainer.                                                                            | [`3176312123`](https://github.com/chrisleekr/github-app-playground/pull/94#discussion_r3176312123)                        | ❌ No — left open for maintainer follow-up |
| [`3176305901`](https://github.com/chrisleekr/github-app-playground/pull/94#discussion_r3176305901) | `.github/workflows/docker-build.yml:343` | **Valid — maintainer action required** | `gh attestation verify` only covers Sigstore-signed predicates and won't catch a regression that drops BuildKit's `provenance: mode=max` / `sbom: true` on the per-arch builds — yet `docs/operate/deployment.md:97` directs arm64 audits at exactly those BuildKit-attached SPDX SBOMs. Recommended fix: add a sibling `docker buildx imagetools inspect` step asserting non-empty `.SBOM` + `.Provenance` for both `linux/amd64` and `linux/arm64`. Workflow edit deferred — same env-policy block. Reply contains the exact YAML for the maintainer. | [`3176312364`](https://github.com/chrisleekr/github-app-playground/pull/94#discussion_r3176312364)                        | ❌ No — left open for maintainer follow-up |

## Commits pushed

None this iteration. Prior iterations' commits remain in place:

| SHA                                                                                                              | Subject                                                                  |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [`0f7fe9e`](https://github.com/chrisleekr/github-app-playground/commit/0f7fe9e537e568260c615ce6c1b4f8efe83965ae) | `docs(operate): scope CycloneDX SBOM claim to amd64 in attestation docs` |

## Outstanding

Two **maintainer-action items** block "ready to merge" from a strict resolve-clean perspective. Both are valid review findings that this resolve agent classified Valid but couldn't action because they require editing `.github/workflows/docker-build.yml`, which is outside this agent's edit allowlist:

1. **`docker-build.yml:293` — `actions/attest-sbom@v4` deprecation.** Swap to `actions/attest@v4` with `predicate-type: https://cyclonedx.org/bom`. Cosmetic in steady state (every release prints a deprecation `::warning::`); becomes blocking when upstream removes the shim. See reply [`3176312123`](https://github.com/chrisleekr/github-app-playground/pull/94#discussion_r3176312123) for the exact diff.

2. **`docker-build.yml:343` — Sigstore-only regression gate.** Add a `docker buildx imagetools inspect` sibling check that asserts BuildKit per-arch attestations are non-empty for both `linux/amd64` and `linux/arm64`. Closes the BuildKit half of the gate without depending on Sigstore. See reply [`3176312364`](https://github.com/chrisleekr/github-app-playground/pull/94#discussion_r3176312364) for the exact step YAML.

Other notes:

- All CI checks green on `d85a748`. No fix-attempts consumed against the cap.
- This bot can post inline replies but cannot submit a formal `APPROVE` review decision (FR-017). Final approval and `gh pr merge` remain a human action.
- Both unresolved threads are intentionally left open so the maintainer's PR view surfaces the deferred work.
