#!/usr/bin/env bash
# Send a simulated webhook event to the dev-only test endpoint.
# Exercises the full orchestrator → daemon pipeline without HMAC verification
# and without posting tracking comments to GitHub.
#
# Prerequisites:
#   1. bun run dev:deps   (Valkey + Postgres)
#   2. bun run dev        (webhook server + orchestrator)
#   3. bun run dev:daemon (daemon worker: not needed for inline mode or dry-run)
#
# Usage:
#   bash scripts/test-webhook.sh                          # dry-run (default, no Claude, no cost)
#   bash scripts/test-webhook.sh "summarise this repo"    # dry-run with custom trigger body
#
# Environment overrides:
#   SERVER_URL  : base URL of the webhook server (default: http://localhost:3000)
#   OWNER       : repo owner (default: chrisleekr)
#   REPO        : repo name  (default: github-app-playground)
#   ENTITY      : issue/PR number (default: 1)
#   IS_PR       : true/false (default: false)
#   DRY_RUN     : true/false (default: true). When true, pipeline returns synthetic
#                  result before executing Claude. Set to false for full live execution.
#
# ─── Example Scenarios ───────────────────────────────────────────────────────
#
# Tier 1: Dry-run (no Claude execution, no cost, milliseconds)
#
#   # 1. Basic dry-run: issue context
#   bash scripts/test-webhook.sh
#
#   # 2. Dry-run: PR context
#   IS_PR=true bash scripts/test-webhook.sh
#
#   # 3. Duplicate delivery ID rejection (run twice quickly)
#   bash scripts/test-webhook.sh && bash scripts/test-webhook.sh
#
#   # 4. Owner allowlist rejection
#   OWNER=evil-org bash scripts/test-webhook.sh
#
#   # 5. No daemon available (stop daemon first, use daemon mode)
#   DRY_RUN=false bash scripts/test-webhook.sh
#
#   # 6. Health endpoint checks
#   curl -s http://localhost:3000/healthz | jq .
#   curl -s http://localhost:3000/readyz  | jq .
#
# Tier 2: Live execution (real Claude, costs money, use test repo)
#
#   # 7. Issue: read-only task against test repo
#   DRY_RUN=false REPO=test-github-actions ENTITY=1 \
#     bash scripts/test-webhook.sh "@chrisleekr-bot what files are in this repo?"
#
#   # 8. PR: read-only task against test repo
#   DRY_RUN=false REPO=test-github-actions ENTITY=1 IS_PR=true \
#     bash scripts/test-webhook.sh "@chrisleekr-bot summarize this PR"
#
#   # 9. Failure: nonexistent repo
#   DRY_RUN=false REPO=nonexistent-repo-12345 \
#     bash scripts/test-webhook.sh "@chrisleekr-bot hello"
#
#   # 10. Failure: nonexistent entity
#   DRY_RUN=false REPO=test-github-actions ENTITY=999999 \
#     bash scripts/test-webhook.sh "@chrisleekr-bot hello"
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SERVER_URL="${SERVER_URL:-http://localhost:3000}"
OWNER="${OWNER:-chrisleekr}"
REPO="${REPO:-github-app-playground}"
ENTITY="${ENTITY:-1}"
IS_PR="${IS_PR:-false}"
DRY_RUN="${DRY_RUN:-true}"
TRIGGER_BODY="${1:-@chrisleekr-bot what files are in this repo?}"

echo "[test-webhook] Sending to ${SERVER_URL}/api/test/webhook"
echo "[test-webhook] ${OWNER}/${REPO}#${ENTITY} (isPR=${IS_PR}, dryRun=${DRY_RUN})"
echo "[test-webhook] Trigger: ${TRIGGER_BODY}"
echo ""

curl -s -X POST "${SERVER_URL}/api/test/webhook" \
  -H "Content-Type: application/json" \
  -d "$(cat <<EOF
{
  "owner": "${OWNER}",
  "repo": "${REPO}",
  "entityNumber": ${ENTITY},
  "isPR": ${IS_PR},
  "dryRun": ${DRY_RUN},
  "triggerBody": "${TRIGGER_BODY}"
}
EOF
)" | jq .

echo ""
if [ "${DRY_RUN}" = "true" ]; then
  echo "[test-webhook] Dry-run request sent. Pipeline will return synthetic result (no Claude execution)."
else
  echo "[test-webhook] Live request sent. Watch server and daemon logs for full pipeline flow."
fi
