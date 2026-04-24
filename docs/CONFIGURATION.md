# Configuration

Every environment variable the app reads at startup, grouped by concern. The authoritative source is `src/config.ts` — all values are validated via Zod at boot and the process exits if a required variable is missing or malformed.

Columns: **Default** lists the fallback applied when the variable is unset (blank means "no default, must be set when required"). **Required when** describes the runtime condition under which the variable is mandatory.

## GitHub App credentials

Server mode only. If `ORCHESTRATOR_URL` is set, the process runs in daemon mode and these are not required.

| Variable                 | Default | Required when | Notes                                                              |
| ------------------------ | ------- | ------------- | ------------------------------------------------------------------ |
| `GITHUB_APP_ID`          | —       | Server mode   | Numeric App ID from the GitHub App settings page.                  |
| `GITHUB_APP_PRIVATE_KEY` | —       | Server mode   | Full PEM, base64-encoded or raw. Used to mint installation tokens. |
| `GITHUB_WEBHOOK_SECRET`  | —       | Server mode   | HMAC-SHA256 secret configured in the GitHub App settings.          |

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
| `AWS_SESSION_TOKEN`          | —                                          | Optional (bedrock)                                 | For temporary credentials.                                                |
| `AWS_BEARER_TOKEN_BEDROCK`   | —                                          | Optional (bedrock, CI)                             | Set automatically by `aws-actions/configure-aws-credentials` OIDC.        |
| `ANTHROPIC_BEDROCK_BASE_URL` | —                                          | Optional (bedrock)                                 | Override the Bedrock runtime endpoint (VPC endpoint / proxy).             |
| `ALLOWED_OWNERS`             | unset                                      | OAuth token path                                   | Comma-separated allowlist. Required when using `CLAUDE_CODE_OAUTH_TOKEN`. |

## Runtime

| Variable                  | Default                      | Notes                                                                                                   |
| ------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| `PORT`                    | `3000`                       | HTTP webhook listener.                                                                                  |
| `LOG_LEVEL`               | `info`                       | Pino level: `fatal`, `error`, `warn`, `info`, `debug`, `trace`. `debug` surfaces full webhook payloads. |
| `NODE_ENV`                | `production`                 | `production`, `development`, or `test`.                                                                 |
| `TRIGGER_PHRASE`          | `@chrisleekr-bot`            | Mention text that triggers the bot. Must match the App's bot login.                                     |
| `MAX_CONCURRENT_REQUESTS` | `3`                          | Ceiling on simultaneous Claude executions per process.                                                  |
| `AGENT_TIMEOUT_MS`        | `600000`                     | Wall-clock budget for one agent execution.                                                              |
| `AGENT_MAX_TURNS`         | unset                        | Fallback turn cap — see [Triage](TRIAGE.md) for how it interacts with the router.                       |
| `CLAUDE_CODE_PATH`        | resolved from `node_modules` | Absolute path to the Claude Code CLI `cli.js`. Set when globally installed.                             |
| `CLONE_BASE_DIR`          | `/tmp/bot-workspaces`        | Parent directory for per-delivery clones.                                                               |
| `CLONE_DEPTH`             | `50`                         | Shallow-clone depth. Increase for deeply-diverged PRs.                                                  |
| `CONTEXT7_API_KEY`        | unset                        | Lifts Context7 MCP rate limiting. No other effect.                                                      |

## Dispatch

