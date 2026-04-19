# Daemon

A daemon is a standalone worker process that connects to the orchestrator over WebSocket, accepts job offers, and runs each job through `src/core/pipeline.ts`. The webhook server never runs the pipeline in-process — every execution happens on a daemon.

## Persistent vs Ephemeral

There are two daemon types. Always qualify which one you mean — plain "daemon" is ambiguous. The union of both types connected at a given moment is the **daemon fleet**.

| Type                  | How it starts                                                        | Lifetime                                                                        | `DAEMON_EPHEMERAL` |
| --------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------ |
| **Persistent daemon** | Deployed out-of-band (Helm, kubectl, `docker run`, systemd, etc.)    | Long-lived — stays connected until SIGTERM or eviction.                         | unset or `false`   |
| **Ephemeral daemon**  | Spawned on demand by the orchestrator as a bare Pod via the K8s API. | Exits after `EPHEMERAL_DAEMON_IDLE_TIMEOUT_MS` (default 120s) of no active job. | `true`             |

Only persistent daemons count towards the "persistent pool free slots" the orchestrator uses to decide whether an overflow spawn is warranted. Ephemeral daemons exist specifically to drain the current surge and then disappear.

## When to use it

- Persistent daemons handle the default, hot path. Run one (or more) in your cluster as a baseline so the common case does not pay a Pod-spawn latency.
- Ephemeral daemons kick in when triage flags a job as heavy, or when the job queue piles up — see `ephemeral-daemon-triage` and `ephemeral-daemon-overflow` in [Observability](OBSERVABILITY.md). They let you scale to zero on idle without losing bursty capacity.

## How it runs

Setting `ORCHESTRATOR_URL` to a `ws://` or `wss://` address flips the process into daemon mode. In that mode:

- GitHub App credentials are not required. The daemon does not bind a webhook listener.
- The daemon advertises capabilities (platform, free memory/disk relative to `DAEMON_MEMORY_FLOOR_MB` / `DAEMON_DISK_FLOOR_MB`) on every heartbeat. It also advertises `isEphemeral` and `maxConcurrentJobs` on `daemon:register` so the orchestrator can compute persistent-pool free slots correctly.
- The orchestrator sends an offer when a job comes in. The daemon accepts or declines; accepted work runs through the shared pipeline (`src/core/pipeline.ts`).
- On SIGTERM, the daemon refuses new offers and drains in-flight work up to `DAEMON_DRAIN_TIMEOUT_MS` before exiting.
- On spot/preemption signals (AWS Spot interruption, GCP preemption), the daemon begins draining early so the orchestrator can reroute pending offers.
- When `DAEMON_EPHEMERAL=true`, the daemon additionally exits after `EPHEMERAL_DAEMON_IDLE_TIMEOUT_MS` with no active job — persistent daemons never idle-exit.

## Operational knobs

| Variable                           | Default  | Notes                                                                            |
| ---------------------------------- | -------- | -------------------------------------------------------------------------------- |
| `ORCHESTRATOR_URL`                 | —        | Required. `wss://` in production; `ws://` emits a warning.                       |
| `DAEMON_AUTH_TOKEN`                | —        | Shared secret with the orchestrator.                                             |
| `DAEMON_EPHEMERAL`                 | `false`  | `true` on ephemeral daemon Pods (injected by the spawner). Enables idle-exit.    |
| `EPHEMERAL_DAEMON_IDLE_TIMEOUT_MS` | `120000` | Ephemeral daemons exit after this idle window.                                   |
| `HEARTBEAT_INTERVAL_MS`            | `30000`  | Ping cadence.                                                                    |
| `HEARTBEAT_TIMEOUT_MS`             | `90000`  | Orchestrator eviction threshold. Keep `≥ 2 × HEARTBEAT_INTERVAL_MS`.             |
| `DAEMON_DRAIN_TIMEOUT_MS`          | `300000` | Post-SIGTERM grace. Raise to `≥ AGENT_TIMEOUT_MS` to guarantee no mid-run kills. |
| `DAEMON_MEMORY_FLOOR_MB`           | `512`    | Below this, the orchestrator skips the daemon on dispatch.                       |
| `DAEMON_DISK_FLOOR_MB`             | `1024`   | Same, for free disk.                                                             |
| `OFFER_TIMEOUT_MS`                 | `5000`   | How long the orchestrator waits for a claim before falling through.              |

