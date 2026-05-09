# CLAUDE.md

## Commands

```bash
bun install             # Install dependencies
bun run dev             # Run in watch mode (development)
bun run start           # Run in production
bun test                # Run tests
bun run test:watch      # Run tests in watch mode
bun run test:coverage   # Run tests with coverage
bun run typecheck       # TypeScript type checking
bun run lint            # ESLint check
bun run lint:fix        # ESLint auto-fix
bun run format          # Check formatting with prettier
bun run format:fix      # Auto-fix formatting with prettier
bun run audit:ci        # Severity-gated dependency audit (used by CI)
bun run dev:deps        # Start local Valkey + Postgres (Docker Compose)
bun run dev:deps:down   # Stop local infrastructure
```

## What This Is

A GitHub App that responds to `@chrisleekr-bot` mentions on PRs and issues. Ported from [claude-code-action](https://github.com/anthropics/claude-code-action) tag mode to a standalone webhook server.

- Webhook URL: `https://github.chrislee.local/api/github/webhooks`
- Uses Claude Agent SDK with MCP servers for GitHub interactions

## How It Runs

Single HTTP server (`src/app.ts`) using `octokit` App class. Webhook events arrive at `/api/github/webhooks`, are verified via HMAC-SHA256, then dispatched to event handlers:

**Event handler** (`src/webhook/events/`): parse event → unified `BotContext` → check for `@chrisleekr-bot` trigger → fire-and-forget `processRequest()`

**Router** (`src/webhook/router.ts`): idempotency (in-memory `Map` + durable tracking-comment check), owner allowlist, concurrency guard, triage, and scale-up decision. On heavy/overflow it spawns an ephemeral daemon K8s Pod (`src/k8s/ephemeral-daemon-spawner.ts`). The job is then enqueued for any daemon in the fleet to claim over WebSocket. The webhook server never executes the pipeline in-process.

**Pipeline** (`src/core/pipeline.ts`, executed by the daemon):

1. Create tracking comment ("Working…")
2. Resolve GitHub credential (App installation token by default; PAT when `GITHUB_PERSONAL_ACCESS_TOKEN` is set — see "Authentication options")
3. Fetch PR/issue data via GraphQL
4. Build prompt with full context
5. Clone repo to temp directory, checkout PR/default branch (and supplementally fetch the PR base branch when it differs from head, so `origin/<baseBranch>` resolves for diffs/rebases). Also create a sibling artifacts directory (`${workDir}-artifacts`) outside the clone, exported to the agent as `BOT_ARTIFACT_DIR` so summary files (IMPLEMENT.md / REVIEW.md / RESOLVE.md) cannot accidentally be `git add`-ed
6. Resolve MCP servers and allowed tools
7. Run Claude Agent SDK with `cwd` set to cloned repo
8. Finalize tracking comment (success/error/cost)
9. Cleanup temp directory + sibling artifacts directory

## Architecture

- `src/webhook/` — Event routing (`router.ts`) and per-event handlers (`events/`, one file per event type)
- `src/core/` — Pipeline: context → fetch → format → prompt → checkout → execute. `pipeline.ts` is the single execution path (run inside the daemon, never in-process in the webhook server).
- `src/db/` — Database layer (Postgres via `Bun.sql`). Connection singleton (`index.ts`), migration runner (`migrate.ts`), SQL migrations (`migrations/`). Only active when `DATABASE_URL` is configured.
- `src/orchestrator/` — WebSocket server, daemon registry, job queue, job dispatcher, execution history, Valkey client, concurrency tracking, ephemeral-daemon scaler. Embedded in the webhook server process.
- `src/daemon/` — Standalone daemon worker process (persistent or ephemeral). Connects to the orchestrator via WebSocket, discovers local capabilities, accepts/rejects job offers, executes jobs via `src/core/pipeline.ts`. When `DAEMON_EPHEMERAL=true`, exits after `EPHEMERAL_DAEMON_IDLE_TIMEOUT_MS` of idle. Entry: `src/daemon/main.ts`.
- `src/k8s/` — Ephemeral daemon Pod spawner (`ephemeral-daemon-spawner.ts`). Creates a bare Pod running the same daemon image with `DAEMON_EPHEMERAL=true`.
- `src/shared/` — Types shared between server and daemon: WebSocket message schemas (`ws-messages.ts`), daemon capability types (`daemon-types.ts`).
- `src/mcp/` — MCP server registry and servers (extensible: add new servers). Includes `daemon-capabilities` server for daemon environment awareness.
- `src/utils/` — Retry logic, sanitization

## Key Concepts

- **Async processing**: Webhook must respond within 10 seconds. All heavy work runs asynchronously after 200 OK.
- **Idempotency**: Two-layer guard. Fast path: in-memory `Map` keyed by `X-GitHub-Delivery` header (lost on restart). Durable: `isAlreadyProcessed()` checks GitHub for an existing tracking comment — survives pod restarts and OOM kills.
- **Repo checkout**: Each request clones the repo to a unique temp dir. Claude operates on local files via `cwd`.
- **MCP servers**: Comment updates, inline reviews, and Context7 for library docs. Git changes are made via git CLI (Bash tool) on the cloned repo.

## Authentication options

The runtime bot in `src/` supports three authentication modes (see `src/config.ts`):

1. **`ANTHROPIC_API_KEY`** — Console pay-as-you-go. Safe for multi-tenant deployments.
2. **`CLAUDE_CODE_OAUTH_TOKEN`** — Max/Pro subscription OAuth token (`sk-ant-oat...`, generated via `claude setup-token`). **Requires `ALLOWED_OWNERS`** to be set to a single-tenant value, because the [Agent SDK Note](https://code.claude.com/docs/en/agent-sdk/overview) prohibits serving other users' repos from a personal subscription quota. The token is forwarded to the Claude CLI subprocess via `buildProviderEnv()` in `src/core/executor.ts`; the CLI's own [auth precedence chain](https://code.claude.com/docs/en/authentication#authentication-precedence) picks between credentials if multiple are set.
3. **AWS Bedrock** — full credential chain via `CLAUDE_PROVIDER=bedrock` + `AWS_REGION` + `CLAUDE_MODEL` (Bedrock model ID format). Credential resolution handled by the AWS SDK inside the subprocess.

Default agent execution model when `CLAUDE_MODEL` is unset and `CLAUDE_PROVIDER=anthropic`: `claude-opus-4-7` (Opus 4.7). The Bedrock path still requires an explicit `CLAUDE_MODEL` (Bedrock model IDs differ from Anthropic's).

The scheduled research workflow in `.github/workflows/research.yml` also uses `CLAUDE_CODE_OAUTH_TOKEN`, but via `anthropics/claude-code-action@v1` — that path is separately sanctioned for CI and is not subject to the `ALLOWED_OWNERS` requirement.

### GitHub credential

GitHub-side auth defaults to the App installation token minted on demand from `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`. Optional override:

- **`GITHUB_PERSONAL_ACCESS_TOKEN`** — when set, replaces the installation token for every GitHub API call (PR comments, reviews, GraphQL) and `git push` authentication. Those actions are attributed to the PAT owner instead of the App bot. Commit author/committer metadata is **not** affected — `src/core/checkout.ts` hard-codes git `user.name` / `user.email` to `chrisleekr-bot[bot]`, so commit objects still carry the bot identity regardless of the auth token. **Requires `ALLOWED_OWNERS`** to contain exactly one owner — same single-tenant constraint as `CLAUDE_CODE_OAUTH_TOKEN`, because a PAT carries a real human identity and its per-user rate-limit bucket. Resolution happens in `resolveGithubToken()` (`src/core/github-token.ts`); downstream consumers (git credential helper, executor env, MCP servers) accept the resolved string regardless of source.

## Code Conventions

- Runtime is Bun (app) + Node.js (Claude Code CLI).
- `moduleResolution: "bundler"` — imports don't need `.js` extensions.
- Structured JSON logging via `pino` with child loggers per request.
- All config validated via `zod` at startup.
- ESLint 9 flat config with TypeScript type-aware rules, `eslint-plugin-security`, `eslint-plugin-simple-import-sort`.
- Strict TypeScript: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `useUnknownInCatchVariables`, etc.
- Pre-commit hooks via Husky + lint-staged (auto-format + lint on staged files).
- Conventional commits enforced via commitlint.

## CI/CD Pipeline

Five workflow files form the pipeline; each owns one responsibility.

| Workflow                             | Trigger                                                   | Owns                                                                                                                                                                                                                      |
| ------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`           | `pull_request` + `push: main` + `workflow_call`           | Quality gates only: typecheck, lint, format, audit:ci, test, build                                                                                                                                                        |
| `.github/workflows/secrets-scan.yml` | `push: branches-ignore: [gh-pages]` + `workflow_dispatch` | Standalone gitleaks secret scan — decoupled from ci.yml so every push (incl. chore/docs/ci/test branches) is gated                                                                                                        |
| `.github/workflows/dev-release.yml`  | `push: branches-ignore: [main, v*]` + `workflow_dispatch` | Calls `ci.yml` → semantic-release dev (pre-release tag) → calls `docker-build.yml`                                                                                                                                        |
| `.github/workflows/release.yml`      | `workflow_dispatch` only (manual)                         | Calls `ci.yml` → semantic-release prod → calls `docker-build.yml`                                                                                                                                                         |
| `.github/workflows/docker-build.yml` | `workflow_call` + `workflow_dispatch`                     | Reusable image builder: matrix split-and-merge (amd64 on `ubuntu-24.04` + arm64 on `ubuntu-24.04-arm`), SLSA v1 provenance + SBOM attestations (BuildKit + Sigstore), `gh attestation verify` regression gate, Trivy scan |

- **Bun version is single-sourced** via `.tool-versions` (`bun 1.3.12`). All workflows use `oven-sh/setup-bun@v2` with `bun-version-file: .tool-versions`.
- **`audit:ci` (`scripts/audit-ci.ts`)** wraps `bun audit --json` to gate on severity: blocks on high+critical, warns on moderate+low, with an inline `IGNORED` GHSA allowlist (each entry must carry an `expires` date). Required because `bun audit` exits 1 on **any** finding regardless of `--audit-level`.
- **Semantic release config** (`release.config.mjs`) is single-file with `SEMREL_CHANNEL=dev|prod` env switching — replaces the previous file-swap hack.
- **Prod releases are manual.** Push to main only triggers `ci.yml` (sanity). Cut a release with `gh workflow run release.yml`.
- Multi-arch images: amd64 builds on `ubuntu-24.04`, arm64 builds natively on `ubuntu-24.04-arm` (free for public repos). Both runners are explicitly pinned (not `ubuntu-latest`) so the rolling alias can't silently flip to a new major and break the build — see the header of `.github/workflows/docker-build.yml`. Manifest assembled by `docker buildx imagetools create`. GHA cache scoped per arch.
- Defense-in-depth on workflow injection: every dynamic input flowing into a `run:` block is passed via `env:` first.

## Security invariants (prompt-injection hardening)

Four contracts contributors MUST preserve when touching the agent execution path or any GitHub-bound write:

1. **Subprocess env allowlist** (`src/core/executor.ts buildProviderEnv()`). The agent CLI receives an explicit allowlist + prefix patterns, NOT `...process.env`. If you add a new env var the CLI needs, extend the allowlist. Banned: `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `DAEMON_AUTH_TOKEN`, `DATABASE_URL`, `VALKEY_URL`, `REDIS_URL`, `CONTEXT7_API_KEY`, `GITHUB_PERSONAL_ACCESS_TOKEN`. See `docs/operate/configuration.md` § "Subprocess env allowlist".

2. **Output secret-strip chokepoint** (`src/utils/github-output-guard.ts safePostToGitHub`). Two behaviours:
   - Regex pass (`redactSecrets()`) silently strips matched bytes. NEVER use the input-side `[REDACTED_X]` marker for output paths — markers leak probing signal to attackers.
   - LLM scanner (default ON for `source: "agent"`, fail-open on Bedrock outage) catches encoded/obfuscated secrets the regex misses.

   **Coverage status (Phase 1).** Wired through the chokepoint today: `core/tracking-comment.ts` (create + update), `daemon/scoped-fix-thread-executor.ts`, `workflows/ship/scoped/chat-thread.ts`, `workflows/ship/scoped/fix-thread.ts` (all reply paths via `postReply` helper). Phase 2 (NOT yet wired — tracked separately): `webhook/router.ts` capacity messages, `workflows/ship/tracking-comment.ts`, `workflows/ship/scoped/marker-comment.ts`, `workflows/ship/scoped/open-pr.ts`, `workflows/ship/scoped/rebase.ts`, `workflows/tracking-mirror.ts`, `workflows/ship/lifecycle-commands.ts`, `workflows/ship/session-runner.ts`, `workflows/dispatcher.ts`, `daemon/scoped-open-pr-executor.ts`. When you touch any of those, prefer routing the new write through `safePostToGitHub({ body, source, callsite, log, post })` rather than adding another bypass.

   The MCP servers in `src/mcp/servers/` can't import `safePostToGitHub` directly (no daemon config in subprocess) — they apply `redactSecrets()` inline and log to `console.error` instead.

3. **Input sanitization chokepoint** (`src/core/formatter.ts` + `src/utils/sanitize.ts sanitizeContent()`). Every attacker-controllable string that crosses into `buildPrompt` (PR/issue title, branch names, body, comment bodies, review-comment bodies, review-comment paths, changed-file filenames) MUST pass through `sanitizeContent` at its formatter site. The pipeline strips zero-width / bidi-override / control characters, hidden HTML attributes, markdown image alt-text injection vectors, and known-format GitHub tokens — defenses load-bearing for the spotlit `<untrusted_*>` tag boundaries the `<security_directive>` block (`src/core/prompt-builder.ts`) relies on. When you add a new field to `FetchedData` or a new formatter helper, mirror the existing pattern (see `formatReviewComments` for body+path parity) — do not bare-interpolate. The `triggerBody` is sanitized via `sanitizeContent` at `src/core/prompt-builder.ts` for the same reason; `data.baseBranch` is also sanitized at every interpolation site there (not just inside `<formatted_context>`) so the invariant holds verbatim across the whole rendered prompt. The PR/issue-level author login (`data.author`) is additionally sanitized in `formatContext` as defense-in-depth, even though logins are GitHub-bounded. Otherwise-bounded GitHub-schema fields are exempt from this sanitizer requirement: per-comment `c.author` in `formatComments` / `formatReviewComments`, ISO timestamps, and the `PatchStatus` enum.

4. **Structured-output chokepoint** (`src/ai/structured-output.ts parseStructuredResponse()` + `src/utils/tolerant-json.ts`). Every LLM call site that expects a JSON-shaped response MUST route the model output through `parseStructuredResponse(raw, schema)` and append the encoding rules to its system prompt via `withStructuredRules(systemPrompt)`. The pipeline does code-fence stripping, strict JSON.parse, and a tolerant fallback that escapes raw LF/CR/TAB/control bytes inside JSON string values (the most common LLM failure mode — observed shipping on chat-thread). Returns a discriminated `StructuredResult<T>`; callers MUST switch on `result.ok` and own their failure policy (clarify fallback, fail-open, throw, etc.) — the pipeline does not encode policy. **Wired today**: `workflows/intent-classifier.ts`, `workflows/ship/nl-classifier.ts`, `workflows/ship/scoped/chat-thread.ts`, `workflows/ship/scoped/meta-issue-classifier.ts`, `orchestrator/triage.ts`, `utils/llm-output-scanner.ts`, `workflows/handlers/triage.ts`. When adding a new LLM call site that expects JSON, do NOT call `JSON.parse` directly — route through this chokepoint so future LLM-quirk fixes apply uniformly. Strategy is observable via `result.strategy` (`"strict"` | `"tolerant"`) for monitoring model JSON-quality regressions.

The `triggerUsername` is rejected (not silently stripped) if it contains whitespace/newline — git commit trailer forging vector. Don't relax that check.

## Documentation

The `docs/` tree is published as a MkDocs Material site at <https://chrisleekr.github.io/github-app-playground/>. Local preview: `bun run docs:install` once, then `bun run docs:serve` for live reload or `bun run docs:build` for the strict build CI runs.

**Keep docs in sync with code.** When a PR changes any of these surfaces, update the matching page in `docs/` in the same PR:

- `src/config.ts` env var schema → `docs/operate/configuration.md`
- `src/shared/dispatch-types.ts` targets or reasons → `docs/operate/observability.md` + `docs/build/architecture.md`
- `src/orchestrator/triage.ts` fallback reasons or model config → `docs/operate/runbooks/triage.md`
- `src/webhook/` routing or idempotency behaviour → `docs/build/architecture.md`
- `src/k8s/ephemeral-daemon-spawner.ts` Pod-spec changes → `docs/operate/runbooks/daemon-fleet.md` + `docs/operate/deployment.md` (RBAC)
- `src/daemon/` lifecycle → `docs/operate/runbooks/daemon-fleet.md`
- `src/workflows/` registry, dispatcher, handlers, or orchestrator → `docs/use/workflows/`
- New MCP server in `src/mcp/` → `docs/build/extending.md`
- New Pino log field or metric → `docs/operate/observability.md`

Validate locally with `bun run docs:build` before pushing. If no matching doc exists yet, flag the gap in the PR description rather than shipping silently.

**CI-enforced doc gates.** Two project-specific checks run in `.github/workflows/docs.yml` ahead of `mkdocs build --strict` (which only validates internal links and snippet targets, not prose-vs-source agreement):

- Bun version strings in `docs/` are pinned to `.tool-versions` via `bun run scripts/check-docs-versions.ts` (also asserts `package.json` `engines.bun` / `packageManager` and the two `Dockerfile.*` `FROM oven/bun:<ver>` lines agree).
- `src/<file>:<line>` citations in `docs/` are anchor-verified via `bun run scripts/check-docs-citations.ts` (file must exist; cited line / range must be in bounds).

The `docs.yml` `pull_request:` trigger has no `paths:` filter, so these gates run on every PR — code-side bumps that invalidate doc facts (Renovate Bun bump, refactor that shifts cited line numbers) trip the build the same way doc edits do. `Deploy to GitHub Pages` is still gated on `push` / `workflow_dispatch`, so PRs validate but never publish.

## Active Technologies

- TypeScript 5.9.3, strict mode (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `useUnknownInCatchVariables`) + `octokit`, `@anthropic-ai/claude-agent-sdk` (multi-turn agent flows for fix-thread/open-pr executors; conversational chat-thread runs via the single-turn `src/ai/llm-client.ts` path), `@modelcontextprotocol/sdk`, `pino`, `zod`, Bun built-in `WebSocket` + `RedisClient`. **No new npm dependencies.** (20260429-212559-ship-iteration-wiring)
- Postgres 17 via `Bun.sql` singleton — no schema changes; reuses existing `ship_intents`, `ship_iterations`, `ship_continuations`, `workflow_runs` tables. Valkey 8 — reuses existing `ship:tickle` sorted set and `queue:jobs` list. (20260429-212559-ship-iteration-wiring)

- TypeScript 5.9.3 strict mode on Bun ≥1.3.13 + `octokit` (webhook + GraphQL/REST), `@anthropic-ai/claude-agent-sdk` (multi-turn handlers), `@anthropic-ai/bedrock-sdk` (single-turn intent classification via `src/ai/llm-client.ts`), `@modelcontextprotocol/sdk`, `pino`, `zod`. No new npm dependencies. (20260421-181205-bot-workflows)
- PostgreSQL 17 via `Bun.sql` singleton — adds one migration (`005_workflow_runs.sql`). Valkey 8 via Bun built-in `RedisClient` — existing job queue reused unchanged. (20260421-181205-bot-workflows)

- TypeScript 5.9.3 (strict mode with `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `useUnknownInCatchVariables`) on Bun ≥1.3.12 (see `package.json` `packageManager` pin). Deps — `octokit`, `@anthropic-ai/claude-agent-sdk`, `@anthropic-ai/bedrock-sdk` (Bedrock single-turn adaptor in `src/ai/llm-client.ts`), `@modelcontextprotocol/sdk`, `@kubernetes/client-node` (ephemeral-daemon Pod spawning in `src/k8s/ephemeral-daemon-spawner.ts`), `pino`, `zod`, Bun built-in `WebSocket` + `RedisClient`. `@anthropic-ai/sdk` is a transitive dep of `claude-agent-sdk`.
- **Dispatch taxonomy (post-collapse)**: `DispatchTarget` = `daemon` (singleton — kept as a field for DB/log stability); `DispatchReason` = `persistent-daemon` | `ephemeral-daemon-triage` | `ephemeral-daemon-overflow` | `ephemeral-spawn-failed`. Canonical source: `src/shared/dispatch-types.ts`. (20260419-collapse-dispatch-to-daemon)
- PostgreSQL 17 via `Bun.sql` singleton (`executions` + `triage_results` tables from migrations `001_initial.sql` → `004_collapse_dispatch_to_daemon.sql`); Valkey 8 (Redis-compatible) via Bun built-in `RedisClient` for the daemon job queue. Operator aggregates in `src/db/queries/dispatch-stats.ts`.

- TypeScript 5.9.3 strict mode on Bun >=1.3.8 + `octokit`, `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`, `pino`, `zod` (all existing). New: Bun built-in `WebSocket` + `RedisClient` (zero new npm dependencies). (20260413-191249-daemon-orchestrator-core)
- PostgreSQL 17 (pgvector-ready, existing `executions` + `daemons` tables from `001_initial.sql`) + Valkey 8 (Redis 7.2-compatible, via Bun built-in `RedisClient`) (20260413-191249-daemon-orchestrator-core)

- TypeScript (strict mode) on Bun >=1.3.8 + `octokit`, `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`, `pino`, `zod`

<!-- SPECKIT START -->

<!-- SPECKIT END -->
