# Deployment

This guide covers building and running the bot in production. The repository
ships **two container images** — an orchestrator and a daemon — that are built
from separate Dockerfiles but share a byte-identical base layer.

---

## Image topology

| Image          | Dockerfile                | Role                                                                                                      | Needs outbound network                                   |
| -------------- | ------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `orchestrator` | `Dockerfile.orchestrator` | Webhook server, WebSocket daemon registry, triage classifier, ephemeral daemon spawner                    | GitHub API, Anthropic/Bedrock, Postgres, Valkey, K8s API |
| `daemon`       | `Dockerfile.daemon`       | Fat worker image with real toolchains (kubectl, helm, terraform, aws, gcloud, docker CLI, go, rust, etc.) | Orchestrator WebSocket (outbound), GitHub API, Anthropic |

The two images intentionally diverge after a shared base because their cost and
attack surface are very different: the orchestrator stays slim (no docker CLI,
no third-party toolchains), while the daemon bakes in the tools Claude agents
are allowed to shell out to. The shared prefix — stages `base`, `development`,
`deps` — is enforced byte-identical by
`scripts/check-dockerfile-base-sync.ts` (runs in CI) between the
`# --- SHARED-BASE-BEGIN ---` and `# --- SHARED-BASE-END ---` markers.

### Shared base stages

Both Dockerfiles start with the same three stages:

| Stage         | Base              | Purpose                                                                                                                                            |
| ------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `base`        | `oven/bun:1.3.12` | Installs Node.js 20 (for Claude Code CLI), npm 11, `curl`, `git`, `@anthropic-ai/claude-code@2.1.114` globally, plus targeted openssl CVE upgrades |
| `development` | `base`            | `bun install` (all deps) + `bun run build` → bundles `dist/` (app, daemon main, MCP stdio servers)                                                 |
| `deps`        | `base`            | `bun install --production --ignore-scripts` (runtime deps only; skips husky)                                                                       |

### Orchestrator-specific stages

`Dockerfile.orchestrator` adds one stage on top of `deps`:

| Stage        | Base   | Purpose                                                                             |
| ------------ | ------ | ----------------------------------------------------------------------------------- |
| `production` | `base` | Copies `dist/`, production `node_modules/`, and `src/db/migrations/`; runs as `bun` |

### Daemon-specific stages

`Dockerfile.daemon` adds two stages on top of `deps`:

| Stage          | Base           | Purpose                                                                                                                                                                                                        |
| -------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `daemon-tools` | `base`         | Installs kubectl, helm, terraform, kustomize, k9s, stern, argocd, flux, tflint, yq, aws-cli, gcloud, docker CLI, go, rust, poetry, gh, azure-cli, and bakes `daemon-capabilities.static.json` for fast startup |
| `production`   | `daemon-tools` | Copies `dist/` and production `node_modules/`; runs as `bun`                                                                                                                                                   |

Tool versions in `daemon-tools` are parameterised by `ARG` (e.g.
`KUBECTL_VERSION`, `HELM_VERSION`) and bumped together by
Renovate/Dependabot. The Trivy gate in CI blocks CVE regressions.

---

## Build

```bash
# Orchestrator only
bun run docker:build:orchestrator   # → chrisleekr/github-app-playground:local-orchestrator

# Daemon only (slow — installs toolchains)
bun run docker:build:daemon         # → chrisleekr/github-app-playground:local-daemon

# Both (convenience)
bun run docker:build
```

The scripts expand to `docker build -f <file> -t ... . --progress=plain`
(see `package.json`). There is no default `Dockerfile` in the repo — always
pass `-f`.

### Build arguments

Common to both images:

| Argument          | Default       | Purpose                                                     |
| ----------------- | ------------- | ----------------------------------------------------------- |
| `PACKAGE_VERSION` | `untagged`    | Stored as Docker label `com.chrisleekr.bot.package-version` |
| `GIT_HASH`        | `unspecified` | Stored as Docker label `com.chrisleekr.bot.git-hash`        |

Daemon-only (toggle toolchain cost):

| Argument         | Default     | Purpose                                                |
| ---------------- | ----------- | ------------------------------------------------------ |
| `TARGETARCH`     | from buildx | Selects `amd64` / `arm64` asset URLs                   |
| `INSTALL_GCLOUD` | `true`      | Skip the ~500 MB Google Cloud SDK install if `false`   |
| `INSTALL_LANGS`  | `go rust`   | Space-separated list of language toolchains to bake in |

```bash
# Example: orchestrator with version metadata
docker build -f Dockerfile.orchestrator \
  --build-arg PACKAGE_VERSION=$(bun -e "console.log(require('./package.json').version)") \
  --build-arg GIT_HASH=$(git rev-parse --short HEAD) \
  -t chrisleekr/github-app-playground:$(git rev-parse --short HEAD)-orchestrator \
  .
```

