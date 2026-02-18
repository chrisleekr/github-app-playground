# Deployment

This guide covers building and running the bot in production using Docker.

---

## Docker Image

### Multi-stage build

The `Dockerfile` uses three stages to produce a lean production image:

| Stage         | Base             | Purpose                                                 |
| ------------- | ---------------- | ------------------------------------------------------- |
| `base`        | `oven/bun:1.3.8` | Installs Node.js 20 (for Claude Code CLI) and git       |
| `development` | `base`           | Installs all deps, bundles `src/app.ts` → `dist/app.js` |
| `deps`        | `base`           | Installs production deps only (`--production`)          |
| `production`  | `base`           | Copies `dist/`, production `node_modules/`, MCP sources |

MCP stdio servers (`src/mcp/servers/*.ts`) are **not bundled** — they run as source
files via `bun run` and are copied as-is into the production image alongside
`src/utils/` (shared utilities) and `tsconfig.json` (required by the Bun runtime).

### Build arguments

| Argument          | Default       | Purpose                                   |
| ----------------- | ------------- | ----------------------------------------- |
| `PACKAGE_VERSION` | `untagged`    | Stored as a Docker label for traceability |
| `GIT_HASH`        | `unspecified` | Stored as a Docker label for traceability |

```bash
# Basic build
docker build -t chrisleekr/github-app-playground .

# Build with version metadata (recommended for production)
docker build \
  --build-arg PACKAGE_VERSION=$(cat package.json | bun -e "const p=await Bun.stdin.json(); process.stdout.write(p.version)") \
  --build-arg GIT_HASH=$(git rev-parse --short HEAD) \
  -t chrisleekr/github-app-playground:$(git rev-parse --short HEAD) \
  --progress=plain \
  .

# Shortcut defined in package.json
bun run docker:build
```

### Run the container

```bash
docker run \
  --env-file .env \
  -p 3000:3000 \
  chrisleekr/github-app-playground
```

All environment variables from `docs/SETUP.md` Section 6 apply. Pass them via
`--env-file` or individual `-e` flags.

---

## Health and Readiness Probes

The server exposes two HTTP endpoints on the same port as the webhook listener:

| Endpoint   | Method | Success     | Failure             | Purpose                                           |
| ---------- | ------ | ----------- | ------------------- | ------------------------------------------------- |
| `/healthz` | `GET`  | `200 ok`    | —                   | Liveness: process is alive (no external deps)     |
| `/readyz`  | `GET`  | `200 ready` | `503 shutting down` | Readiness: accept traffic (false during shutdown) |

`/readyz` returns `503` once the server receives `SIGTERM`, signalling the load
balancer to stop routing new requests while in-flight work completes.

### Kubernetes example

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

---

## Graceful Shutdown

The server handles `SIGTERM` and `SIGINT`:

1. Sets `/readyz` to return `503` immediately (load balancer stops routing).
2. Calls `server.close()` — waits for in-flight HTTP requests to finish.
3. MCP stdio child processes finish their current tool calls and exit via their `finally` blocks.
4. Forces exit after **290 seconds** if shutdown has not completed (allows time for
   in-flight Claude executions which may take several minutes).

Set `terminationGracePeriodSeconds: 300` in your Kubernetes `Pod` spec to match
(the 10-second gap gives Kubernetes time to send `SIGKILL` after the force-exit).

```yaml
# Kubernetes Deployment spec excerpt
spec:
  terminationGracePeriodSeconds: 300
  containers:
    - name: github-app-playground
      image: chrisleekr/github-app-playground
      ports:
        - containerPort: 3000
```

---

## Resource Recommendations

### Memory

Each concurrent Claude Agent SDK execution spawns child processes (MCP stdio servers

- the Claude Code CLI) and clones a repository to disk.
  A rough baseline per concurrent request is **512 MB RAM**.

| `MAX_CONCURRENT_REQUESTS` | Recommended memory limit |
| ------------------------- | ------------------------ |
| 1                         | 1 GB                     |
| 3 (default)               | 2 GB                     |
| 5                         | 3 GB                     |

Reduce `MAX_CONCURRENT_REQUESTS` (or increase memory) if the pod is OOM-killed.

### Disk

Each request clones the target repository to `CLONE_BASE_DIR` (default `/tmp/bot-workspaces`).
Clones use `--depth=50` to limit history. Repositories are deleted immediately after
the request completes (in the `finally` block).

Peak disk usage = repository size × `MAX_CONCURRENT_REQUESTS`.

For large monorepos or high concurrency, mount a dedicated volume at `CLONE_BASE_DIR`
or set it to a path on a larger disk.

```yaml
# Kubernetes — emptyDir volume for clone workspace
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

### CPU

The bot is I/O-bound (network calls + subprocess spawning). 1–2 vCPU is sufficient
for `MAX_CONCURRENT_REQUESTS=3`.

---

## Environment Variables

All environment variables are documented in [docs/SETUP.md](./SETUP.md) Section 6.
The most operationally relevant ones for production:

| Variable                  | Production recommendation                                     |
| ------------------------- | ------------------------------------------------------------- |
| `NODE_ENV`                | `production`                                                  |
| `LOG_LEVEL`               | `info` (use `debug` only for troubleshooting — very verbose)  |
| `MAX_CONCURRENT_REQUESTS` | Start at `3`; tune based on memory and API budget             |
| `CLONE_BASE_DIR`          | Override if default `/tmp` is on a small or shared filesystem |
| `PORT`                    | `3000` (must match `containerPort` and probe paths)           |
