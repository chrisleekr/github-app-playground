#!/usr/bin/env bash
# Daemon wrapper script (R-016).
# Restarts the daemon process in a loop:
#   - Exit code 75: restart immediately (after successful pull-and-restart update)
#   - Any other exit code: wait 5 seconds before restarting
#
# Usage:
#   DAEMON_AUTH_TOKEN=... ORCHESTRATOR_URL=... bash scripts/run-daemon.sh

set -euo pipefail

DAEMON_ENTRY="${DAEMON_ENTRY:-src/daemon/main.ts}"
ORCHESTRATOR_URL="${ORCHESTRATOR_URL:-ws://localhost:3002/ws}"
DAEMON_AUTH_TOKEN="${DAEMON_AUTH_TOKEN:-local-dev-token}"
export ORCHESTRATOR_URL DAEMON_AUTH_TOKEN

# Forward signals to the child process so daemon graceful shutdown fires
child=""
trap 'if [ -n "$child" ]; then kill -TERM "$child" 2>/dev/null; wait "$child"; fi; exit 0' SIGTERM SIGINT

while true; do
  echo "[run-daemon] Starting daemon: bun run ${DAEMON_ENTRY}"
  bun run "${DAEMON_ENTRY}" &
  child=$!
  wait "$child" || true
  EXIT_CODE=$?
  child=""

  if [ "${EXIT_CODE}" -eq 75 ]; then
    echo "[run-daemon] Daemon exited with code 75 (update), restarting immediately"
  else
    echo "[run-daemon] Daemon exited with code ${EXIT_CODE}, restarting in 5 seconds"
    sleep 5
  fi
done
