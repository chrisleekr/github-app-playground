# Configuration reference

Every environment variable the app reads at startup, grouped by concern. The authoritative source is `src/config.ts` — values are validated via Zod at boot and the process exits if a required variable is missing or malformed.

**Default** is the fallback when the variable is unset (blank means "no default — must be set when required"). **Required when** is the runtime condition under which the variable is mandatory.

## GitHub App credentials

Server mode only. If `ORCHESTRATOR_URL` is set, the process runs in daemon mode and these are not required.

| Variable                 | Default | Required when | Notes                                                             |
| ------------------------ | ------- | ------------- | ----------------------------------------------------------------- |
| `GITHUB_APP_ID`          | —       | Server mode   | Numeric App ID from the App settings page.                        |
| `GITHUB_APP_PRIVATE_KEY` | —       | Server mode   | Full PEM. Literal `\n` sequences are normalised to real newlines. |
| `GITHUB_WEBHOOK_SECRET`  | —       | Server mode   | HMAC-SHA256 secret configured in the App settings.                |

## AI provider

| Variable                     | Default                                    | Required when                                      | Notes                                                                     |
| ---------------------------- | ------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------- |
| `CLAUDE_PROVIDER`            | `anthropic`                                | —                                                  | `anthropic` or `bedrock`.                                                 |
| `CLAUDE_MODEL`               | `claude-opus-4-7` (anthropic); — (bedrock) | Bedrock                                            | Bedrock requires an explicit Bedrock model ID.                            |
| `ANTHROPIC_API_KEY`          | —                                          | Anthropic, unless `CLAUDE_CODE_OAUTH_TOKEN` is set | Console pay-as-you-go. Safe for multi-tenant deploys.                     |
| `CLAUDE_CODE_OAUTH_TOKEN`    | —                                          | Anthropic, unless `ANTHROPIC_API_KEY` is set       | Max/Pro subscription token (`sk-ant-oat…`). Requires `ALLOWED_OWNERS`.    |
| `AWS_REGION`                 | —                                          | Bedrock                                            | Resolved by the AWS SDK credential chain.                                 |
| `AWS_PROFILE`                | —                                          | Optional (bedrock)                                 | Local SSO profile for dev.                                                |
| `AWS_ACCESS_KEY_ID`          | —                                          | Optional (bedrock)                                 | Long-lived credential pair. Prefer profile or OIDC.                       |
| `AWS_SECRET_ACCESS_KEY`      | —                                          | Optional (bedrock)                                 | Paired with `AWS_ACCESS_KEY_ID`.                                          |
| `AWS_SESSION_TOKEN`          | —                                          | Optional (bedrock)                                 | Temporary credentials.                                                    |
| `AWS_BEARER_TOKEN_BEDROCK`   | —                                          | Optional (bedrock, CI)                             | Set automatically by `aws-actions/configure-aws-credentials` OIDC.        |
| `ANTHROPIC_BEDROCK_BASE_URL` | —                                          | Optional (bedrock)                                 | Override Bedrock runtime endpoint (VPC endpoint / proxy).                 |
| `ALLOWED_OWNERS`             | —                                          | OAuth token path                                   | Comma-separated allowlist. Required when using `CLAUDE_CODE_OAUTH_TOKEN`. |

## HTTP server

| Variable                      | Default                      | Notes                                                                                                                                                                                                                |
| ----------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                        | `3000`                       | HTTP webhook listener.                                                                                                                                                                                               |
| `LOG_LEVEL`                   | `info`                       | Pino level: `fatal`, `error`, `warn`, `info`, `debug`, `trace`. `debug` surfaces full webhook payloads.                                                                                                              |
| `NODE_ENV`                    | `production`                 | `production`, `development`, `test`.                                                                                                                                                                                 |
| `TRIGGER_PHRASE`              | `@chrisleekr-bot`            | Mention text that triggers the bot. Local dev typically sets `@chrisleekr-bot-dev`.                                                                                                                                  |
| `BOT_APP_LOGIN`               | `chrisleekr-bot[bot]`        | Bot's GitHub login. Used by the loop-prevention check.                                                                                                                                                               |
| `MAX_CONCURRENT_REQUESTS`     | `3`                          | Ceiling on simultaneous Claude executions across the fleet.                                                                                                                                                          |
| `MAX_FETCHED_COMMENTS`        | `500`                        | Per-PR/issue cap on comments merged from the GraphQL fetcher (`src/core/fetcher.ts`). When the cap fires the fetcher emits `log.warn({ connection: "comments", … })` and sets `FetchedData.truncated.comments=true`. |
| `MAX_FETCHED_REVIEWS`         | `500`                        | Per-PR cap on reviews merged from the fetcher. Sets `FetchedData.truncated.reviews=true` on cap fire.                                                                                                                |
| `MAX_FETCHED_REVIEW_COMMENTS` | `500`                        | Per-PR cap on inline review comments merged across all reviews (top-level + nested follow-up paginate). Sets `truncated.reviewComments=true`.                                                                        |
| `MAX_FETCHED_FILES`           | `500`                        | Per-PR cap on changed files merged from the fetcher. Sets `truncated.changedFiles=true` on cap fire.                                                                                                                 |
| `AGENT_TIMEOUT_MS`            | `3600000`                    | Wall-clock budget for one agent execution (60 min). Lower only when the job is bounded.                                                                                                                              |
| `AGENT_MAX_TURNS`             | unset                        | Optional Claude SDK turn cap. Unset = no cap. Overrides `DEFAULT_MAXTURNS`.                                                                                                                                          |
| `DEFAULT_MAXTURNS`            | unset                        | Process-wide turn cap. Set only if ops needs a hard ceiling.                                                                                                                                                         |
| `CLAUDE_CODE_PATH`            | resolved from `node_modules` | Absolute path to the Claude Code CLI `cli.js`.                                                                                                                                                                       |
| `CLONE_BASE_DIR`              | `/tmp/bot-workspaces`        | Parent directory for per-delivery clones.                                                                                                                                                                            |
| `CLONE_DEPTH`                 | `50`                         | Shallow-clone depth. Increase for deeply-diverged PRs.                                                                                                                                                               |
| `CONTEXT7_API_KEY`            | unset                        | Lifts Context7 MCP rate limiting. No other effect.                                                                                                                                                                   |

