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
