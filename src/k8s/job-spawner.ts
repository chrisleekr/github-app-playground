import { BatchV1Api, KubeConfig, type V1Job, type V1JobStatus } from "@kubernetes/client-node";
import type { Logger } from "pino";

import { config } from "../config";
import { getDb } from "../db";
import { logger } from "../logger";
import { markExecutionFailed } from "../orchestrator/history";
import { type BotContext, type ExecutionResult, serializeBotContext } from "../types";
import type { DispatchDecision } from "../webhook/router";
import { releaseInFlight } from "./pending-queue";

type WatchLogger = Logger;

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
 *     bundled at dist/k8s/job-entrypoint.js (built from src/k8s/job-entrypoint.ts
 *     by scripts/build.ts). Reads AGENT_CONTEXT_B64 to
 *     reconstruct the BotContext and invokes the inline pipeline with the
 *     expanded tool allow-list. Mounts /workspace as emptyDir so build
 *     artefacts don't survive the Job.
 *   - `docker` (sidecar): the docker:29-dind image, privileged, sharing
 *     /var/lib/docker via emptyDir so the agent can shell `docker build`
 *     at DOCKER_HOST=tcp://localhost:2375.
 *
 * An InitContainer waits for the Docker daemon to be reachable before the
 * agent starts — avoids a race where Claude tries `docker info` before the
 * sidecar has bound the socket.
 *
 * Cleanup: backoffLimit=0 (no K8s retry — idempotency AND FR-021 no-retry
 * on mid-run failure both belong to the app layer, not K8s), TTL matches
 * `config.jobTtlSeconds`, activeDeadlineSeconds matches
 * `config.jobActiveDeadlineSeconds` (K8s enforces the hard wall clock;
 * `watchJobCompletion` below enforces the same ceiling client-side and
 * owns the `status="timeout"` execution row + `releaseInFlight` cleanup).
 */
/**
 * Stable, deterministic Job name derived from the delivery id. DNS-1123
 * (lowercase alphanumeric + dashes, ≤63 chars). Exported so the
 * completion watcher can reconstruct the name without threading it
 * through every caller.
 */
export function jobNameForDelivery(deliveryId: string): string {
  return `bot-${deliveryId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .slice(0, 50)}`;
}

