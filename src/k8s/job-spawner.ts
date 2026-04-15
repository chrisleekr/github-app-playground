import { BatchV1Api, KubeConfig, type V1Job } from "@kubernetes/client-node";

import { config } from "../config";
import { type BotContext, type ExecutionResult, serializeBotContext } from "../types";
import type { DispatchDecision } from "../webhook/router";

/**
 * Typed errors the isolated-job spawner can throw. Distinguishing
 * `infra-absent` from generic K8s API failures lets the router map the
 * former to a graceful tracking-comment rejection (FR-018) without retry,
 * and the latter to its existing failure path.
 */
export type JobSpawnerErrorKind =
  | "infra-absent" // KUBERNETES_SERVICE_HOST + KUBECONFIG both unresolvable
  | "auth-load-failed" // kubeconfig present but unreadable / malformed
  | "api-rejected" // K8s API returned a 4xx (validation, RBAC, etc.)
  | "api-unavailable"; // K8s API unreachable (5xx, network)

export class JobSpawnerError extends Error {
  constructor(
    readonly kind: JobSpawnerErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "JobSpawnerError";
  }
}

/**
 * Lazy-initialised K8s API client. Loaded on first call, then cached. We
 * delay loading until first use so:
 *   (a) test environments without K8s auth don't fail at import time
 *   (b) the throw on missing auth surfaces inside the dispatch path where
 *       the router can map it to a tracking-comment rejection
 */
let cachedClient: { batch: BatchV1Api } | undefined;