Dispatch collapsed to a single target (`daemon`). The router decides only **which reason** a job lands there and whether to spawn an ephemeral daemon — see [Architecture → Dispatch Flow](ARCHITECTURE.md#dispatch-flow).

## Ephemeral daemons (Kubernetes scale-up)

Used when the orchestrator needs to add daemon capacity on demand. Spawned Pods run the same daemon image with `DAEMON_EPHEMERAL=true` and exit after idle.

| Variable                                 | Default           | Notes                                                                                                                                |
| ---------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `DAEMON_EPHEMERAL`                       | `false`           | Set to `true` on ephemeral daemon Pods (injected by the spawner). Controls idle-exit behaviour on the daemon.                        |
| `EPHEMERAL_DAEMON_IDLE_TIMEOUT_MS`       | `120000`          | Ephemeral daemon exits after this much idle time (no active job).                                                                    |
| `EPHEMERAL_DAEMON_SPAWN_COOLDOWN_MS`     | `30000`           | Minimum time between ephemeral spawns (orchestrator side). During cooldown, heavy/overflow signals fall back to `persistent-daemon`. |
| `EPHEMERAL_DAEMON_SPAWN_QUEUE_THRESHOLD` | `3`               | Queue length that triggers an `ephemeral-daemon-overflow` spawn.                                                                     |
| `EPHEMERAL_DAEMON_NAMESPACE`             | `default`         | Kubernetes namespace for spawned ephemeral Pods. The orchestrator ServiceAccount needs `create/get/delete` on `pods` here.           |
| `KUBECONFIG`                             | auto (in-cluster) | Kubernetes client config path. The client auto-detects in-cluster via `KUBERNETES_SERVICE_HOST`.                                     |

The orchestrator also expects a pre-existing `daemon-secrets` K8s Secret in `EPHEMERAL_DAEMON_NAMESPACE`, mounted into the spawned Pod via `envFrom: secretRef: daemon-secrets`. See [DAEMON.md](DAEMON.md) and [DEPLOYMENT.md](DEPLOYMENT.md) for the full Pod spec and RBAC.

## Data layer

Required whenever the orchestrator role is active (i.e. the webhook server process, which always runs the orchestrator).

| Variable       | Default | Notes                                                                                                                                                                                                                |
| -------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VALKEY_URL`   | —       | Backs the daemon job queue, in-flight set, and the ephemeral-spawn cooldown.                                                                                                                                         |
| `DATABASE_URL` | —       | Postgres connection for `executions` and `triage_results`. Unset disables durable observability and telemetry aggregates. Durable idempotency itself comes from GitHub tracking comments and works without Postgres. |

## Orchestrator and daemon

| Variable                       | Default  | Notes                                                                                                       |
| ------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------- |
| `WS_PORT`                      | `3002`   | Orchestrator WebSocket listener. Bound only in server mode. Must differ from `PORT`.                        |
| `ORCHESTRATOR_URL`             | —        | Presence flips the process from server mode to **daemon** mode. Must be `ws://` or `wss://`.                |
| `DAEMON_AUTH_TOKEN`            | —        | Shared secret for the daemon ⇄ orchestrator handshake. Required on both orchestrator and daemon processes.  |
| `HEARTBEAT_INTERVAL_MS`        | `30000`  | Daemon → orchestrator ping cadence.                                                                         |
| `HEARTBEAT_TIMEOUT_MS`         | `90000`  | Eviction threshold. Keep `≥ 2 × HEARTBEAT_INTERVAL_MS` to tolerate a dropped packet.                        |
| `STALE_EXECUTION_THRESHOLD_MS` | `600000` | How long a `running` execution may sit before the watcher marks it failed. Set `≥ AGENT_TIMEOUT_MS`.        |
| `DAEMON_DRAIN_TIMEOUT_MS`      | `300000` | Post-SIGTERM window to finish in-flight work. Raise to `≥ AGENT_TIMEOUT_MS` if you want zero mid-run kills. |
| `JOB_MAX_RETRIES`              | `3`      | Retries for transient daemon dispatch failures only. Isolated-job ignores this.                             |
| `OFFER_TIMEOUT_MS`             | `5000`   | How long the orchestrator waits for a daemon to claim an offer before falling through.                      |
| `DAEMON_UPDATE_STRATEGY`       | `exit`   | `exit`, `pull`, or `notify`. Advisory hint reported in the update response.                                 |
| `DAEMON_UPDATE_DELAY_MS`       | `0`      | Delay before graceful shutdown after an update signal.                                                      |
| `DAEMON_MEMORY_FLOOR_MB`       | `512`    | Minimum free memory the orchestrator requires before dispatching.                                           |
| `DAEMON_DISK_FLOOR_MB`         | `1024`   | Minimum free disk the orchestrator requires before dispatching.                                             |

## Triage

| Variable                      | Default     | Notes                                                                                                                                                                                                                      |
| ----------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRIAGE_ENABLED`              | `true`      | Kill-switch. When `false`, triage returns `heavy=false` and the job routes to `persistent-daemon`.                                                                                                                         |
| `TRIAGE_MODEL`                | `haiku-3-5` | Alias resolved at runtime. Affects triage cost and latency only.                                                                                                                                                           |
| `TRIAGE_CONFIDENCE_THRESHOLD` | `1.0`       | Below this, triage is treated as sub-threshold and the job routes to `persistent-daemon`.                                                                                                                                  |
| `TRIAGE_MAX_TOKENS`           | `256`       | Cap on the JSON response. Values above ~100 are wasted budget.                                                                                                                                                             |
| `TRIAGE_TIMEOUT_MS`           | `5000`      | Per-call wall clock. Beyond this, the circuit-breaker counter increments.                                                                                                                                                  |
| `DEFAULT_MAXTURNS`            | `30`        | Agent turn cap. Applied on every execution — triage no longer influences `maxTurns`.                                                                                                                                       |
| `INTENT_CONFIDENCE_THRESHOLD` | `0.75`      | Range `[0, 1]`. Below this, a `@chrisleekr-bot` comment is treated as ambiguous and the dispatcher posts a clarification request instead of dispatching a workflow. See [bot workflows](BOT-WORKFLOWS.md#comment-trigger). |

See [Triage](TRIAGE.md) for the binary `heavy` signal, circuit breaker, and the six fallback reasons that appear in logs.

## Mode matrix — what's required when

| Role                                    | Required                                                                                                                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orchestrator (webhook server)           | GitHub App credentials, one AI provider credential, `VALKEY_URL`, `DATABASE_URL`, `DAEMON_AUTH_TOKEN`.                                                                           |
| Ephemeral-daemon scale-up               | K8s API access + RBAC on `pods` in `EPHEMERAL_DAEMON_NAMESPACE`, `daemon-secrets` Secret.                                                                                        |
| Daemon process (`ORCHESTRATOR_URL` set) | `DAEMON_AUTH_TOKEN` and one AI provider credential (`ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` / Bedrock env). GitHub App credentials and data-layer URLs are NOT required. |