function buildJobSpec(ctx: BotContext, decision: DispatchDecision, encodedContext: string): V1Job {
  const namespace = config.jobNamespace;
  const image = config.jobImage ?? "github-app-playground:local-orchestrator";
  const ttlSeconds = config.jobTtlSeconds;
  const jobName = jobNameForDelivery(ctx.deliveryId);

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
    providerEnv.push({ name: "CLAUDE_MODEL", value: config.model });
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
      activeDeadlineSeconds: config.jobActiveDeadlineSeconds,
      template: {
        metadata: {
          labels: { "app.kubernetes.io/component": "isolated-job" },
        },
        spec: {
          restartPolicy: "Never",
          initContainers: [
            {
              // Must ship the Docker CLI — the bot's server image does not.
              // `docker:29-cli` is small and pinned to the same major as the
              // sidecar so client/daemon compatibility is guaranteed.
              // Bumped 27 → 29 (2026-04-16) so the Go stdlib in the CLI
              // binary picks up Go 1.26.x patches for the 9 CVEs Trivy
              // flagged on 27-cli's Go 1.22.x.
              name: "wait-for-docker",
              image: "docker:29-cli",
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
              command: ["bun", "run", "dist/k8s/job-entrypoint.js"],
              env: providerEnv,
              volumeMounts: [{ name: "workspace", mountPath: "/workspace" }],
              resources: {
                requests: { cpu: "500m", memory: "1Gi" },
                limits: { cpu: "2000m", memory: "4Gi" },
              },
            },
            {
              name: "docker",
              image: "docker:29-dind",
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

// Completion watcher (T046 + T047 + T048)

/**
 * Terminal outcome of `watchJobCompletion`. Each outcome maps to a
 * distinct operator story:
 *
 *   - `succeeded` : Job completed with at least one successful Pod. The
 *                   entrypoint already wrote `status='completed'` and
 *                   finalised the tracking comment; the watcher only
 *                   releases the in-flight slot.
 *   - `failed`    : Job reported a Pod failure that was NOT a deadline
 *                   timeout. Entrypoint owns the row + comment; FR-021
 *                   forbids automatic retry, so the watcher only releases.
 *   - `timeout`   : Wall-clock ceiling reached (either K8s observed the
 *                   `activeDeadlineSeconds` or the client-side deadline
 *                   fires first). Watcher deletes the Job (idempotent),
 *                   marks the execution row failed with a timeout-tagged
 *                   error message, and releases the slot.
 *   - `abandoned` : Job disappeared (deleted externally) or was never
 *                   observed. Watcher releases the slot and logs; no DB
 *                   write — the entrypoint row, if any, is left intact.
 */
export type JobWatchOutcome = "succeeded" | "failed" | "timeout" | "abandoned";

/**
 * Options for `watchJobCompletion`. All `inject*` callbacks exist purely
 * for deterministic tests — production callers pass none and get the
 * real wall clock / K8s client / bundled cleanup helpers.
 */
export interface WatchJobCompletionOptions {
  /**
   * Optional override for the wall-clock deadline (ms). Defaults to
   * `config.jobActiveDeadlineSeconds * 1000`. Capped at the default — a
   * caller may shorten the watch but MUST NOT extend it past the
   * server-side `activeDeadlineSeconds` used when creating the Job.
   */
  deadlineMs?: number;
  /** Optional override for the poll interval (ms). Defaults to `config.jobWatchPollIntervalMs`. */
  pollIntervalMs?: number;
  /** Optional namespace override. Defaults to `config.jobNamespace`. */
  namespace?: string;

  // --- test injection ---
  /** Override the K8s BatchV1Api — tests pass a stub. */
  injectClient?: Pick<BatchV1Api, "readNamespacedJobStatus" | "deleteNamespacedJob">;
  /** Override `Date.now()` for deterministic timeout assertions. */
  injectNow?: () => number;
  /** Override `setTimeout`-based sleep to keep tests fast. */
  injectSleep?: (ms: number) => Promise<void>;
  /** Override the DB status writer. Tests capture calls to assert the timeout path wrote the row. */
  injectMarkFailed?: (deliveryId: string, errorMessage: string) => Promise<void>;
  /** Override `releaseInFlight`. Tests assert the `finally` invariant fires on every exit path. */
  injectReleaseInFlight?: (deliveryId: string) => Promise<void>;
}

/**
 * Watch an isolated-job to completion. Fire-and-forget from the router's
 * perspective: intended to be invoked via `void watchJobCompletion(...)` so
 * the webhook can return its 200 immediately and the watcher runs in the
 * background until the Job terminates or the wall-clock deadline elapses.
 *
 * Invariants:
 *
 *   - (T047) `releaseInFlight(deliveryId)` runs in a `finally` block on
 *     every exit path — success, failure, timeout, K8s error, unexpected
 *     throw. Without this the in-flight capacity counter would leak slots
 *     and the pool would eventually refuse work despite having capacity.
 *   - (T048 / FR-021) On `failed` or `timeout`, the watcher records the
 *     failure but does NOT re-enqueue or re-dispatch. The maintainer must
 *     re-trigger manually.
 *   - (T046) The watcher enforces a wall-clock ceiling independently of
 *     `activeDeadlineSeconds`. The K8s-side deadline is authoritative for
 *     actually killing the Pod; the client-side deadline guarantees the
 *     row + in-flight slot are cleaned up even if the K8s API becomes
 *     unreachable past the deadline. When the deadline fires first,
 *     `deleteNamespacedJob` is best-effort (swallowed on failure).
 *
 * @returns The terminal outcome. Never throws to the caller; all failures
 *          are converted to `abandoned` so a detached `void watchJobCompletion(...)`
 *          call can't crash the server with an unhandled rejection.
 */
export async function watchJobCompletion(
  deliveryId: string,
  options: WatchJobCompletionOptions = {},
): Promise<JobWatchOutcome> {
  const namespace = options.namespace ?? config.jobNamespace;
  // T046: cap the wall-clock deadline at the config ceiling
  // (`config.jobActiveDeadlineSeconds`, itself bounded at 3500s by the
  // Zod schema so the GitHub installation-token TTL stays intact). A
  // caller-provided `deadlineMs` may shorten the watch but MUST NOT
  // extend it past the server-side `activeDeadlineSeconds` used when
  // creating the Job — otherwise the watcher could linger after K8s has
  // already killed the Pod.
  const maxDeadlineMs = config.jobActiveDeadlineSeconds * 1000;
  const rawDeadlineMs = options.deadlineMs ?? maxDeadlineMs;
  const deadlineMs = Math.min(rawDeadlineMs, maxDeadlineMs);
  const pollIntervalMs = options.pollIntervalMs ?? config.jobWatchPollIntervalMs;
  const now = options.injectNow ?? Date.now;
  const sleep = options.injectSleep ?? defaultSleep;
  const markFailed = options.injectMarkFailed ?? defaultMarkFailed;
  const release = options.injectReleaseInFlight ?? releaseInFlight;

  const jobName = jobNameForDelivery(deliveryId);
  const log = logger.child({ module: "job-spawner.watch", deliveryId, jobName });
  const startedAt = now();

  let client: Pick<BatchV1Api, "readNamespacedJobStatus" | "deleteNamespacedJob">;
  try {
    client = options.injectClient ?? loadKubernetesClient().batch;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "watchJobCompletion could not load K8s client — releasing slot and abandoning watch",
    );
    await safeRelease(release, deliveryId, log);
    return "abandoned";
  }

  try {
    // Poll loop. The entire body is wrapped so any unexpected throw from
    // `injectSleep` / `injectMarkFailed` / `bestEffortDelete` is converted
    // to `abandoned` rather than propagating as an unhandled rejection
    // (the docstring's "Never throws to the caller" guarantee).
    // The outer `finally` still fires, so the in-flight slot is always
    // released.
    while (true) {
      // Cap the sleep to the remaining budget so a large `pollIntervalMs`
      // can't overshoot the deadline by a full interval. `Math.max(1, …)`
      // guarantees forward progress when we're right at the boundary.
      const remaining = deadlineMs - (now() - startedAt);
      const nextSleepMs = Math.max(1, Math.min(pollIntervalMs, remaining));
      await sleep(nextSleepMs);

      const elapsed = now() - startedAt;
      if (elapsed >= deadlineMs) {
        log.warn({ elapsedMs: elapsed, deadlineMs }, "isolated-job wall-clock deadline reached");
        await bestEffortDelete(client, namespace, jobName, log);
        await markFailed(
          deliveryId,
          `isolated-job exceeded wall-clock deadline of ${Math.round(deadlineMs / 1000)}s`,
        );
        return "timeout";
      }

      const status = await safeReadStatus(client, namespace, jobName, log);
      if (status === null) return "abandoned";

      if ((status.succeeded ?? 0) >= 1) {
        log.info({ elapsedMs: elapsed }, "isolated-job succeeded");
        return "succeeded";
      }

      if ((status.failed ?? 0) >= 1) {
        const deadlineExceeded = jobFailedForDeadline(status);
        if (deadlineExceeded) {
          log.warn({ elapsedMs: elapsed }, "isolated-job terminated by K8s DeadlineExceeded");
          await bestEffortDelete(client, namespace, jobName, log);
          await markFailed(
            deliveryId,
            `isolated-job terminated by Kubernetes: DeadlineExceeded after ${Math.round(
              elapsed / 1000,
            )}s`,
          );
          return "timeout";
        }
        log.warn({ elapsedMs: elapsed }, "isolated-job failed");
        // Entrypoint owns the DB row + tracking comment on a graceful
        // failure; FR-021 forbids retry. Watcher only releases (via finally).
        return "failed";
      }

      // else: still Pending / Running — loop again.
    }
  } catch (err) {
    // Defense-in-depth: anything thrown from inside the loop (injected
    // sleep, markFailed, bestEffortDelete, or an unexpected
    // non-duck-typed K8s error) is converted to `abandoned`. Without
    // this outer catch, a `void watchJobCompletion(...)` call could
    // surface as an unhandled rejection and crash the server.
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "watchJobCompletion encountered unexpected error — abandoning watch",
    );
    return "abandoned";
  } finally {
    await safeRelease(release, deliveryId, log);
  }
}

function jobFailedForDeadline(status: V1JobStatus): boolean {
  const conds = status.conditions ?? [];
  return conds.some((c) => c.type === "Failed" && c.reason === "DeadlineExceeded");
}

async function safeReadStatus(
  client: Pick<BatchV1Api, "readNamespacedJobStatus">,
  namespace: string,
  jobName: string,
  log: WatchLogger,
): Promise<V1JobStatus | null> {
  try {
    const resp = await client.readNamespacedJobStatus({ namespace, name: jobName });
    return resp.status ?? {};
  } catch (err) {
    const status =
      (err as { statusCode?: number; response?: { statusCode?: number } })?.statusCode ??
      (err as { response?: { statusCode?: number } })?.response?.statusCode;
    if (status === 404) {
      // Job disappeared — nothing to watch. Treat as abandoned so the
      // caller's finally block still releases the slot.
      log.warn({ status }, "isolated-job not found (404) — watch abandoned");
      return null;
    }
    // Transient: log + keep polling. Real operator remedies (API down for
    // > deadline) are handled by the wall-clock deadline branch.
    log.warn(
      { err: err instanceof Error ? err.message : String(err), status },
      "isolated-job status read failed — retrying",
    );
    return {};
  }
}

async function bestEffortDelete(
  client: Pick<BatchV1Api, "deleteNamespacedJob">,
  namespace: string,
  jobName: string,
  log: WatchLogger,
): Promise<void> {
  try {
    await client.deleteNamespacedJob({
      namespace,
      name: jobName,
      propagationPolicy: "Background",
    });
  } catch (err) {
    // Not fatal: K8s enforces activeDeadlineSeconds server-side anyway; the
    // manual delete is only to reclaim pod/sidecar resources faster.
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "best-effort delete of timed-out Job failed",
    );
  }
}

async function safeRelease(
  release: (deliveryId: string) => Promise<void>,
  deliveryId: string,
  log: WatchLogger,
): Promise<void> {
  try {
    await release(deliveryId);
  } catch (err) {
    // Never let a release-time Valkey outage crash the watcher. NOTE: the
    // in-flight set (`dispatch:isolated-job:in-flight`) has no TTL, so a
    // persistently failing release leaks a permanent capacity slot until
    // an operator trims the set manually. Surfaced at ERROR level so the
    // operator picks it up via alerting.
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "releaseInFlight failed after Job completion — slot LEAKED (manual cleanup required)",
    );
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // `.unref()` so an in-flight watcher's poll timer does not keep the
    // webhook server process alive for up to the job deadline (30+ min)
    // during graceful shutdown. The watcher is best-effort; on SIGTERM the
    // entrypoint's own handler owns the row/comment finalisation, and K8s
    // enforces `activeDeadlineSeconds` server-side anyway.
    setTimeout(resolve, ms).unref();
  });
}

async function defaultMarkFailed(deliveryId: string, errorMessage: string): Promise<void> {
  if (getDb() === null) return;
  await markExecutionFailed(deliveryId, errorMessage);
}