See [Configuration](CONFIGURATION.md#orchestrator-and-daemon) for the rest.

## Concurrency

A daemon process handles up to `maxConcurrentJobs` jobs at a time (advertised on register). Scale horizontally by running multiple persistent daemon pods, and let the orchestrator add ephemeral daemons for bursts.

---

## Kubernetes deployment

### Persistent daemon Deployment (example)

Run persistent daemons as a regular Deployment, scaled to N replicas. They connect outbound to the orchestrator and need no inbound ports.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: github-app-playground-daemon
  namespace: default
spec:
  replicas: 2
  selector:
    matchLabels:
      app: github-app-playground-daemon
  template:
    metadata:
      labels:
        app: github-app-playground-daemon
    spec:
      terminationGracePeriodSeconds: 300
      containers:
        - name: daemon
          image: chrisleekr/github-app-playground:latest-daemon
          envFrom:
            - secretRef:
                name: daemon-secrets
          env:
            - name: ORCHESTRATOR_URL
              value: "wss://orchestrator.example.internal:3002"
            - name: CLONE_BASE_DIR
              value: "/workspaces"
          volumeMounts:
            - name: bot-workspaces
              mountPath: /workspaces
      volumes:
        - name: bot-workspaces
          emptyDir:
            sizeLimit: 5Gi
```

`terminationGracePeriodSeconds` should match or exceed `DAEMON_DRAIN_TIMEOUT_MS` so SIGTERM has time to drain in-flight work before SIGKILL.

### Ephemeral daemon RBAC (orchestrator side)

The orchestrator's ServiceAccount needs permission to spawn bare Pods in `EPHEMERAL_DAEMON_NAMESPACE`:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: github-app-playground-ephemeral-spawner
  namespace: default
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["create", "get", "delete"]
```

Bind it to the orchestrator pod's ServiceAccount via a `RoleBinding`. Without these verbs, every scale-up attempt yields `dispatch_reason=ephemeral-spawn-failed` and the affected job is rejected with a tracking-comment infra error.

### `daemon-secrets` Secret

Spawned ephemeral Pods get their configuration via `envFrom: secretRef: daemon-secrets`. Create this Secret once in `EPHEMERAL_DAEMON_NAMESPACE` with at minimum:

- `DAEMON_AUTH_TOKEN` — daemon ⇄ orchestrator WebSocket handshake. **Only source**: the Secret. The spawner does not inline this into the Pod spec so it cannot leak via `kubectl get pod -o yaml` or the Pod audit log.
- `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` (and `ALLOWED_OWNERS`) or Bedrock `AWS_*` vars — AI provider credentials.
- `VALKEY_URL`, `DATABASE_URL` — data layer.

`ORCHESTRATOR_URL` is provided by the spawner inline (derived from the orchestrator's own `ORCHESTRATOR_PUBLIC_URL`), so it does not need to live in the Secret.

GitHub App credentials are NOT needed on daemons — the orchestrator mints installation tokens and passes them per-job.

### Ephemeral Pod security posture

The spawner hardens every ephemeral Pod as follows (see `src/k8s/ephemeral-daemon-spawner.ts`):

- `automountServiceAccountToken: false` — the daemon never calls the K8s API itself, so no ServiceAccount token is mounted. An agent subprocess running untrusted repo code cannot use it.
- `securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: RuntimeDefault }` at Pod scope.
- Container-scope: `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`.
- `restartPolicy: Never` and `activeDeadlineSeconds: 3600` provide a hard K8s-enforced ceiling if the idle-exit loop wedges.

### Key constraints

- `AGENT_TIMEOUT_MS` must stay below the GitHub installation-token TTL (3600s) so the daemon cannot outlive its credentials.
- `EPHEMERAL_DAEMON_IDLE_TIMEOUT_MS` should be longer than typical heartbeat cadence so a short lull between back-to-back jobs does not cause the daemon to exit.
- Match `terminationGracePeriodSeconds` on the persistent daemon Deployment to `DAEMON_DRAIN_TIMEOUT_MS`.

## Implementation references

`src/daemon/main.ts`, `src/orchestrator/ws-server.ts`, `src/orchestrator/ephemeral-daemon-scaler.ts`, `src/k8s/ephemeral-daemon-spawner.ts`, `src/core/pipeline.ts`, `src/core/tracking-comment.ts`.
