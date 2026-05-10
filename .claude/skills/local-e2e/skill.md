---
name: local-e2e
description: Run a full local E2E test through the orchestrator-daemon pipeline. Starts
  infrastructure and services if needed, fires a webhook, tails logs until completion.
---

## User Input

```text
$ARGUMENTS
```

## Required Environment Variables

These must be set in `.env` or the shell environment before running:

- `LOCAL_E2E_TEST_REPO`: `owner/repo` to test against (e.g. `myorg/my-test-repo`)
- `LOCAL_E2E_TEST_ENTITY`: issue or PR number to target

The skill MUST fail with a clear error message if either is unset.

## Arguments

- `$ARGUMENTS` text becomes the trigger body (default: `@chrisleekr-bot run docker compose to execute the test suite in this repo. After running, save any gotchas or environment notes you discovered using save_repo_memory.`)
- If `$ARGUMENTS` contains `--pr`, set `IS_PR=true` and strip the flag from the trigger body
- If `$ARGUMENTS` contains `--dry-run`, set `DRY_RUN=true` and strip the flag from the trigger body
- Default mode is live execution (`DRY_RUN=false`)

## Execution Steps

### Step 1: Validate environment

1. Read `LOCAL_E2E_TEST_REPO` and `LOCAL_E2E_TEST_ENTITY` from the environment (check `.env` file if not in shell env).
2. If either is missing, stop immediately and tell the user:
   ```
   Missing required env vars for /local-e2e:
     LOCAL_E2E_TEST_REPO: set to owner/repo (e.g. myorg/my-test-repo)
     LOCAL_E2E_TEST_ENTITY: set to issue or PR number
   Add them to .env or export in your shell.
   ```

3. Split `LOCAL_E2E_TEST_REPO` into `OWNER` and `REPO` on the `/` delimiter.

### Step 2: Start infrastructure if needed

1. Check if Docker containers for this project's Valkey and Postgres are running (`docker ps`).
2. If not running, execute `bun run dev:deps` and wait for containers to be healthy.

### Step 3: Start services if needed

1. Check if the server is listening: `curl -s http://localhost:3000/healthz`
2. If not, start `bun run dev` in background. Wait for `/healthz` to return `ok`.
3. Check daemon logs or server logs for daemon registration.
4. If no daemon is connected, start `bun run dev:daemon` in background. Wait for `Registered with orchestrator` in daemon output.

### Step 4: Fire the test

Run the test using the existing script:

```bash
DRY_RUN=${DRY_RUN:-false} \
OWNER="${OWNER}" \
REPO="${REPO}" \
ENTITY="${LOCAL_E2E_TEST_ENTITY}" \
IS_PR="${IS_PR:-false}" \
bash scripts/test-webhook.sh "${TRIGGER_BODY}"
```

### Step 5: Monitor execution

1. Tail the daemon log output, watching for either:
   - `Claude Agent SDK execution completed`: success
   - `error` / `failed` / process exit: failure
2. Check every 15 seconds, with a maximum wait of 5 minutes.

### Step 6: Report result

Print a summary:

- **Status**: success or failure
- **Duration**: from daemon logs (`durationMs`)
- **Cost**: from daemon logs (`costUsd`)
- **Turns**: from daemon logs (`numTurns`)
- **Target**: `OWNER/REPO#ENTITY`
- **Mode**: live or dry-run
- If live and successful, suggest checking the GitHub issue/PR for the posted comment.

### Step 7: Verify memory persistence

1. Query `repo_memory` table: `psql $DATABASE_URL -c "SELECT id, repo_owner, repo_name, category, content, pinned FROM repo_memory ORDER BY updated_at DESC LIMIT 10;"`
2. Report whether new entries were created during this execution.
3. If empty, flag as **memory not working**: the daemon either didn't pass `REPO_MEMORY` env to the MCP server, the MCP server didn't write `.daemon-actions.json`, or the orchestrator didn't persist the actions.
