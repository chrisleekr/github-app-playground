# [1.10.0](https://github.com/chrisleekr/github-app-playground/compare/v1.9.1...v1.10.0) (2026-05-05)


### Bug Fixes

* **orchestrator:** constant-time bearer-token check + rotation slot ([#76](https://github.com/chrisleekr/github-app-playground/issues/76)) ([#103](https://github.com/chrisleekr/github-app-playground/issues/103)) ([cae53bd](https://github.com/chrisleekr/github-app-playground/commit/cae53bdf865c6836ea49fb141750a1099172615c))


### Features

* **bot:** PAT override + artifact sandbox + secret-exfil hardening ([#104](https://github.com/chrisleekr/github-app-playground/issues/104)) ([e0d5894](https://github.com/chrisleekr/github-app-playground/commit/e0d5894e5c4d8f38d323f9d4d87a8b56b14cf890))

## [1.9.1](https://github.com/chrisleekr/github-app-playground/compare/v1.9.0...v1.9.1) (2026-05-04)


### Reverts

* **workflow:** revert SLSA provenance + SBOM attestations ([#99](https://github.com/chrisleekr/github-app-playground/issues/99)) ([9696492](https://github.com/chrisleekr/github-app-playground/commit/96964920a490e076b3866ba0916687ccb8bfd055))

# [1.9.0](https://github.com/chrisleekr/github-app-playground/compare/v1.8.0...v1.9.0) (2026-05-03)


### Bug Fixes

* **checkout:** fetch PR base branch so origin/<baseBranch> resolves (closes [#74](https://github.com/chrisleekr/github-app-playground/issues/74)) ([#96](https://github.com/chrisleekr/github-app-playground/issues/96)) ([71f83a6](https://github.com/chrisleekr/github-app-playground/commit/71f83a6600e4a49b45295e0886b6c9072af21e88))
* **fetcher:** paginate GraphQL connections + MAX_FETCHED_* caps (closes [#66](https://github.com/chrisleekr/github-app-playground/issues/66)) ([#95](https://github.com/chrisleekr/github-app-playground/issues/95)) ([f728ecd](https://github.com/chrisleekr/github-app-playground/commit/f728ecdf16fd31feefa78aba0cbacf61a7292129))
* **triage:** accept note-only evidence; raise research max-turns to 200 ([#97](https://github.com/chrisleekr/github-app-playground/issues/97)) ([3b6036c](https://github.com/chrisleekr/github-app-playground/commit/3b6036cffa5b73aefcd8fb0b788bb526ac401df3))
* **workflow:** fix release.yml ([#98](https://github.com/chrisleekr/github-app-playground/issues/98)) ([cb43d69](https://github.com/chrisleekr/github-app-playground/commit/cb43d69064e9ed8fe4061525287ac0cb7b969314))


### Features

* **workflows:** publish SLSA provenance + SBOM attestations on every release tag (closes [#58](https://github.com/chrisleekr/github-app-playground/issues/58)) ([#94](https://github.com/chrisleekr/github-app-playground/issues/94)) ([95856bc](https://github.com/chrisleekr/github-app-playground/commit/95856bc2768694ed7b6da8103f5e8261b199bfa6))

# [1.8.0](https://github.com/chrisleekr/github-app-playground/compare/v1.7.0...v1.8.0) (2026-05-02)


### Bug Fixes

* **logger:** redact paths and scrub err.* before pino emits (closes [#52](https://github.com/chrisleekr/github-app-playground/issues/52)) ([#89](https://github.com/chrisleekr/github-app-playground/issues/89)) ([641f138](https://github.com/chrisleekr/github-app-playground/commit/641f1385a8ccbd9d549609e42859858c9ea1c8ea))
* **security:** redact raw error messages from public PR comments ([#90](https://github.com/chrisleekr/github-app-playground/issues/90)) ([cc70949](https://github.com/chrisleekr/github-app-playground/commit/cc709494e117c8d41f72e56e017dbeeaf3d71d83))


### Features

* **workflows:** unify bot reply format and harden research/resolve guards ([#91](https://github.com/chrisleekr/github-app-playground/issues/91)) ([7d39fb4](https://github.com/chrisleekr/github-app-playground/commit/7d39fb498fa9fd60079d57a564d44ec3345589e5))

# [1.7.0](https://github.com/chrisleekr/github-app-playground/compare/v1.6.1...v1.7.0) (2026-05-01)


### Bug Fixes

* **idempotency:** scope durable check with since=triggerTimestamp (closes [#33](https://github.com/chrisleekr/github-app-playground/issues/33)) ([#69](https://github.com/chrisleekr/github-app-playground/issues/69)) ([5f1c1fa](https://github.com/chrisleekr/github-app-playground/commit/5f1c1fa519c40128f9d18c360413ef262356bb11))


### Features

* **ship:** pr shepherding scaffolding + flag-gated trigger surfaces ([#75](https://github.com/chrisleekr/github-app-playground/issues/75)) ([928811b](https://github.com/chrisleekr/github-app-playground/commit/928811b21ccf594952439afa6d30652f69e08278))
* **ship:** scoped commands (US5) + remove SHIP_USE_TRIGGER_SURFACES_V2 flag ([#77](https://github.com/chrisleekr/github-app-playground/issues/77)) ([33132a3](https://github.com/chrisleekr/github-app-playground/commit/33132a3ffa968f169d0692450700dc445a6e2290))
* **ship:** wire ship iteration loop, tickle scheduler, and four scoped executors ([#79](https://github.com/chrisleekr/github-app-playground/issues/79)) ([43da9aa](https://github.com/chrisleekr/github-app-playground/commit/43da9aa0568c5b8cd2817b70e91f257aa260a5f5))

## [1.6.1](https://github.com/chrisleekr/github-app-playground/compare/v1.6.0...v1.6.1) (2026-04-27)


### Bug Fixes

* **triage:** raise verdict details cap to 50k sanity bound ([#67](https://github.com/chrisleekr/github-app-playground/issues/67)) ([4634ff7](https://github.com/chrisleekr/github-app-playground/commit/4634ff7cc8f0dd8c92541500781b706b2c6d2d80))

# [1.6.0](https://github.com/chrisleekr/github-app-playground/compare/v1.5.0...v1.6.0) (2026-04-26)


### Bug Fixes

* **pipeline:** abort SDK query on timeout and daemon cancel ([#62](https://github.com/chrisleekr/github-app-playground/issues/62)) ([94a103a](https://github.com/chrisleekr/github-app-playground/commit/94a103a64330c2976d91a6663eb81cc7ad04d049))


### Features

* **triage:** tighten bug reproduction methodology in agent prompt ([#64](https://github.com/chrisleekr/github-app-playground/issues/64)) ([5416bb9](https://github.com/chrisleekr/github-app-playground/commit/5416bb9c6674fbc0edb2ac10cc5864281ed90a97))

# [1.5.0](https://github.com/chrisleekr/github-app-playground/compare/v1.4.0...v1.5.0) (2026-04-26)


### Features

* **workflows:** cascade PR retargeting + bounded review/resolve loop ([#63](https://github.com/chrisleekr/github-app-playground/issues/63)) ([3079014](https://github.com/chrisleekr/github-app-playground/commit/3079014a21b5c7a4a22e077caa0b23d23b21a9dc))

# [1.4.0](https://github.com/chrisleekr/github-app-playground/compare/v1.3.2...v1.4.0) (2026-04-26)


### Features

* **workflows:** up-front tracking comments, trigger reactions, parent cascade ([#61](https://github.com/chrisleekr/github-app-playground/issues/61)) ([befe07c](https://github.com/chrisleekr/github-app-playground/commit/befe07caff9e0f9b7b1984103e989a1bd3732a2c))

## [1.3.2](https://github.com/chrisleekr/github-app-playground/compare/v1.3.1...v1.3.2) (2026-04-26)


### Bug Fixes

* **triage:** remove 500-char cap on verdict summary ([#60](https://github.com/chrisleekr/github-app-playground/issues/60)) ([ed3c657](https://github.com/chrisleekr/github-app-playground/commit/ed3c657d5a93bc4d6379f0b6dd844cb71188e1ae))

## [1.3.1](https://github.com/chrisleekr/github-app-playground/compare/v1.3.0...v1.3.1) (2026-04-26)


### Bug Fixes

* **auth:** prevent empty ANTHROPIC_API_KEY from shadowing real OAuth token ([#59](https://github.com/chrisleekr/github-app-playground/issues/59)) ([d7001ef](https://github.com/chrisleekr/github-app-playground/commit/d7001efc0e4ea6125b86dfda93fba08b9e8464b5))

# [1.3.0](https://github.com/chrisleekr/github-app-playground/compare/v1.2.2...v1.3.0) (2026-04-25)


### Bug Fixes

* **review:** forward installation token, post inline findings, and stream progress ([#57](https://github.com/chrisleekr/github-app-playground/issues/57)) ([7ee4861](https://github.com/chrisleekr/github-app-playground/commit/7ee486117ed5dec000413c99b632df783fba4e55))
* **workflows:** make end-to-end runs survive without mid-run caps or stale state ([#55](https://github.com/chrisleekr/github-app-playground/issues/55)) ([35ee605](https://github.com/chrisleekr/github-app-playground/commit/35ee605f3f4cc447fe3f6bec4f9d4ae711f150b4))


### Features

* **workflows:** add label-dispatched bot workflow foundation ([#49](https://github.com/chrisleekr/github-app-playground/issues/49)) ([1b18779](https://github.com/chrisleekr/github-app-playground/commit/1b187792c5e1a8f78ae08e820e2281a11414a161))

## [1.2.2](https://github.com/chrisleekr/github-app-playground/compare/v1.2.1...v1.2.2) (2026-04-20)


### Bug Fixes

* **orchestrator:** await Valkey connect before flipping isReady ([#37](https://github.com/chrisleekr/github-app-playground/issues/37)) ([372af9d](https://github.com/chrisleekr/github-app-playground/commit/372af9dd272e1a7a1e8890f4738c77d05dace76f))

## [1.2.1](https://github.com/chrisleekr/github-app-playground/compare/v1.2.0...v1.2.1) (2026-04-20)


### Bug Fixes

* **ci:** resolve gitleaks false positives and add dedicated secrets-scan workflow ([#36](https://github.com/chrisleekr/github-app-playground/issues/36)) ([a27df4b](https://github.com/chrisleekr/github-app-playground/commit/a27df4bb58524d732b86cbfb43d13a94a53cf19f))

# [1.2.0](https://github.com/chrisleekr/github-app-playground/compare/v1.1.1...v1.2.0) (2026-04-19)


### Features

* split orchestrator/daemon images, default Opus 4.7, fix PEM parsing ([#32](https://github.com/chrisleekr/github-app-playground/issues/32)) ([70b4b32](https://github.com/chrisleekr/github-app-playground/commit/70b4b328c2e60525c7e59ddbf1396fd3606acb00))

## [1.1.1](https://github.com/chrisleekr/github-app-playground/compare/v1.1.0...v1.1.1) (2026-04-18)


### Bug Fixes

* **deploy:** set NODE_ENV=production during build and bundle daemon entrypoint ([#31](https://github.com/chrisleekr/github-app-playground/issues/31)) ([87ae7e2](https://github.com/chrisleekr/github-app-playground/commit/87ae7e2b2a3b30bca3401121346f50ddfded059f))

# [1.1.0](https://github.com/chrisleekr/github-app-playground/compare/v1.0.0...v1.1.0) (2026-04-17)


### Bug Fixes

* **orchestrator:** use IN ${db(ids)} in repo-knowledge to fix Bun.sql array binding ([#26](https://github.com/chrisleekr/github-app-playground/issues/26)) ([d5e1b17](https://github.com/chrisleekr/github-app-playground/commit/d5e1b17f412e009c880d740a68c03cdadba8fe0f))
* **research:** update schedule ([ac300d5](https://github.com/chrisleekr/github-app-playground/commit/ac300d5eeba73fe318b73f6fe5cbb393e4dc3cb5))


### Features

* **auth:** add CLAUDE_CODE_OAUTH_TOKEN support with ALLOWED_OWNERS allowlist ([#10](https://github.com/chrisleekr/github-app-playground/issues/10)) ([445d354](https://github.com/chrisleekr/github-app-playground/commit/445d354487ae46bd6a82772a74c09822621456b0))
* **ci:** add scheduled research workflow with claude-code-action ([#9](https://github.com/chrisleekr/github-app-playground/issues/9)) ([f67c5db](https://github.com/chrisleekr/github-app-playground/commit/f67c5dbcd8edb5584b7ab4a08a51d69767f2aad4))
* **core:** extract inline pipeline and add database foundation for dual-mode dispatch ([#13](https://github.com/chrisleekr/github-app-playground/issues/13)) ([f05e818](https://github.com/chrisleekr/github-app-playground/commit/f05e8182f5f01c85473f7c68af063dbcd9de8e20))
* **daemon:** add persistent repo memory, env var injection, and dev E2E tooling ([#14](https://github.com/chrisleekr/github-app-playground/issues/14)) ([585156f](https://github.com/chrisleekr/github-app-playground/commit/585156f2db6ee8ef889122018e07f20fa132d3e6))
* triage-dispatch-modes Slice B — setup + foundational (T001-T013) ([#18](https://github.com/chrisleekr/github-app-playground/issues/18)) ([d0533eb](https://github.com/chrisleekr/github-app-playground/commit/d0533eb55ef9a0319288063f1dd9ecd55013e83d))
* triage-dispatch-modes Slice C — US1 MVP label/keyword routing (T014-T026) ([#19](https://github.com/chrisleekr/github-app-playground/issues/19)) ([2b345ee](https://github.com/chrisleekr/github-app-playground/commit/2b345ee365c7070c79413429757a3327610ad893))
* **triage:** Slice D — US2 auto-mode probabilistic dispatch ([#20](https://github.com/chrisleekr/github-app-playground/issues/20)) ([457eb4e](https://github.com/chrisleekr/github-app-playground/commit/457eb4ee321fcce5ed8ae210f813787d4c28ac09))
* **triage:** Slice E (part 1) — isolated-job capacity gate + pending queue + drainer ([#21](https://github.com/chrisleekr/github-app-playground/issues/21)) ([7653b0d](https://github.com/chrisleekr/github-app-playground/commit/7653b0db655bd70dbea180c288e0e03553867923))
* **triage:** slice E part 2 — isolated-job completion watcher (T042/T046–T049) ([#22](https://github.com/chrisleekr/github-app-playground/issues/22)) ([c0e86dd](https://github.com/chrisleekr/github-app-playground/commit/c0e86dd897dba34133b87ba9cd1e97c15936e161))
* **triage:** slice F — US4 telemetry aggregates + log contract (T050–T054) ([#24](https://github.com/chrisleekr/github-app-playground/issues/24)) ([bb7fa9f](https://github.com/chrisleekr/github-app-playground/commit/bb7fa9f7f9df76e20cc2608c06f28b892383d2ff))

# 1.0.0 (2026-02-19)


### Bug Fixes

* **deps:** upgrade zod to v4, prepar e npm publish, fix CI peer-dep conflict ([#3](https://github.com/chrisleekr/github-app-playground/issues/3)) ([84564a8](https://github.com/chrisleekr/github-app-playground/commit/84564a8c9a2a5f4b9f5722ce77db383168efd47c))
