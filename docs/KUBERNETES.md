# Kubernetes — Isolated-Job Mode

Isolated-job mode spawns a fresh Kubernetes Job for each request. Use it when you need per-request isolation (untrusted repos, long runs with a DinD sidecar, or a hard wall-clock ceiling the application cannot bypass).

## How dispatch works

1. The router picks `isolated-job` (via label, keyword, triage, or `AGENT_JOB_MODE=isolated-job`).
2. The capacity gate checks the `dispatch:isolated-job:in-flight` set against `MAX_CONCURRENT_ISOLATED_JOBS`.
3. If there's headroom, a Job is spawned in `JOB_NAMESPACE` using `JOB_IMAGE`.
4. Otherwise the request enqueues on a bounded Valkey pending list. The tracking comment shows "Queued (position N of M on isolated-job pool)".
5. When the list is already at `PENDING_ISOLATED_JOB_QUEUE_MAX`, the request is rejected outright with `dispatch_reason=capacity-rejected`.
6. A drainer process watches the pending list and spawns queued Jobs as slots free.

## Minimum RBAC

The pod that spawns Jobs needs a ServiceAccount with `create`, `get`, `list`, and `delete` on `jobs` and `pods` in `JOB_NAMESPACE`. Example:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: github-app-playground-job-spawner
  namespace: github-app
rules:
  - apiGroups: ["batch"]
    resources: ["jobs"]
    verbs: ["create", "get", "list", "watch", "delete"]
  - apiGroups: [""]
    resources: ["pods", "pods/log"]
    verbs: ["get", "list", "watch"]
```

Bind it to the orchestrator pod's ServiceAccount via a `RoleBinding`.

## Deployment skeleton

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: github-app-playground
spec:
  replicas: 1
  template:
    spec:
      serviceAccountName: github-app-playground
      terminationGracePeriodSeconds: 300
      containers:
        - name: app
          image: chrisleekr/github-app-playground:latest
          ports:
            - containerPort: 3000
          env:
            - name: AGENT_JOB_MODE
              value: "auto"
            - name: DEFAULT_DISPATCH_TARGET
              value: "shared-runner"
            - name: JOB_NAMESPACE
              value: "github-app"
            - name: JOB_IMAGE
              value: "chrisleekr/github-app-playground:latest"
            - name: CLONE_BASE_DIR
              value: "/workspaces"
            - name: MAX_CONCURRENT_ISOLATED_JOBS
              value: "3"
          volumeMounts:
            - name: bot-workspaces
              mountPath: /workspaces
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
      volumes:
        - name: bot-workspaces
          emptyDir:
            sizeLimit: 5Gi
```

## Key constraints

- `terminationGracePeriodSeconds` should match or exceed `DAEMON_DRAIN_TIMEOUT_MS` so SIGTERM has time to drain in-flight work before SIGKILL.
- `JOB_ACTIVE_DEADLINE_SECONDS` must be strictly below the GitHub installation-token TTL (3600s). The default `1800` leaves margin.
- `JOB_TTL_SECONDS` controls how long completed Job pods survive for log retrieval. Too low and `kubectl logs` fails.
- The Job pod for isolated runs needs a DinD sidecar with `securityContext.privileged: true` if the agent will invoke Docker. This is a deliberate trade-off for isolated mode; if you don't need DinD, prefer `shared-runner`.

## Implementation references

`src/k8s/job-spawner.ts`, `src/k8s/pending-queue.ts`, `src/k8s/pending-queue-drainer.ts`, `src/core/tracking-comment.ts`.
