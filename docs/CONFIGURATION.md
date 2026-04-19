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

| Variable                  | Default         | Notes                                                                                                                                                                             |
| ------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_JOB_MODE`          | `inline`        | Platform-wide mode: `inline`, `daemon`, `shared-runner`, `isolated-job`, or `auto`. Any value other than `inline` requires `VALKEY_URL`, `DATABASE_URL`, and `DAEMON_AUTH_TOKEN`. |
| `DEFAULT_DISPATCH_TARGET` | `shared-runner` | Fallback target when triage is sub-threshold or errors. Cannot be `inline` when mode is `auto`.                                                                                   |

## Isolated-job target (Kubernetes)

Applies when `AGENT_JOB_MODE=isolated-job`, `auto`, or when a label forces `isolated-job`.

| Variable                         | Default                       | Notes                                                                                                |
| -------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| `JOB_NAMESPACE`                  | `github-app`                  | Namespace for spawned Jobs. ServiceAccount needs `create/get/list/delete` on `jobs` and `pods` here. |
| `JOB_IMAGE`                      | `github-app-playground:local` | Container image for the Job pod.                                                                     |
| `JOB_TTL_SECONDS`                | `300`                         | `ttlSecondsAfterFinished`. Too low and `kubectl logs` fails before logs can be retrieved.            |
| `JOB_ACTIVE_DEADLINE_SECONDS`    | `1800` (schema max `3500`)    | Hard K8s-side wall-clock ceiling. Cap of `3500` leaves 100s under GitHub's 3600s token TTL.          |
| `JOB_WATCH_POLL_INTERVAL_MS`     | `5000`                        | How often the watcher polls Job status.                                                              |
| `MAX_CONCURRENT_ISOLATED_JOBS`   | `3`                           | In-flight capacity gate.                                                                             |
| `PENDING_ISOLATED_JOB_QUEUE_MAX` | `20`                          | Bounded overflow queue. When full, requests are rejected with `dispatch_reason=capacity-rejected`.   |
| `KUBECONFIG`                     | auto (in-cluster)             | Kubernetes client config path. The client auto-detects in-cluster via `KUBERNETES_SERVICE_HOST`.     |

## Shared-runner target

Applies when `AGENT_JOB_MODE=shared-runner`, `auto`, or when a label forces `shared-runner`.

| Variable                | Default | Notes                                                                                    |
| ----------------------- | ------- | ---------------------------------------------------------------------------------------- |
| `INTERNAL_RUNNER_URL`   | —       | Internal HTTP endpoint for the shared-runner pool.                                       |
| `INTERNAL_RUNNER_TOKEN` | —       | Sent on the `X-Internal-Token` header. Paired with the remote service's auth middleware. |

`SHARED_RUNNER_TOKEN` is accepted by the schema but not read by any code path — do not rely on it.

## Data layer

Required when `AGENT_JOB_MODE !== "inline"`.

| Variable       | Default | Notes                                                                                                                               |
| -------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `VALKEY_URL`   | —       | Backs the isolated-job pending queue, in-flight set, and daemon job queue.                                                          |
| `DATABASE_URL` | —       | Postgres connection for `executions`, `triage_results`, `dispatch_decisions`. Unset disables durable idempotency and observability. |

## Orchestrator and daemon

| Variable                       | Default  | Notes                                                                                                       |
| ------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------- |
| `WS_PORT`                      | `3002`   | Orchestrator WebSocket listener. Bound only in server mode. Must differ from `PORT`.                        |
| `ORCHESTRATOR_URL`             | —        | Presence flips the process from server mode to **daemon** mode. Must be `ws://` or `wss://`.                |
| `DAEMON_AUTH_TOKEN`            | —        | Shared secret for the daemon ⇄ orchestrator handshake. Required outside inline mode.                        |
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

`DAEMON_EPHEMERAL` and `JOB_MAX_COST_USD` are validated but not consumed by any code path today — setting them has no runtime effect.

## Triage (auto mode)

| Variable                      | Default     | Notes                                                                                                                                                |
| ----------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRIAGE_ENABLED`              | `true`      | Kill-switch. When `false`, every `auto`-mode ambiguous request falls back to `DEFAULT_DISPATCH_TARGET` with `dispatch_reason=triage-error-fallback`. |
| `TRIAGE_MODEL`                | `haiku-3-5` | Alias resolved at runtime. Affects triage cost and latency only.                                                                                     |
| `TRIAGE_CONFIDENCE_THRESHOLD` | `1.0`       | Below this, triage falls back to the default target. Day-1 default is strict.                                                                        |
| `TRIAGE_MAX_TOKENS`           | `256`       | Cap on the JSON response. Values above ~100 are wasted budget.                                                                                       |
| `TRIAGE_TIMEOUT_MS`           | `5000`      | Per-call wall clock. Beyond this, the circuit-breaker counter increments.                                                                            |
| `TRIAGE_MAXTURNS_TRIVIAL`     | `10`        | Applied on triage-success when complexity is `trivial`.                                                                                              |
| `TRIAGE_MAXTURNS_MODERATE`    | `30`        | Applied on triage-success when complexity is `moderate`.                                                                                             |
| `TRIAGE_MAXTURNS_COMPLEX`     | `50`        | Applied on triage-success when complexity is `complex`.                                                                                              |
| `DEFAULT_MAXTURNS`            | `30`        | Applied on every non-triage-success branch.                                                                                                          |

See [Triage](TRIAGE.md) for the full cascade and the six fallback reasons that appear in logs.

## Mode matrix — what's required when

| Mode                                              | Also required                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------ |
| `inline`                                          | Just the GitHub App credentials and one AI provider credential.          |
| `daemon`, `shared-runner`, `isolated-job`, `auto` | `VALKEY_URL`, `DATABASE_URL`, `DAEMON_AUTH_TOKEN`.                       |
| `shared-runner` or `auto`                         | `INTERNAL_RUNNER_URL`, `INTERNAL_RUNNER_TOKEN`.                          |
| `isolated-job` or `auto`                          | `JOB_IMAGE`, plus a ServiceAccount with Job/Pod RBAC in `JOB_NAMESPACE`. |
| `auto`                                            | `DEFAULT_DISPATCH_TARGET` cannot be `inline`.                            |
| Daemon process (`ORCHESTRATOR_URL` set)           | `DAEMON_AUTH_TOKEN`. GitHub App credentials are NOT required.            |

> **`auto` mode caveat.** The router may dispatch to **any** of the four targets, so configure credentials for every target the cascade can reach — not just the `DEFAULT_DISPATCH_TARGET`. Missing infrastructure is detected at dispatch time, not at startup, and surfaces as `dispatch_reason=infra-absent` in logs (the request then falls through to the configured default).
