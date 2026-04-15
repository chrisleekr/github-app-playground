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

**Router** (`src/webhook/router.ts`): routing concerns — idempotency (in-memory `Map` + durable tracking comment check), owner allowlist, concurrency guard, then delegates to the inline pipeline.

**Inline pipeline** (`src/core/inline-pipeline.ts`):

1. Create tracking comment ("Working…")
2. Get installation token
3. Fetch PR/issue data via GraphQL
4. Build prompt with full context
5. Clone repo to temp directory, checkout PR/default branch
6. Resolve MCP servers and allowed tools
7. Run Claude Agent SDK with `cwd` set to cloned repo
8. Finalize tracking comment (success/error/cost)
9. Cleanup temp directory

## Architecture

- `src/webhook/` — Event routing (`router.ts`) and per-event handlers (`events/`, one file per event type)
- `src/core/` — Pipeline: context → fetch → format → prompt → checkout → execute. The inline pipeline (`inline-pipeline.ts`) is the main execution path.
- `src/db/` — Database layer (Postgres via `Bun.sql`). Connection singleton (`index.ts`), migration runner (`migrate.ts`), SQL migrations (`migrations/`). Only active when `DATABASE_URL` is configured.
- `src/orchestrator/` — WebSocket server, daemon registry, job queue, job dispatcher, execution history, Valkey client, concurrency tracking. Embedded in the webhook server process when `AGENT_JOB_MODE !== "inline"`.
- `src/daemon/` — Standalone daemon worker process. Connects to orchestrator via WebSocket, discovers local capabilities, accepts/rejects job offers, executes jobs via inline pipeline. Entry: `src/daemon/main.ts`.
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

The scheduled research workflow in `.github/workflows/research.yml` also uses `CLAUDE_CODE_OAUTH_TOKEN`, but via `anthropics/claude-code-action@v1` — that path is separately sanctioned for CI and is not subject to the `ALLOWED_OWNERS` requirement.

## Code Conventions

- Runtime is Bun (app) + Node.js (Claude Code CLI).
- `moduleResolution: "bundler"` — imports don't need `.js` extensions.
- Structured JSON logging via `pino` with child loggers per request.
- All config validated via `zod` at startup.
- ESLint 9 flat config with TypeScript type-aware rules, `eslint-plugin-security`, `eslint-plugin-simple-import-sort`.
- Strict TypeScript: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `useUnknownInCatchVariables`, etc.
- Pre-commit hooks via Husky + lint-staged (auto-format + lint on staged files).
- Conventional commits enforced via commitlint.

## Active Technologies

- TypeScript 5.9.3 (strict mode with `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `useUnknownInCatchVariables`) on Bun ≥1.3.12 (see `package.json` `packageManager` pin). + existing — `octokit`, `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`, `pino`, `zod`, Bun built-in `WebSocket` + `RedisClient`. New — `@anthropic-ai/bedrock-sdk` (for the LLMClient Bedrock path) and `@kubernetes/client-node` (for in-cluster Job spawning). `@anthropic-ai/sdk` is already a transitive dep of `claude-agent-sdk`. (20260415-000159-triage-dispatch-modes)
- PostgreSQL 17 via `Bun.sql` singleton (existing `executions` + `daemons` tables from migration `001_initial.sql`); Valkey 8 (Redis-compatible) via Bun built-in `RedisClient` for the new pending isolated-job queue and the existing Phase 2 job queue / daemon registry. (20260415-000159-triage-dispatch-modes)

- TypeScript 5.9.3 strict mode on Bun >=1.3.8 + `octokit`, `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`, `pino`, `zod` (all existing). New: Bun built-in `WebSocket` + `RedisClient` (zero new npm dependencies). (20260413-191249-daemon-orchestrator-core)
- PostgreSQL 17 (pgvector-ready, existing `executions` + `daemons` tables from `001_initial.sql`) + Valkey 8 (Redis 7.2-compatible, via Bun built-in `RedisClient`) (20260413-191249-daemon-orchestrator-core)

- TypeScript (strict mode) on Bun >=1.3.8 + `octokit`, `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`, `pino`, `zod`

## Recent Changes

- 20260410-164348-scheduled-research-workflow: Config-only (no `src/` changes) — adds `.github/workflows/research.yml` invoking `anthropics/claude-code-action@v1` once daily (`cron: "0 5 * * *"` = 3pm AEST / 4pm AEDT) and on `workflow_dispatch` with an optional `focus_area` input. Hard 1-hour wall-clock budget (`timeout-minutes: 60`), at most one labelled GitHub issue per run, agent restricted to read + `WebSearch`/`WebFetch` + `gh issue/label create`, two repo secrets (`CLAUDE_CODE_OAUTH_TOKEN`, `PERSONAL_ACCESS_TOKEN`), `permissions: contents:read + issues:write + id-token:write`, `concurrency: research-workflow / cancel-in-progress: false`. 10 fixed focus areas mapped to `src/` subsystems. Two-label scheme (`research` + `area: <name>`). Inherits documented workarounds from `chrisleekr/personal-claw` `research.yml` (`allowed_bots: '*'`, `--disallowedTools ""`, PAT instead of OIDC). **Defense-in-depth against workflow injection**: every GitHub-context value (including `github.event.inputs.focus_area`) is passed via `env:` blocks rather than interpolated into `run:` scripts; the user-supplied `focus_area` is additionally validated against `^[a-z][a-z0-9-]{0,31}$` BEFORE being used (rejected values fall back to a random pick and log only their length, never the value itself) — satisfies Constitution Principle IV. **Failure surfacing**: relies on GitHub Actions' built-in workflow-failure email; no custom alerting. **Cost observability**: per Constitution Principle VI bullet 2, `claude-code-action`'s own per-turn cost output is captured by GitHub Actions stdout and retrieved post-mortem via `gh run view <run-id> --log | grep -iE 'cost|tokens|duration|usage'` (see `specs/.../research.md` §19 and `quickstart.md` Day-2 ops). **Test coverage gap** (Constitution Principle V) justified in `plan.md` Complexity Tracking; mitigated via `actionlint` static check + mandatory manual smoke test before merge (see `quickstart.md`).
- 20260409-081113-project-housekeeping: Housekeeping — test coverage raised to 90% per-file threshold (lines + functions; Bun's `coverageThreshold` is applied per-file, not aggregated), ESLint migrated to unified `typescript-eslint` with `strictTypeChecked` preset, CI security scanning added (`bun audit`, `trivy` container scan with blocking `exit-code: "1"`, `gitleaks` full-history scan with `fetch-depth: 0`), Docker HEALTHCHECK on `/healthz`, gitleaks pre-commit hook, retry.ts input validation (maxAttempts/initialDelayMs/maxDelayMs/backoffFactor all reject NaN/Infinity/below-min with descriptive errors), `package.json` security overrides converted to exact version pins.
