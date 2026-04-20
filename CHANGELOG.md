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
