# Quickstart: Daemon and Orchestrator Core (Phase 2)

**Branch**: `20260413-191249-daemon-orchestrator-core`
**Date**: 2026-04-13

## Prerequisites

- Bun >=1.3.8 installed
- Docker + Docker Compose (for local Postgres + Valkey)
- Git
- The repo cloned and on the `20260413-191249-daemon-orchestrator-core` branch

## Local Development Setup

### 1. Start Infrastructure

```bash
# Start Postgres (pgvector) + Valkey via Docker Compose
bun run dev:deps

# Verify containers are healthy
docker compose -f docker-compose.dev.yml ps
```

Expected output: `postgres` and `valkey` both `healthy`.

### 2. Configure Environment

Create `.env.local` (gitignored) with daemon-mode configuration:

```bash
# Existing (already required)
GITHUB_APP_ID=your-app-id
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
GITHUB_WEBHOOK_SECRET=your-webhook-secret
ANTHROPIC_API_KEY=your-api-key
ALLOWED_OWNERS=chrisleekr

# Phase 2: Enable daemon dispatch
AGENT_JOB_MODE=auto
DATABASE_URL=postgresql://bot:bot@localhost:5432/github_app
VALKEY_URL=redis://localhost:6379

# Orchestrator WebSocket port
WS_PORT=3002

# Daemon auth (same value on server and daemon)
DAEMON_AUTH_TOKEN=dev-secret-change-in-production
```

### 3. Run the Webhook Server (with Orchestrator)

```bash
# Development mode with hot reload
bun run dev
```

The server starts two listeners:
- HTTP webhook server on `:3000` (`/api/github/webhooks`, `/healthz`, `/readyz`)
- WebSocket orchestrator on `:3002` (`/ws`)

### 4. Run a Daemon (separate terminal)

```bash
# Start daemon process — connects to orchestrator on ws://localhost:3002/ws
DAEMON_AUTH_TOKEN=dev-secret-change-in-production \
ORCHESTRATOR_URL=ws://localhost:3002/ws \
CLONE_BASE_DIR=/tmp/daemon-workspaces \
DAEMON_UPDATE_STRATEGY=notify \
bun run src/daemon/main.ts
```

Expected log output:
```
{"level":"info","msg":"Daemon starting","daemonId":"daemon-dev-mac-12345","orchestratorUrl":"ws://localhost:3002/ws"}
{"level":"info","msg":"Connected to orchestrator"}
{"level":"info","msg":"Registered with orchestrator","capabilities":{"platform":"darwin","cliTools":["git","bun","docker"],...}}
```

### 5. Verify End-to-End

1. **Check daemon is registered**: The orchestrator logs should show:
   ```
   {"level":"info","msg":"Daemon registered","daemonId":"daemon-dev-mac-12345","platform":"darwin"}
   ```

2. **Trigger a webhook**: Mention `@chrisleekr-bot` on a PR or issue in an allowed repo.

3. **Observe dispatch**: Server logs show:
   ```
   {"level":"info","msg":"Job queued","deliveryId":"abc123"}
   {"level":"info","msg":"Job offered to daemon","daemonId":"daemon-dev-mac-12345","offerId":"..."}
   {"level":"info","msg":"Daemon accepted job","daemonId":"daemon-dev-mac-12345"}
   ```

4. **Observe execution**: Daemon logs show:
   ```
   {"level":"info","msg":"Job accepted","deliveryId":"abc123"}
   {"level":"info","msg":"Cloning repository","repo":"chrisleekr/some-repo"}
   {"level":"info","msg":"Starting Claude Agent SDK execution"}
   {"level":"info","msg":"Job completed","success":true,"costUsd":0.05,"durationMs":45000}
   ```

## Running Tests

```bash
# All tests
bun test

# Specific modules
bun test src/orchestrator/
bun test src/daemon/
bun test src/shared/

# With coverage
bun run test:coverage
```

## Architecture Overview

