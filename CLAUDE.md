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
```

## What This Is

A GitHub App that responds to `@chrisleekr-bot` mentions on PRs and issues. Ported from [claude-code-action](https://github.com/anthropics/claude-code-action) tag mode to a standalone webhook server.

- Webhook URL: `https://github.chrislee.local/api/github/webhooks`
- Uses Claude Agent SDK with MCP servers for GitHub interactions

## How It Runs

Single HTTP server (`src/app.ts`) using `octokit` App class. Webhook events arrive at `/api/github/webhooks`, are verified via HMAC-SHA256, then dispatched to event handlers:

**Event handler** (`src/webhook/events/`): parse event → unified `BotContext` → check for `@chrisleekr-bot` trigger → fire-and-forget `processRequest()`

**Inside `processRequest()`** (`src/webhook/router.ts`):

1. Idempotency check — in-memory `Map` (fast path) + durable check via existing tracking comment (survives pod restarts)
2. Concurrency guard — reject if active executions ≥ `MAX_CONCURRENT_REQUESTS`
3. Create tracking comment ("Working…")
4. Fetch PR/issue data via GraphQL
5. Build prompt with full context
6. Clone repo to temp directory, checkout PR/default branch
7. Resolve MCP servers and allowed tools
8. Run Claude Agent SDK with `cwd` set to cloned repo
9. Finalize tracking comment (success/error/cost)
10. Cleanup temp directory

## Architecture

- `src/webhook/` — Event routing (`router.ts`) and per-event handlers (`events/`, one file per event type)
- `src/core/` — Pipeline: context → fetch → format → prompt → checkout → execute
- `src/mcp/` — MCP server registry and servers (extensible: add new servers)
- `src/utils/` — Retry logic, sanitization

## Key Concepts

- **Async processing**: Webhook must respond within 10 seconds. All heavy work runs asynchronously after 200 OK.
- **Idempotency**: Two-layer guard. Fast path: in-memory `Map` keyed by `X-GitHub-Delivery` header (lost on restart). Durable: `isAlreadyProcessed()` checks GitHub for an existing tracking comment — survives pod restarts and OOM kills.
- **Repo checkout**: Each request clones the repo to a unique temp dir. Claude operates on local files via `cwd`.
- **MCP servers**: Comment updates, inline reviews, and Context7 for library docs. Git changes are made via git CLI (Bash tool) on the cloned repo.

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

- TypeScript (strict mode) on Bun >=1.3.8 + `octokit`, `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`, `pino`, `zod`

## Recent Changes

- 20260410-164348-scheduled-research-workflow: Config-only (no `src/` changes) — adds `.github/workflows/research.yml` invoking `anthropics/claude-code-action@v1` once daily (`cron: "0 22 * * *"`) and on `workflow_dispatch` with an optional `focus_area` input. Hard 1-hour wall-clock budget (`timeout-minutes: 60`), at most one labelled GitHub issue per run, agent restricted to read + `WebSearch`/`WebFetch` + `gh issue/label create`, two repo secrets (`CLAUDE_CODE_OAUTH_TOKEN`, `PERSONAL_ACCESS_TOKEN`), `permissions: contents:read + issues:write + id-token:write`, `concurrency: research-workflow / cancel-in-progress: false`. 10 fixed focus areas mapped to `src/` subsystems. Two-label scheme (`research` + `area: <name>`). Inherits documented workarounds from `chrisleekr/personal-claw` `research.yml` (`allowed_bots: '*'`, `--disallowedTools ""`, PAT instead of OIDC). **Defense-in-depth against workflow injection**: every GitHub-context value (including `github.event.inputs.focus_area`) is passed via `env:` blocks rather than interpolated into `run:` scripts; the user-supplied `focus_area` is additionally validated against `^[a-z][a-z0-9-]{0,31}$` BEFORE being used (rejected values fall back to a random pick and log only their length, never the value itself) — satisfies Constitution Principle IV. **Failure surfacing**: relies on GitHub Actions' built-in workflow-failure email; no custom alerting. **Cost observability**: per Constitution Principle VI bullet 2, `claude-code-action`'s own per-turn cost output is captured by GitHub Actions stdout and retrieved post-mortem via `gh run view <run-id> --log | grep -iE 'cost|tokens|duration|usage'` (see `specs/.../research.md` §19 and `quickstart.md` Day-2 ops). **Test coverage gap** (Constitution Principle V) justified in `plan.md` Complexity Tracking; mitigated via `actionlint` static check + mandatory manual smoke test before merge (see `quickstart.md`).
- 20260409-081113-project-housekeeping: Housekeeping — test coverage raised to 90% per-file threshold (lines + functions; Bun's `coverageThreshold` is applied per-file, not aggregated), ESLint migrated to unified `typescript-eslint` with `strictTypeChecked` preset, CI security scanning added (`bun audit`, `trivy` container scan with blocking `exit-code: "1"`, `gitleaks` full-history scan with `fetch-depth: 0`), Docker HEALTHCHECK on `/healthz`, gitleaks pre-commit hook, retry.ts input validation (maxAttempts/initialDelayMs/maxDelayMs/backoffFactor all reject NaN/Infinity/below-min with descriptive errors), `package.json` security overrides converted to exact version pins.