### Image contents (production)

**Both images copy:**

- `/app/dist/` — bundled app, MCP stdio servers, and (daemon only) `dist/daemon/main.js`. Produced by `bun run build` in the `development` stage.
- `/app/package.json` — for runtime version lookups.
- `/app/node_modules/` — runtime-only deps from the `deps` stage.
- `/app/src/db/migrations/` — SQL files, not bundled (orchestrator only; daemon also copies them because it may run migrations).
- `ENV CLAUDE_CODE_PATH=/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js` — pinned path to the globally-installed Claude Code CLI, because the Agent SDK otherwise looks for `{cwd}/dist/cli.js`.

**Only the daemon copies:** `/app/daemon-capabilities.static.json` (pre-computed tool discovery manifest consumed by `src/daemon/tool-discovery.ts`).

**Neither image copies:** `src/` sources, `tsconfig.json`, devDependencies,
or the `scripts/` directory. All MCP servers run from the bundled `dist/mcp/servers/*.js`, not source.

---

## Run

### Orchestrator

```bash
docker run \
  --env-file .env \
  -p 3000:3000 \
  -p 3002:3002 \
  chrisleekr/github-app-playground:local-orchestrator
```

- `3000` — HTTP: webhook listener, `/healthz`, `/readyz`.
- `3002` — WebSocket: daemon registry (`WS_PORT`, default `3002`, see
  `src/orchestrator/ws-server.ts`). Only expose this on networks the daemons
  will connect from.

Shortcut: `bun run docker:run` (also mounts `~/.aws` read-only for local Bedrock testing).

### Daemon

```bash
docker run \
  --env-file .env \
  -e ORCHESTRATOR_URL=ws://orchestrator-host:3002 \
  -e DAEMON_AUTH_TOKEN=... \
  -v $HOME/.aws:/home/bun/.aws:ro \
  chrisleekr/github-app-playground:local-daemon
```

The daemon does **not** expose any HTTP port and does **not** need GitHub App
credentials — the orchestrator mints installation tokens and hands them off
per job. See [DAEMON.md](DAEMON.md) for the full lifecycle and auth contract.

Shortcut: `bun run docker:run:daemon` (connects back to
`ws://host.docker.internal:3002` for the local-dev `docker:run` orchestrator).

---

## Health and readiness probes

> These endpoints exist on the **orchestrator image only**. The daemon has no
> HTTP listener; its liveness is tracked in the orchestrator's in-memory daemon
> registry via the WebSocket heartbeat.

| Endpoint   | Method | Success     | Failure             | Purpose                                              |
| ---------- | ------ | ----------- | ------------------- | ---------------------------------------------------- |
| `/healthz` | `GET`  | `200 ok`    | —                   | Liveness: process is alive (no external deps)        |
| `/readyz`  | `GET`  | `200 ready` | `503 shutting down` | Readiness: accept traffic (flips `false` on SIGTERM) |

See `src/app.ts:99-104`. On `SIGTERM`, the server immediately returns `503` on
`/readyz` so the load balancer stops routing new requests while in-flight work
drains.

### Docker HEALTHCHECK (orchestrator)

`Dockerfile.orchestrator` ships with:

```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/healthz || exit 1
```

Honoured by Docker Compose, ECS, Nomad, Swarm. Kubernetes ignores Docker
`HEALTHCHECK` and uses the probe spec below. `curl` is installed in the `base`
stage specifically for this — do not remove.

### Kubernetes probes (orchestrator)

```yaml
livenessProbe:
  httpGet:
    path: /healthz
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 10

readinessProbe:
  httpGet:
    path: /readyz
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 5
```

For the **daemon**, replace HTTP probes with an `exec` probe that checks the
daemon is still connected to the orchestrator — see
[DAEMON.md](DAEMON.md) for a working example.

---

## Graceful shutdown

The orchestrator handles `SIGTERM` and `SIGINT`:

1. Flips `/readyz` to `503` (load balancer stops routing).
2. Calls `server.close()` — waits for in-flight HTTP requests to finish.
3. MCP stdio child processes exit via their own `finally` blocks.
4. **Force-exits after 290 seconds** if shutdown has not completed (`src/app.ts:360`).

Set `terminationGracePeriodSeconds: 300` on the Pod so SIGKILL lands 10 seconds
after the force-exit fires:

```yaml
spec:
  terminationGracePeriodSeconds: 300
```

The daemon has its own drain contract driven by `DAEMON_DRAIN_TIMEOUT_MS` — it
finishes the job it is currently executing, rejects new offers, then
disconnects. Match `terminationGracePeriodSeconds` to `DAEMON_DRAIN_TIMEOUT_MS`
on the daemon's Pod spec (see [DAEMON.md](DAEMON.md)).