## Postgres

Required whenever the orchestrator role is active.

| Variable       | Default | Notes                                                                                                                                                                               |
| -------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL` | —       | Postgres connection. Backs `executions`, `triage_results`, `workflow_runs`, `ship_intents`, `ship_iterations`, `ship_continuations`, `ship_fix_attempts`, `repo_memory`, `daemons`. |

## Valkey

Required whenever the orchestrator role is active.

| Variable     | Default | Notes                                                                                                                         |
| ------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `VALKEY_URL` | —       | Backs the daemon job queue, in-flight set, the ephemeral-spawn cooldown, the `ship:tickle` sorted set, and ship cancel flags. |

## Orchestrator and daemon

| Variable                       | Default               | Notes                                                                                                                                                                                                              |
| ------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WS_PORT`                      | `3002`                | Orchestrator WebSocket listener. Must differ from `PORT`.                                                                                                                                                          |
| `ORCHESTRATOR_URL`             | —                     | Presence flips the process to daemon mode. Use `wss://` in production; `ws://` emits a warning.                                                                                                                    |
| `ORCHESTRATOR_PUBLIC_URL`      | —                     | Public WebSocket URL the spawner injects into ephemeral Pods.                                                                                                                                                      |
| `DAEMON_AUTH_TOKEN`            | —                     | Shared secret for the daemon ⇄ orchestrator handshake. Required on both sides. Compared in constant time.                                                                                                          |
| `DAEMON_AUTH_TOKEN_PREVIOUS`   | —                     | Optional rotation overlap. Orchestrator accepts either the primary or this previous token; daemons always send the primary. See [`runbooks/daemon-fleet.md`](runbooks/daemon-fleet.md#rotating-daemon_auth_token). |
| `HEARTBEAT_INTERVAL_MS`        | `30000`               | Daemon → orchestrator ping cadence.                                                                                                                                                                                |
| `HEARTBEAT_TIMEOUT_MS`         | `90000`               | Eviction threshold. Keep `≥ 2 × HEARTBEAT_INTERVAL_MS`.                                                                                                                                                            |
| `STALE_EXECUTION_THRESHOLD_MS` | `3600000`             | How long a `running` execution may sit before the watcher fails it. Set `≥ AGENT_TIMEOUT_MS`.                                                                                                                      |
| `DAEMON_DRAIN_TIMEOUT_MS`      | `300000`              | Post-`SIGTERM` window to finish in-flight work. Raise to `≥ AGENT_TIMEOUT_MS` for zero mid-run kills.                                                                                                              |
| `JOB_MAX_RETRIES`              | `3`                   | Retries for transient daemon dispatch failures.                                                                                                                                                                    |
| `OFFER_TIMEOUT_MS`             | `5000`                | How long the orchestrator waits for a daemon to claim an offer.                                                                                                                                                    |
| `QUEUE_WORKER_BACKOFF_MAX_MS`  | `5000`                | Upper bound on the queue-worker's sleep when no local daemon can take a job.                                                                                                                                       |
| `LIVENESS_REAPER_INTERVAL_MS`  | `30000` (min `20000`) | Cadence of the heartbeat-based reaper.                                                                                                                                                                             |
| `DAEMON_UPDATE_STRATEGY`       | `exit`                | `exit`, `pull`, or `notify`. Advisory hint reported in the update response.                                                                                                                                        |
| `DAEMON_UPDATE_DELAY_MS`       | `0`                   | Delay before graceful shutdown after an update signal.                                                                                                                                                             |
| `DAEMON_MEMORY_FLOOR_MB`       | `512`                 | Minimum free memory the orchestrator requires before dispatching.                                                                                                                                                  |
| `DAEMON_DISK_FLOOR_MB`         | `1024`                | Minimum free disk the orchestrator requires before dispatching.                                                                                                                                                    |

## Ephemeral daemons

Used when the orchestrator scales daemon capacity on demand.

| Variable                                 | Default           | Notes                                                                                            |
| ---------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------ |
| `DAEMON_EPHEMERAL`                       | `false`           | Set to `true` on ephemeral daemon Pods (injected by the spawner). Controls idle-exit.            |
| `EPHEMERAL_DAEMON_IDLE_TIMEOUT_MS`       | `120000`          | Ephemeral daemon exits after this idle window.                                                   |
| `EPHEMERAL_DAEMON_SPAWN_COOLDOWN_MS`     | `30000`           | Minimum time between ephemeral spawns (orchestrator side).                                       |
| `EPHEMERAL_DAEMON_SPAWN_QUEUE_THRESHOLD` | `3`               | Queue length that triggers an `ephemeral-daemon-overflow` spawn.                                 |
| `EPHEMERAL_DAEMON_NAMESPACE`             | `default`         | Kubernetes namespace for spawned ephemeral Pods.                                                 |
| `DAEMON_IMAGE`                           | auto-detected     | K8s image URI override.                                                                          |
| `KUBECONFIG`                             | auto (in-cluster) | Kubernetes client config path. The client auto-detects in-cluster via `KUBERNETES_SERVICE_HOST`. |

The orchestrator also expects a pre-existing `daemon-secrets` Kubernetes Secret in `EPHEMERAL_DAEMON_NAMESPACE`, mounted into the spawned Pod via `envFrom: secretRef: daemon-secrets`. See [`deployment.md`](deployment.md#ephemeral-daemon-kubernetes-requirements).

## Triage

| Variable                      | Default     | Notes                                                                                                  |
| ----------------------------- | ----------- | ------------------------------------------------------------------------------------------------------ |
| `TRIAGE_ENABLED`              | `true`      | Kill-switch. When `false`, triage returns `heavy=false` and the job routes to `persistent-daemon`.     |
| `TRIAGE_MODEL`                | `haiku-3-5` | Alias resolved at runtime.                                                                             |
| `TRIAGE_CONFIDENCE_THRESHOLD` | `1.0`       | Below this, triage is treated as sub-threshold and the job routes to `persistent-daemon`.              |
| `TRIAGE_MAX_TOKENS`           | `256`       | Cap on the JSON response. Above ~100 is wasted budget.                                                 |
| `TRIAGE_TIMEOUT_MS`           | `5000`      | Per-call wall clock. Beyond this, the circuit-breaker counter increments.                              |
| `INTENT_CONFIDENCE_THRESHOLD` | `0.75`      | Range `[0, 1]`. Below this, a mention-driven comment gets a clarification reply instead of a dispatch. |

## Ship

| Variable                          | Default            | Notes                                                                                                                                           |
| --------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAX_WALL_CLOCK_PER_SHIP_RUN`     | `4h`               | Hard ceiling on a single intent's wall-clock budget. Accepts ms or `Nh` / `Nm` / `Ns`. Per-invocation `--deadline` is clamped to this.          |
| `MAX_SHIP_ITERATIONS`             | `50`               | Iteration cap. Firing transitions the intent to terminal `human_took_over` with `terminal_blocker_category='iteration-cap'`.                    |
| `CRON_TICKLE_INTERVAL_MS`         | `30000`            | How often the cron tickle scans `ship:tickle` for due intents.                                                                                  |
| `MERGEABLE_NULL_BACKOFF_MS_LIST`  | `500,1500,4500`    | Comma-separated bounded backoff schedule used by the probe when `mergeable=null`. Exhaustion yields `mergeable_pending` and the session yields. |
| `REVIEW_BARRIER_SAFETY_MARGIN_MS` | `1200000` (20 min) | Minimum elapsed time since the last bot push before the bot may declare `ready` without a non-bot review on the current head SHA.               |
| `FIX_ATTEMPTS_PER_SIGNATURE_CAP`  | `3`                | Max attempts per failure signature within a single intent. Cap firing terminates with `terminal_blocker_category='flake-cap'`.                  |
| `SHIP_FORBIDDEN_TARGET_BRANCHES`  | empty              | Comma-separated branches the bot refuses to shepherd PRs against.                                                                               |

## Mode matrix — what's required when

| Role                                    | Required                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Orchestrator (webhook server)           | GitHub App credentials, one AI provider credential, `VALKEY_URL`, `DATABASE_URL`, `DAEMON_AUTH_TOKEN`.        |
| Ephemeral-daemon scale-up               | K8s API access + RBAC on `pods` in `EPHEMERAL_DAEMON_NAMESPACE`, `daemon-secrets` Secret.                     |
| Daemon process (`ORCHESTRATOR_URL` set) | `DAEMON_AUTH_TOKEN`, one AI provider credential. GitHub App credentials and data-layer URLs are NOT required. |