function loadKubernetesClient(): { batch: BatchV1Api } {
  if (cachedClient !== undefined) return cachedClient;

  const kc = new KubeConfig();
  const inCluster = (process.env["KUBERNETES_SERVICE_HOST"]?.trim().length ?? 0) > 0;
  const hasKubeconfig = (process.env["KUBECONFIG"]?.trim().length ?? 0) > 0;

  if (!inCluster && !hasKubeconfig) {
    throw new JobSpawnerError(
      "infra-absent",
      "Kubernetes auth not configured: neither KUBERNETES_SERVICE_HOST (in-cluster) nor KUBECONFIG (out-of-cluster) is set",
    );
  }

  try {
    if (inCluster) {
      kc.loadFromCluster();
    } else {
      kc.loadFromDefault();
    }
  } catch (err) {
    throw new JobSpawnerError(
      "auth-load-failed",
      `Failed to load Kubernetes config: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  cachedClient = { batch: kc.makeApiClient(BatchV1Api) };
  return cachedClient;
}

/** Reset the cached client. Test-only — not exported in any production path. */
export function _resetK8sClientForTests(): void {
  cachedClient = undefined;
}

/**
 * Build the V1Job spec per research.md R8.
 *
 * The Pod has two containers:
 *   - `claude-agent`: same image as the webhook server, runs the entrypoint
 *     in src/k8s/job-entrypoint.ts (T020). Reads AGENT_CONTEXT_B64 to
 *     reconstruct the BotContext and invokes the inline pipeline with the
 *     expanded tool allow-list. Mounts /workspace as emptyDir so build
 *     artefacts don't survive the Job.
 *   - `docker` (sidecar): the docker:27-dind image, privileged, sharing
 *     /var/lib/docker via emptyDir so the agent can shell `docker build`
 *     at DOCKER_HOST=tcp://localhost:2375.
 *
 * An InitContainer waits for the Docker daemon to be reachable before the
 * agent starts — avoids a race where Claude tries `docker info` before the
 * sidecar has bound the socket.
 *
 * Cleanup: backoffLimit=0 (no K8s retry — idempotency belongs to the app
 * layer), ttlSecondsAfterFinished=3600 (auto-clean after 1h),
 * activeDeadlineSeconds=1800 (30-min wall clock).
 */
function buildJobSpec(ctx: BotContext, decision: DispatchDecision, encodedContext: string): V1Job {
  const namespace = config.jobNamespace;
  const image = config.jobImage ?? "github-app-playground:local";
  const ttlSeconds = config.jobTtlSeconds;
  // Job names must be DNS-1123 (lowercase alphanumeric + dashes, ≤63 chars).
  // deliveryId is a UUID; lower-case it and prefix with a stable token so the
  // Job is greppable in `kubectl get jobs`.
  const jobName = `bot-${ctx.deliveryId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .slice(0, 50)}`;

  // Provider credentials forwarded to the pod. These mirror what the
  // executor injects into the Claude CLI subprocess on the inline path —
  // see src/core/executor.ts > buildProviderEnv. The Job is short-lived
  // (≤30 min) so the installation token is fine to embed; it expires by
  // GitHub policy in 1h.
  const providerEnv: { name: string; value: string }[] = [
    { name: "AGENT_JOB_MODE", value: "isolated-job" },
    { name: "AGENT_CONTEXT_B64", value: encodedContext },
    { name: "DISPATCH_REASON", value: decision.reason },
    { name: "DISPATCH_MAX_TURNS", value: String(decision.maxTurns) },
    { name: "DOCKER_HOST", value: "tcp://localhost:2375" },
  ];
  if ((config.anthropicApiKey?.length ?? 0) > 0) {
    providerEnv.push({ name: "ANTHROPIC_API_KEY", value: config.anthropicApiKey ?? "" });
  }
  if ((config.claudeCodeOauthToken?.length ?? 0) > 0) {
    providerEnv.push({
      name: "CLAUDE_CODE_OAUTH_TOKEN",
      value: config.claudeCodeOauthToken ?? "",
    });
  }
  if (config.provider === "bedrock") {
    providerEnv.push({ name: "CLAUDE_PROVIDER", value: "bedrock" });
    if (config.awsRegion !== undefined) {
      providerEnv.push({ name: "AWS_REGION", value: config.awsRegion });
    }
    if (config.model !== undefined) {
      providerEnv.push({ name: "CLAUDE_MODEL", value: config.model });
    }
  }

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: jobName,
      namespace,
      labels: {
        "app.kubernetes.io/name": "github-app-playground",
        "app.kubernetes.io/component": "isolated-job",
        "github-app-playground/delivery-id": ctx.deliveryId.toLowerCase().slice(0, 63),
      },
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: ttlSeconds,
      activeDeadlineSeconds: 1800,
      template: {
        metadata: {
          labels: { "app.kubernetes.io/component": "isolated-job" },
        },
        spec: {
          restartPolicy: "Never",
          initContainers: [
            {
              // Must ship the Docker CLI — the bot's server image does not.
              // `docker:27-cli` is small and pinned to the same major as the
              // sidecar so client/daemon compatibility is guaranteed.
              name: "wait-for-docker",
              image: "docker:27-cli",
              command: [
                "sh",
                "-c",
                "until DOCKER_HOST=tcp://localhost:2375 docker info >/dev/null 2>&1; do sleep 1; done",
              ],
              env: [{ name: "DOCKER_HOST", value: "tcp://localhost:2375" }],
            },
          ],
          containers: [
            {
              name: "claude-agent",
              image,
              command: ["bun", "run", "src/k8s/job-entrypoint.ts"],
              env: providerEnv,
              volumeMounts: [{ name: "workspace", mountPath: "/workspace" }],
              resources: {
                requests: { cpu: "500m", memory: "1Gi" },
                limits: { cpu: "2000m", memory: "4Gi" },
              },
            },
            {
              name: "docker",
              image: "docker:27-dind",
              securityContext: { privileged: true },
              env: [{ name: "DOCKER_TLS_CERTDIR", value: "" }],
              volumeMounts: [{ name: "docker-storage", mountPath: "/var/lib/docker" }],
            },
          ],
          volumes: [
            { name: "workspace", emptyDir: {} },
            { name: "docker-storage", emptyDir: {} },
          ],
        },
      },
    },
  };
}

/**
 * Submit a Kubernetes Job that runs the inline pipeline inside an isolated
 * pod with container tooling. Fire-and-forget from the webhook server's
 * perspective: returns once the Job is created (not when it completes). The
 * Job entrypoint (T020) finalises the tracking comment and writes the
 * executions row when execution settles.
 *
 * @param ctx - Bot context for the originating webhook
 * @param decision - Resolved dispatch decision (target must be "isolated-job")
 * @returns Synthetic ExecutionResult marking successful submission
 *          (`success: true, durationMs: 0`); real cost / duration / turns
 *          are written to the executions row by the entrypoint.
 * @throws {JobSpawnerError} on missing K8s auth (kind: "infra-absent"),
 *         unloadable kubeconfig ("auth-load-failed"), or K8s API failure
 *         ("api-rejected" / "api-unavailable").
 */
export async function spawnIsolatedJob(
  ctx: BotContext,
  decision: DispatchDecision,
): Promise<ExecutionResult> {
  const client = loadKubernetesClient();

  const encodedContext = Buffer.from(JSON.stringify(serializeBotContext(ctx))).toString("base64");
  const jobSpec = buildJobSpec(ctx, decision, encodedContext);

  try {
    await client.batch.createNamespacedJob({ namespace: config.jobNamespace, body: jobSpec });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The K8s client surfaces non-2xx responses as throws with statusCode on
    // the response body — we duck-type to keep the spawner free of K8s
    // type imports beyond the API client itself.
    const status =
      (err as { statusCode?: number; response?: { statusCode?: number } })?.statusCode ??
      (err as { response?: { statusCode?: number } })?.response?.statusCode;
    const kind: JobSpawnerErrorKind =
      typeof status === "number" && status >= 400 && status < 500
        ? "api-rejected"
        : "api-unavailable";
    throw new JobSpawnerError(kind, `Failed to create Job: ${message}`);
  }

  return { success: true, durationMs: 0 };
}