---

## Resource recommendations

### Orchestrator sizing

I/O-bound — network calls to GitHub and the LLM provider, WebSocket fan-out,
SQL writes, occasional K8s API calls to spawn ephemeral daemons. The orchestrator never runs the pipeline itself, so 1 GB is typically enough.

| `MAX_CONCURRENT_REQUESTS` | Memory limit | CPU      |
| ------------------------- | ------------ | -------- |
| 1                         | 1 GB         | 1 vCPU   |
| 3 (default)               | 2 GB         | 1–2 vCPU |
| 5                         | 3 GB         | 2 vCPU   |

### Daemon sizing

Dominated by whatever Claude runs inside it — `kubectl`, `terraform plan`,
`aws cli`, `docker build`. Start with:

| Concurrent jobs     | Memory limit | CPU      |
| ------------------- | ------------ | -------- |
| 1                   | 2 GB         | 1–2 vCPU |
| 3 (typical default) | 4 GB         | 2–4 vCPU |

Set concurrency via `DAEMON_MAX_CONCURRENT_JOBS`. The image itself is ~2 GB
unpacked — plan for the node. The same sizing applies to ephemeral daemon
Pods — the spawner uses the same image.

### Disk

Each job clones the target repository to `CLONE_BASE_DIR` (default
`/tmp/bot-workspaces`) with `git clone --depth=${CLONE_DEPTH}` (default `50`,
see `src/core/checkout.ts:59`). The clone directory is removed in the
pipeline's `finally` block.

Peak disk = `average_repo_size × concurrent_jobs`. For large monorepos, mount
a dedicated volume:

```yaml
volumes:
  - name: bot-workspaces
    emptyDir:
      sizeLimit: 5Gi
containers:
  - name: github-app-playground
    env:
      - name: CLONE_BASE_DIR
        value: /workspaces
    volumeMounts:
      - name: bot-workspaces
        mountPath: /workspaces
```

---

## Environment variables

The full schema lives in [CONFIGURATION.md](CONFIGURATION.md). Production
defaults worth double-checking:

| Variable                  | Production recommendation                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `NODE_ENV`                | `production` (the `development` stage bakes this in at build time; keep it set at runtime too) |
| `LOG_LEVEL`               | `info` — `debug` is very verbose and exposes webhook payloads                                  |
| `MAX_CONCURRENT_REQUESTS` | Start at `3`; tune against memory limits and LLM budget                                        |
| `CLONE_BASE_DIR`          | Override if `/tmp` is on a small or shared filesystem                                          |
| `PORT`                    | `3000` (must match `containerPort` and probe paths)                                            |
| `WS_PORT`                 | `3002` (orchestrator WebSocket; keep behind cluster network)                                   |

---

## Ephemeral-daemon K8s requirements

If you want the orchestrator to spawn ephemeral daemon Pods on demand, two
cluster-side prerequisites must be in place in `EPHEMERAL_DAEMON_NAMESPACE`:

### Orchestrator RBAC

The orchestrator's ServiceAccount needs `create`, `get`, and `delete` on
`pods` in `EPHEMERAL_DAEMON_NAMESPACE`:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: github-app-playground-ephemeral-spawner
  # Role lives in the namespace where ephemeral daemon Pods will be created.
  namespace: ${EPHEMERAL_DAEMON_NAMESPACE}
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["create", "get", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: github-app-playground-ephemeral-spawner
  # Must match the Role namespace above.
  namespace: ${EPHEMERAL_DAEMON_NAMESPACE}
subjects:
  - kind: ServiceAccount
    name: github-app-playground
    # Namespace where the orchestrator ServiceAccount actually lives.
    namespace: ${ORCHESTRATOR_NAMESPACE}
roleRef:
  kind: Role
  name: github-app-playground-ephemeral-spawner
  apiGroup: rbac.authorization.k8s.io
```

Without these verbs, every scale-up attempt yields `dispatch_reason=ephemeral-spawn-failed` and the job is rejected with a tracking-comment infra error.

### `daemon-secrets` Secret

Spawned ephemeral daemon Pods receive their configuration via `envFrom: secretRef: daemon-secrets`. Create this Secret once in `EPHEMERAL_DAEMON_NAMESPACE` with only the daemon runtime values it needs — `DAEMON_AUTH_TOKEN`, Claude provider keys, and the daemon-side data-layer URLs (`DATABASE_URL`, `VALKEY_URL`). Do **not** copy GitHub App private-key material into this Secret: the orchestrator mints installation tokens and hands them to the daemon per job, so expanding the blast radius to every ephemeral Pod is unnecessary. See [DAEMON.md](DAEMON.md) for the full key list.