```mermaid
graph LR
    GH["GitHub Webhook"] -->|POST /api/github/webhooks| WH["Webhook Server<br/>:3000"]
    WH -->|"agentJobMode=inline"| IP["Inline Pipeline"]
    WH -->|"agentJobMode!=inline"| ORC["Orchestrator"]
    ORC -->|"Valkey LPUSH"| Q["Job Queue<br/>Valkey"]
    ORC -->|"WebSocket :3002"| D1["Daemon 1"]
    ORC -->|"WebSocket :3002"| D2["Daemon 2"]
    D1 -->|"job:result"| ORC
    ORC -->|"Postgres INSERT"| DB["Executions<br/>Postgres"]

    classDef serverNode fill:#2563eb,color:#ffffff
    classDef daemonNode fill:#16a34a,color:#ffffff
    classDef storageNode fill:#9333ea,color:#ffffff
    classDef externalNode fill:#dc2626,color:#ffffff

    GH:::externalNode
    WH:::serverNode
    IP:::serverNode
    ORC:::serverNode
    Q:::storageNode
    DB:::storageNode
    D1:::daemonNode
    D2:::daemonNode
```

## Day-2 Operations

### Monitor Daemon Health

```bash
# Check Valkey for active daemons
redis-cli -u redis://localhost:6379 KEYS "daemon:*"

# Check daemon TTL (should be <=90s, refreshed every 30s heartbeat)
redis-cli -u redis://localhost:6379 TTL "daemon:daemon-dev-mac-12345"
```

### Check Execution History

```bash
# Query Postgres for recent executions
psql postgresql://bot:bot@localhost:5432/github_app -c \
  "SELECT delivery_id, dispatch_mode, daemon_id, status, cost_usd, duration_ms
   FROM executions ORDER BY created_at DESC LIMIT 10;"
```

### Restart Daemon

Daemons auto-reconnect with exponential backoff (1s base, 30s cap, decorrelated jitter). Simply restart the daemon process:

```bash
# Kill and restart — it reconnects automatically
kill %1  # or Ctrl+C
bun run src/daemon/main.ts
```

### Test Auto-Update

Simulate version mismatch by changing the daemon's reported version:

```bash
# Terminal 1: Server is running (version 1.0.0 from package.json)

# Terminal 2: Start daemon with notify-only strategy (observe but don't restart)
DAEMON_AUTH_TOKEN=dev-secret-change-in-production \
ORCHESTRATOR_URL=ws://localhost:3002/ws \
DAEMON_UPDATE_STRATEGY=notify \
bun run src/daemon/main.ts
```

Expected log output when version mismatch is detected:
```
{"level":"warn","msg":"Update required by orchestrator","targetVersion":"1.0.0","currentVersion":"0.9.0","strategy":"notify"}
```

Test the `exit` strategy (daemon drains and exits with code 75):
```bash
# Use the restart wrapper script for automatic restart
DAEMON_AUTH_TOKEN=dev-secret-change-in-production \
ORCHESTRATOR_URL=ws://localhost:3002/ws \
DAEMON_UPDATE_STRATEGY=exit \
bash scripts/run-daemon.sh
```

### Fallback to Inline Mode

If daemon dispatch has issues, revert to inline mode with zero downtime:

```bash
# Set in .env or directly
AGENT_JOB_MODE=inline bun run dev
```

All in-flight daemon jobs will complete, but new requests route inline. No data loss.

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| Daemon can't connect | Wrong `ORCHESTRATOR_URL` or `DAEMON_AUTH_TOKEN` mismatch | Check env vars match between server and daemon |
| Daemon keeps reconnecting | Server not running, firewall blocking port 3002 | Start server first, check port accessibility |
| Jobs stay `queued` | No active daemons registered | Start a daemon, check Valkey for `daemon:*` keys |
| Jobs fail immediately | Daemon missing required tools (e.g., `git`, `bun`) | Check daemon logs for capability report |
| Valkey connection refused | Docker Compose not running | `bun run dev:deps` |
| "Non-inline mode requires DATABASE_URL" | Missing config for daemon mode | Set `DATABASE_URL` and `VALKEY_URL` in env |
| "incompatible protocol version" (close 4003) | Daemon protocol version doesn't match orchestrator | Update daemon to match orchestrator version |
| Daemon keeps restarting (exit 75) | Auto-update loop — new code not actually deployed | Check `DAEMON_UPDATE_STRATEGY`, use `notify` for debugging |
