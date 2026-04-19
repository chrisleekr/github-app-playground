# Daemon Mode

A daemon is a standalone worker process that connects to the orchestrator over WebSocket, accepts one job offer at a time, and runs it through the inline pipeline. It's not a pool — each daemon is a single connection.

## When to use it

Daemon mode fits when you want horizontal scaling without the overhead of Kubernetes Jobs. Typical deployments run one orchestrator pod plus N daemon pods on the same cluster (or different clusters, if the WebSocket is reachable). The webhook server stays cheap — all CPU-heavy work lives on daemons.

Reach for [isolated-job](KUBERNETES.md) instead when you need per-request isolation (untrusted repos, DinD, enforced wall-clock ceilings).

## How it runs

Setting `ORCHESTRATOR_URL` to a `ws://` or `wss://` address flips the process into daemon mode. In that mode:

- GitHub App credentials are not required. The daemon does not bind a webhook listener.
- The daemon advertises capabilities (platform, free memory/disk relative to `DAEMON_MEMORY_FLOOR_MB` / `DAEMON_DISK_FLOOR_MB`) on every heartbeat.
- The orchestrator sends an offer when a job comes in. The daemon accepts or declines; accepted work runs through the same inline pipeline the server uses.
- On SIGTERM, the daemon refuses new offers and drains in-flight work up to `DAEMON_DRAIN_TIMEOUT_MS` before exiting.
- On spot/preemption signals (AWS Spot interruption, GCP preemption), the daemon begins draining early so the orchestrator can reroute pending offers.

## Operational knobs

| Variable                  | Default  | Notes                                                                            |
| ------------------------- | -------- | -------------------------------------------------------------------------------- |
| `ORCHESTRATOR_URL`        | —        | Required. `wss://` in production; `ws://` emits a warning.                       |
| `DAEMON_AUTH_TOKEN`       | —        | Shared secret with the orchestrator.                                             |
| `HEARTBEAT_INTERVAL_MS`   | `30000`  | Ping cadence.                                                                    |
| `HEARTBEAT_TIMEOUT_MS`    | `90000`  | Orchestrator eviction threshold. Keep `≥ 2 × HEARTBEAT_INTERVAL_MS`.             |
| `DAEMON_DRAIN_TIMEOUT_MS` | `300000` | Post-SIGTERM grace. Raise to `≥ AGENT_TIMEOUT_MS` to guarantee no mid-run kills. |
| `DAEMON_MEMORY_FLOOR_MB`  | `512`    | Below this, the orchestrator skips the daemon on dispatch.                       |
| `DAEMON_DISK_FLOOR_MB`    | `1024`   | Same, for free disk.                                                             |
| `OFFER_TIMEOUT_MS`        | `5000`   | How long the orchestrator waits for a claim before falling through.              |

See [Configuration](CONFIGURATION.md#orchestrator-and-daemon) for the rest.

## Concurrency

A single daemon process handles one job at a time. Scale horizontally by running multiple daemon pods — the orchestrator picks an eligible daemon per offer based on capabilities and floors.
