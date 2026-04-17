import { z } from "zod";

/**
 * Zod-validated environment variables.
 * Fails fast at startup if required vars are missing.
 */
const configSchema = z
  .object({
    // --- 1. GitHub App credentials (server mode) ---

    // GitHub App credentials — required for server mode, optional for daemon-only mode.
    // Daemon mode (ORCHESTRATOR_URL set) does not need these; validated in superRefine.
    appId: z.string().optional(),
    privateKey: z.string().optional(),
    webhookSecret: z.string().optional(),

    // --- 2. AI provider selection ---

    // AI provider selection: "anthropic" (default) or "bedrock".
    // "bedrock" additionally requires `awsRegion` + `model` — enforced in validateProviderCredentials.
    provider: z.enum(["anthropic", "bedrock"]).default("anthropic"),

    // Model override — required when provider=bedrock (Bedrock uses different model ID format),
    // optional for anthropic (SDK uses its default).
    model: z.string().min(1).optional(),

    // --- 3. Anthropic direct-API credentials ---

    // Claude API credentials — when provider=anthropic, at least one of these is required
    // (both may be set; the Claude CLI's own auth precedence chain picks one at runtime:
    // ANTHROPIC_API_KEY at position 3 beats CLAUDE_CODE_OAUTH_TOKEN at position 5).
    // Either Console API key (pay-as-you-go) or Max/Pro subscription OAuth token
    // (generated via `claude setup-token`, sk-ant-oat... prefix).
    // See https://code.claude.com/docs/en/authentication#authentication-precedence
    anthropicApiKey: z.string().optional(),
    claudeCodeOauthToken: z.string().optional(),

    // --- 4. AWS Bedrock credentials ---

    // Target AWS region for Bedrock. Required when provider=bedrock.
    awsRegion: z.string().optional(),
    // Local dev: AWS SSO profile (after: le aws login -e dev).
    // Passed to the Claude Code subprocess env so the AWS SDK credential chain resolves it.
    awsProfile: z.string().optional(),
    // Explicit key credentials — use in CI/CD or non-SSO environments. Prefer
    // `awsProfile` locally and `awsBearerTokenBedrock` (OIDC) in GitHub Actions.
    awsAccessKeyId: z.string().optional(),
    awsSecretAccessKey: z.string().optional(),
    awsSessionToken: z.string().optional(),
    // OIDC bearer token — set automatically by aws-actions/configure-aws-credentials
    // in GitHub Actions. Do not hand-set in long-running environments.
    awsBearerTokenBedrock: z.string().optional(),
    // Overrides the Bedrock runtime endpoint. Leave unset unless fronting Bedrock
    // with a VPC endpoint or proxy — otherwise the SDK picks the correct regional URL.
    anthropicBedrockBaseUrl: z.string().optional(),

    // --- 5. App runtime / behaviour ---

    // Context7 MCP API key — optional. Unset works but is rate-limited; setting it
    // only lifts the rate limit. Does not change auth mode or tool availability.
    context7ApiKey: z.string().optional(),

    // Parent directory for per-delivery repo clones. Created on boot via
    // mkdir(..., { recursive: true }) in src/core/checkout.ts. Each delivery gets
    // a unique subdir under this path and the subdir is deleted after the run.
    cloneBaseDir: z.string().default("/tmp/bot-workspaces"),

    // Git clone depth for repo checkout. Increase for PRs with deeply diverged branches.
    // Set via CLONE_DEPTH env var (default: 50).
    cloneDepth: z.coerce.number().int().positive().default(50),

    // Mention string that triggers the bot. MUST match the GitHub App's bot login
    // exactly; a mismatch silently drops every webhook event because the trigger
    // matcher returns no hit.
    triggerPhrase: z.string().default("@chrisleekr-bot"),

    // HTTP port for the webhook listener. Independent of `wsPort` (orchestrator WS).
    port: z.coerce.number().int().positive().default(3000),

    // pino log level. Raise to "debug" or "trace" only for short investigations;
    // "debug" surfaces full webhook payloads (contains owner/repo data).
    logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

    // Runtime environment tag. "production" additionally enables the ws:// warning
    // on `orchestratorUrl` (installation tokens + DAEMON_AUTH_TOKEN transit in
    // cleartext on ws://).
    nodeEnv: z.enum(["production", "development", "test"]).default("production"),

    // Limits concurrent Claude agent executions to prevent API budget exhaustion
    // and resource saturation. Set via MAX_CONCURRENT_REQUESTS env var.
    maxConcurrentRequests: z.coerce.number().int().positive().default(3),

    // Wall-clock timeout for a single Claude agent execution in milliseconds.
    // Guards against resource exhaustion from hung model responses or MCP servers.
    // Set via AGENT_TIMEOUT_MS env var (default: 10 minutes).
    agentTimeoutMs: z.coerce.number().int().positive().default(600_000),

    // Override max turns for the Claude Agent SDK. When set, wins over
    // `defaultMaxTurns` but LOSES to triage-derived turns on successful triage.
    // Leave unset to let the complexity → maxTurns mapping decide.
    // Set via AGENT_MAX_TURNS env var.
    agentMaxTurns: z.coerce.number().int().positive().optional(),

    // Absolute path to the Claude Code CLI entry point (cli.js).
    // Required when claude-code is installed globally (e.g. Docker) rather than as a
    // local node_modules dependency, because the SDK defaults to {cwd}/dist/cli.js.
    // Set via CLAUDE_CODE_PATH env var (e.g. /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js).
    claudeCodePath: z.string().optional(),

    // Owner allowlist — when set, the bot only processes events from repositories
    // owned by one of these GitHub accounts (case-insensitive). Empty/unset means
    // no restriction. REQUIRED for single-tenant deployments using
    // CLAUDE_CODE_OAUTH_TOKEN, because the Agent SDK Note prohibits serving other
    // users' repos from a personal subscription quota.
    // See https://code.claude.com/docs/en/agent-sdk/overview
    // Set via ALLOWED_OWNERS env var (comma-separated list, e.g. "chrisleekr,acme").
    allowedOwners: z
      .string()
      .optional()
      .transform((v): string[] | undefined => {
        if (v === undefined || v === "") return undefined;
        const parsed = v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        return parsed.length === 0 ? undefined : parsed;
      }),

    // --- 6. Dispatch mode (Phase 2+, Phase 3 triage-dispatch-modes) ---

    // AGENT_JOB_MODE determines how triggered work is executed platform-wide.
    // "inline" (default) = current behaviour, no external deps needed.
    // "auto" = run the dispatch cascade (label → keyword → triage) per event.
    // Any value other than "inline" activates validateDataLayerConfig, which then
    // requires DATABASE_URL + VALKEY_URL + DAEMON_AUTH_TOKEN.
    // Canonical target names per DispatchTarget enum + "auto" as a mode.
    agentJobMode: z
      .enum(["inline", "daemon", "shared-runner", "isolated-job", "auto"])
      .default("inline"),

    // Per-event fallback when triage is sub-threshold or errored. Must be a
    // concrete DispatchTarget (never "auto"). "inline" is rejected when
    // agentJobMode === "auto" (enforced in superRefine) because falling
    // through to inline defeats the point of opting into auto mode.
    defaultDispatchTarget: z
      .enum(["inline", "daemon", "shared-runner", "isolated-job"])
      .default("shared-runner"),

    // --- 7. K8s Job spawner (isolated-job target) ---

    // K8s namespace for the spawned Job. The spawning pod's ServiceAccount must
    // hold create/get/list/delete on jobs/pods in this namespace or job spawn fails.
    jobNamespace: z.string().default("github-app"),

    // Container image for the isolated-job Pod. When unset, falls back to the
    // literal "github-app-playground:local" (see src/k8s/job-spawner.ts). Must be
    // pullable by the cluster's image registry. Used only by the isolated-job target.
    jobImage: z.string().optional(),

    // K8s Job.ttlSecondsAfterFinished: cluster GC's the Pod after success/failure.
    // Set too low and `kubectl logs <pod>` fails before logs can be retrieved.
    jobTtlSeconds: z.coerce.number().int().positive().default(300),

    // K8s `activeDeadlineSeconds` — hard wall-clock ceiling on an isolated-
    // job run. K8s enforces server-side; the app-side watcher polls status
    // and, on timeout, deletes the Job, writes a `status="timeout"`
    // execution row, and releases the in-flight slot. Keep strictly below
    // the installation-token TTL (GitHub: 3600s).
    jobActiveDeadlineSeconds: z.coerce.number().int().positive().max(3500).default(1800),

    // Client-side poll interval used by `watchJobCompletion`. Too-frequent
    // polling burns K8s API budget; too-slow polling delays releaseInFlight
    // past true completion and causes the capacity gate to under-provision.
    jobWatchPollIntervalMs: z.coerce.number().int().positive().default(5000),

    // --- 8. Shared-runner HTTP target ---

    // Internal HTTP endpoint for the shared-runner pool. Required when
    // agentJobMode is "shared-runner" or "auto" (enforced in superRefine).
    internalRunnerUrl: z.url().optional(),

    // Bearer token sent on `X-Internal-Token` by the dispatcher and validated by
    // the shared-runner's own middleware (src/k8s/shared-runner-dispatcher.ts).
    // Rotating this requires restarting both sides; the dispatcher caches it at boot.
    internalRunnerToken: z.string().optional(),

    // ADR-011 reserved slot for a future second token (e.g. signed JWT).
    // Declared in the schema but NO CODE PATH READS IT today — not referenced
    // by any refinement and not consumed by the shared-runner dispatcher.
    // `internalRunnerToken` is the working knob; setting a value here has no
    // runtime effect.
    sharedRunnerToken: z.string().optional(),

    // --- 9. Data layer ---

    // Required iff agentJobMode !== "inline" (see validateDataLayerConfig).
    // `valkeyUrl` backs the isolated-job pending queue + in-flight set and the
    // daemon job queue. `databaseUrl` backs the `executions` + `triage_results`
    // + `dispatch_decisions` tables.
    valkeyUrl: z.string().optional(),
    databaseUrl: z.string().optional(),

    // --- 10. Orchestrator ---

    // Orchestrator WebSocket listener port. Bound ONLY in server mode
    // (src/orchestrator/ws-server.ts). Daemons connect OUT to this port; they do
    // not bind. Must differ from `port` to avoid a collision in single-process mode.
    wsPort: z.coerce.number().int().positive().default(3002),

    // Placeholder — captured on the result row but NEVER CHECKED OR ENFORCED today.
    // Setting this does nothing in the current codebase.
    jobMaxCostUsd: z.coerce.number().positive().default(80),

    // --- 11. Daemon / Orchestrator WebSocket (Phase 2) ---

    // Shared secret for the daemon ⇄ orchestrator WebSocket handshake. A mismatch
    // on either side rejects the connection. Required when agentJobMode !== "inline".
    daemonAuthToken: z.string().optional(),

    // Presence of ORCHESTRATOR_URL flips the process from SERVER mode to
    // DAEMON mode: the webhook HTTP server does NOT start and GitHub App
    // credentials are not required. Must be ws:// or wss:// (validated below).
    orchestratorUrl: z
      .string()
      .optional()
      .refine((value) => {
        if (value === undefined || value === "") return true;
        try {
          const url = new URL(value);
          return url.protocol === "ws:" || url.protocol === "wss:";
        } catch {
          return false;
        }
      }, "ORCHESTRATOR_URL must be a valid ws:// or wss:// URL"),

    // Daemon ping cadence. Paired with heartbeatTimeoutMs — orchestrator evicts
    // a daemon that misses heartbeats past the timeout. Keep `timeoutMs ≥ 2 ×
    // intervalMs` to tolerate one dropped packet.
    heartbeatIntervalMs: z.coerce.number().int().positive().default(30_000),
    heartbeatTimeoutMs: z.coerce.number().int().positive().default(90_000),

    // How long an execution may sit in status="running" before the watcher treats
    // it as abandoned and marks it failed. Must exceed agentTimeoutMs.
    staleExecutionThresholdMs: z.coerce.number().int().positive().default(600_000),

    // Post-SIGTERM window the daemon uses to finish in-flight work before
    // force-exit. Set ≥ agentTimeoutMs to avoid mid-run kills on graceful shutdown.
    daemonDrainTimeoutMs: z.coerce.number().int().positive().default(300_000),

    // Retries for TRANSIENT daemon dispatch failures only. FR-021 forbids retry
    // on isolated-job failures, so the isolated-job path ignores this knob entirely.
    jobMaxRetries: z.coerce.number().int().nonnegative().default(3),

    // How long the orchestrator waits for a daemon in the pool to claim a job
    // offer before falling through to the next dispatch target.
    offerTimeoutMs: z.coerce.number().int().positive().default(5_000),

    // Advisory hint REPORTED to the orchestrator after an update signal. The
    // daemon itself always calls initiateGracefulShutdown() regardless of value
    // (src/daemon/main.ts) — the orchestrator is the actual consumer.
    daemonUpdateStrategy: z.enum(["exit", "pull", "notify"]).default("exit"),

    // Delay before the daemon initiates shutdown after receiving an update signal.
    // Gives the orchestrator room to drain in-flight offers before the daemon disconnects.
    daemonUpdateDelayMs: z.coerce.number().int().nonnegative().default(0),

    // Placeholder — declared in the schema but NEVER READ anywhere in code.
    // Setting true/false has no runtime effect today.
    daemonEphemeral: z.boolean().default(false),

    // Minimum free resource gates published in the daemon's heartbeat. The
    // orchestrator refuses to dispatch to a daemon that reports below either floor.
    daemonMemoryFloorMb: z.coerce.number().int().nonnegative().default(512),
    daemonDiskFloorMb: z.coerce.number().int().nonnegative().default(1024),

    // --- 12. Triage pre-classifier (auto mode) ---

    // Kill-switch for the triage LLM call. When false, the router skips the call
    // and falls back to defaultDispatchTarget with dispatchReason="triage-error-fallback"
    // (src/orchestrator/triage.ts). Flip to false during a triage provider incident
    // to suppress cost without redeploying.
    triageEnabled: z.boolean().default(true),

    // Model ID for the single-turn triage call via src/ai/llm-client.ts. Affects
    // triage latency/cost only — does NOT change the main agent's model.
    triageModel: z.string().default("haiku-3-5"),

    // Per /speckit.clarify Q5 — strict (1.0) on day 1 so only perfectly
    // confident triage decisions are accepted; below threshold falls back
    // to defaultDispatchTarget.
    triageConfidenceThreshold: z.coerce.number().min(0).max(1).default(1.0),

    // Cap on the triage JSON response. The response schema is small (~60 tokens),
    // so values much above 100 are waste and only risk letting a malformed
    // response chew budget.
    triageMaxTokens: z.coerce.number().int().positive().default(256),

    // Hard cap per triage LLM call. Beyond this, the call is treated as a
    // failure and the circuit breaker's consecutive-failure counter increments.
    triageTimeoutMs: z.coerce.number().int().positive().default(5_000),

    // --- 13. Complexity → maxTurns mapping (FR-008a) ---
    // Applied ONLY when triage succeeds AND confidence ≥ threshold. Otherwise
    // the router uses agentMaxTurns (if set) else defaultMaxTurns.
    // Each env var is independently operator-configurable.
    triageMaxTurnsTrivial: z.coerce.number().int().positive().default(10),
    triageMaxTurnsModerate: z.coerce.number().int().positive().default(30),
    triageMaxTurnsComplex: z.coerce.number().int().positive().default(50),
    defaultMaxTurns: z.coerce.number().int().positive().default(30),

    // --- 14. Isolated-job capacity back-pressure (FR-018, US3) ---

    // Ceiling on the Redis set dispatch:isolated-job:in-flight. Requests
    // above this cap enqueue on the pending list (below) until a slot frees.
    maxConcurrentIsolatedJobs: z.coerce.number().int().positive().default(3),
    // Max length of the pending Valkey list. When full, new isolated-job
    // requests are rejected outright (no silent downgrade).
    pendingIsolatedJobQueueMax: z.coerce.number().int().positive().default(20),
  })
  .superRefine((data, ctx) => {
    validateServerModeCredentials(data, ctx);
    validateProviderCredentials(data, ctx);
    validateDataLayerConfig(data, ctx);
    validateAutoModeDefault(data, ctx);
    validateSharedRunnerAuth(data, ctx);
  });

/**
 * Validate GitHub App credentials are present in server mode.
 * Daemon mode (ORCHESTRATOR_URL set) does not require these.
 */
function validateServerModeCredentials(
  data: {
    orchestratorUrl?: string | undefined;
    appId?: string | undefined;
    privateKey?: string | undefined;
    webhookSecret?: string | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  const isDaemonMode = (data.orchestratorUrl?.trim().length ?? 0) > 0;
  if (isDaemonMode) return;

  if ((data.appId?.trim().length ?? 0) === 0) {
    ctx.addIssue({
      code: "custom",
      message: "GITHUB_APP_ID is required in server mode (when ORCHESTRATOR_URL is not set)",
      path: ["appId"],
    });
  }
  if ((data.privateKey?.trim().length ?? 0) === 0) {
    ctx.addIssue({
      code: "custom",
      message:
        "GITHUB_APP_PRIVATE_KEY is required in server mode (when ORCHESTRATOR_URL is not set)",
      path: ["privateKey"],
    });
  }
  if ((data.webhookSecret?.trim().length ?? 0) === 0) {
    ctx.addIssue({
      code: "custom",
      message:
        "GITHUB_WEBHOOK_SECRET is required in server mode (when ORCHESTRATOR_URL is not set)",
      path: ["webhookSecret"],
    });
  }
}

/**
 * Validate provider-specific credentials.
 * Anthropic requires API key or OAuth token; Bedrock requires region and model.
 */
function validateProviderCredentials(
  data: {
    provider: string;
    anthropicApiKey?: string | undefined;
    claudeCodeOauthToken?: string | undefined;
    awsRegion?: string | undefined;
    model?: string | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (data.provider === "anthropic") {
    // Direct Anthropic API requires a non-empty credential:
    //   - ANTHROPIC_API_KEY (Console pay-as-you-go), OR
    //   - CLAUDE_CODE_OAUTH_TOKEN (Max/Pro subscription, sk-ant-oat... prefix)
    const hasApiKey = (data.anthropicApiKey?.trim().length ?? 0) > 0;
    const hasOauthToken = (data.claudeCodeOauthToken?.trim().length ?? 0) > 0;
    if (!hasApiKey && !hasOauthToken) {
      ctx.addIssue({
        code: "custom",
        message:
          "When CLAUDE_PROVIDER=anthropic, either ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN is required.",
        path: ["anthropicApiKey"],
      });
    }
  } else {
    // Bedrock requires region and model ID
    if (data.awsRegion === undefined || data.awsRegion === "") {
      ctx.addIssue({
        code: "custom",
        message: "AWS_REGION is required when CLAUDE_PROVIDER=bedrock",
        path: ["awsRegion"],
      });
    }
    if (data.model === undefined) {
      ctx.addIssue({
        code: "custom",
        message:
          "CLAUDE_MODEL is required when CLAUDE_PROVIDER=bedrock (e.g. us.anthropic.claude-sonnet-4-6)",
        path: ["model"],
      });
    }
  }
}

/**
 * Validate data layer requirements for non-inline dispatch modes.
 * Inline mode (default) needs neither — zero behaviour change until opted in.
 */
function validateDataLayerConfig(
  data: {
    agentJobMode: string;
    databaseUrl?: string | undefined;
    valkeyUrl?: string | undefined;
    daemonAuthToken?: string | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (data.agentJobMode === "inline") return;

  if ((data.databaseUrl?.trim().length ?? 0) === 0) {
    ctx.addIssue({
      code: "custom",
      message: "DATABASE_URL is required when AGENT_JOB_MODE is not 'inline'",
      path: ["databaseUrl"],
    });
  }
  if ((data.valkeyUrl?.trim().length ?? 0) === 0) {
    ctx.addIssue({
      code: "custom",
      message: "VALKEY_URL is required when AGENT_JOB_MODE is not 'inline'",
      path: ["valkeyUrl"],
    });
  }
  if ((data.daemonAuthToken?.trim().length ?? 0) === 0) {
    ctx.addIssue({
      code: "custom",
      message: "DAEMON_AUTH_TOKEN is required when AGENT_JOB_MODE is not 'inline'",
      path: ["daemonAuthToken"],
    });
  }
}

/**
 * Auto mode must fall back to a real dispatch target, not inline. Otherwise
 * ambiguous events that can't be triaged silently revert to inline execution,
 * defeating the whole point of opting into auto mode.
 */
function validateAutoModeDefault(
  data: { agentJobMode: string; defaultDispatchTarget: string },
  ctx: z.RefinementCtx,
): void {
  if (data.agentJobMode === "auto" && data.defaultDispatchTarget === "inline") {
    ctx.addIssue({
      code: "custom",
      message:
        "DEFAULT_DISPATCH_TARGET cannot be 'inline' when AGENT_JOB_MODE is 'auto' " +
        "(falling back to inline defeats auto-dispatch). Set to daemon, shared-runner, or isolated-job.",
      path: ["defaultDispatchTarget"],
    });
  }
}

/**
 * Shared-runner target requires both the HTTP URL and the shared bearer token.
 * "auto" mode can route to shared-runner, so the same requirement applies.
 */
function validateSharedRunnerAuth(
  data: {
    agentJobMode: string;
    internalRunnerUrl?: string | undefined;
    internalRunnerToken?: string | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  const requiresSharedRunner =
    data.agentJobMode === "shared-runner" || data.agentJobMode === "auto";
  if (!requiresSharedRunner) return;

  if ((data.internalRunnerUrl?.trim().length ?? 0) === 0) {
    ctx.addIssue({
      code: "custom",
      message: "INTERNAL_RUNNER_URL is required when AGENT_JOB_MODE is 'shared-runner' or 'auto'",
      path: ["internalRunnerUrl"],
    });
  }
  if ((data.internalRunnerToken?.trim().length ?? 0) === 0) {
    ctx.addIssue({
      code: "custom",
      message: "INTERNAL_RUNNER_TOKEN is required when AGENT_JOB_MODE is 'shared-runner' or 'auto'",
      path: ["internalRunnerToken"],
    });
  }
}

export type Config = z.infer<typeof configSchema>;

// Export schema for use in tests (avoids importing the singleton which runs loadConfig())
export { configSchema };

/**
 * Isolated-job dispatch requires Kubernetes API auth — either in-cluster
 * (KUBERNETES_SERVICE_HOST injected by the pod spec) or out-of-cluster
 * (KUBECONFIG path to a kubeconfig file). If neither is present when the
 * platform is configured to use the isolated-job target, log a warning at
 * startup: the app still starts (other targets work), but isolated-job
 * dispatches will be rejected at runtime per FR-018. A warning beats a hard
 * error because single-target deployments shouldn't be blocked by unused
 * target misconfiguration.
 */
export function warnIfIsolatedJobWithoutKubernetesAuth(cfg: Config): void {
  const needsKubernetesAuth = cfg.agentJobMode === "isolated-job" || cfg.agentJobMode === "auto";
  if (!needsKubernetesAuth) return;

  const inCluster = (process.env["KUBERNETES_SERVICE_HOST"]?.trim().length ?? 0) > 0;
  const hasKubeconfig = (process.env["KUBECONFIG"]?.trim().length ?? 0) > 0;
  if (inCluster || hasKubeconfig) return;

  console.warn(
    `[config] WARNING: AGENT_JOB_MODE=${cfg.agentJobMode} enables the isolated-job target, ` +
      "but neither KUBERNETES_SERVICE_HOST (in-cluster) nor KUBECONFIG (out-of-cluster) is set. " +
      "isolated-job dispatches will be rejected at runtime with dispatch_reason='infra-absent'.",
  );
}

/**
 * ToS guard: CLAUDE_CODE_OAUTH_TOKEN is a personal Max/Pro subscription credential.
 * The Agent SDK Note prohibits serving other users' repos from that quota, so OAuth
 * mode requires an owner allowlist as a hard startup precondition — not just a
 * documentation warning. API-key deployments remain unrestricted (in-policy for
 * pay-as-you-go). See https://code.claude.com/docs/en/agent-sdk/overview
 *
 * Lives outside `.superRefine` so the schema stays lean and the policy rule is
 * expressed as one clear assertion — exported so tests can exercise it directly
 * against a parsed `Config` without round-tripping env vars.
 */
export function assertOauthRequiresAllowlist(cfg: Config): void {
  if (
    cfg.provider === "anthropic" &&
    (cfg.claudeCodeOauthToken?.trim().length ?? 0) > 0 &&
    cfg.allowedOwners?.length !== 1
  ) {
    throw new Error(
      "ALLOWED_OWNERS must contain exactly one owner when CLAUDE_CODE_OAUTH_TOKEN is set. " +
        "See https://code.claude.com/docs/en/agent-sdk/overview",
    );
  }
}

/**
 * Parse a boolean environment variable strictly.
 * Accepts: true/false, 1/0, yes/no (case-insensitive).
 * Throws on unrecognized values to prevent silent misconfiguration.
 */
export function parseBooleanEnv(name: string, raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.trim().toLowerCase();

  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;

  throw new Error(`${name} must be one of: true, false, 1, 0, yes, no. Got: ${raw}`);
}

/**
 * Parse and validate config from environment variables.
 * Throws on invalid/missing required values -- fail fast at startup.
 */
function loadConfig(): Config {
  const cfg = configSchema.parse({
    // Group 1 — GitHub App credentials
    appId: process.env["GITHUB_APP_ID"],
    privateKey: process.env["GITHUB_APP_PRIVATE_KEY"],
    webhookSecret: process.env["GITHUB_WEBHOOK_SECRET"],

    // Group 2 — AI provider selection
    provider: process.env["CLAUDE_PROVIDER"],
    model: process.env["CLAUDE_MODEL"],

    // Group 3 — Anthropic direct-API credentials
    anthropicApiKey: process.env["ANTHROPIC_API_KEY"],
    claudeCodeOauthToken: process.env["CLAUDE_CODE_OAUTH_TOKEN"],

    // Group 4 — AWS Bedrock credentials
    awsRegion: process.env["AWS_REGION"],
    awsProfile: process.env["AWS_PROFILE"],
    awsAccessKeyId: process.env["AWS_ACCESS_KEY_ID"],
    awsSecretAccessKey: process.env["AWS_SECRET_ACCESS_KEY"],
    awsSessionToken: process.env["AWS_SESSION_TOKEN"],
    awsBearerTokenBedrock: process.env["AWS_BEARER_TOKEN_BEDROCK"],
    anthropicBedrockBaseUrl: process.env["ANTHROPIC_BEDROCK_BASE_URL"],

    // Group 5 — App runtime / behaviour
    context7ApiKey: process.env["CONTEXT7_API_KEY"],
    cloneBaseDir: process.env["CLONE_BASE_DIR"],
    cloneDepth: process.env["CLONE_DEPTH"],
    triggerPhrase: process.env["TRIGGER_PHRASE"],
    port: process.env["PORT"],
    logLevel: process.env["LOG_LEVEL"],
    nodeEnv: process.env.NODE_ENV,
    maxConcurrentRequests: process.env["MAX_CONCURRENT_REQUESTS"],
    agentTimeoutMs: process.env["AGENT_TIMEOUT_MS"],
    agentMaxTurns: process.env["AGENT_MAX_TURNS"],
    claudeCodePath: process.env["CLAUDE_CODE_PATH"],
    allowedOwners: process.env["ALLOWED_OWNERS"],

    // Group 6 — Dispatch mode
    agentJobMode: process.env["AGENT_JOB_MODE"],
    defaultDispatchTarget: process.env["DEFAULT_DISPATCH_TARGET"],

    // Group 7 — K8s Job spawner (isolated-job target)
    jobNamespace: process.env["JOB_NAMESPACE"],
    jobImage: process.env["JOB_IMAGE"],
    jobTtlSeconds: process.env["JOB_TTL_SECONDS"],
    jobActiveDeadlineSeconds: process.env["JOB_ACTIVE_DEADLINE_SECONDS"],
    jobWatchPollIntervalMs: process.env["JOB_WATCH_POLL_INTERVAL_MS"],

    // Group 8 — Shared-runner HTTP target
    internalRunnerUrl: process.env["INTERNAL_RUNNER_URL"],
    internalRunnerToken: process.env["INTERNAL_RUNNER_TOKEN"],
    sharedRunnerToken: process.env["SHARED_RUNNER_TOKEN"],

    // Group 9 — Data layer
    valkeyUrl: process.env["VALKEY_URL"],
    databaseUrl: process.env["DATABASE_URL"],

    // Group 10 — Orchestrator
    wsPort: process.env["WS_PORT"],
    jobMaxCostUsd: process.env["JOB_MAX_COST_USD"],

    // Group 11 — Daemon / Orchestrator WebSocket
    daemonAuthToken: process.env["DAEMON_AUTH_TOKEN"],
    orchestratorUrl: process.env["ORCHESTRATOR_URL"],
    heartbeatIntervalMs: process.env["HEARTBEAT_INTERVAL_MS"],
    heartbeatTimeoutMs: process.env["HEARTBEAT_TIMEOUT_MS"],
    staleExecutionThresholdMs: process.env["STALE_EXECUTION_THRESHOLD_MS"],
    daemonDrainTimeoutMs: process.env["DAEMON_DRAIN_TIMEOUT_MS"],
    jobMaxRetries: process.env["JOB_MAX_RETRIES"],
    offerTimeoutMs: process.env["OFFER_TIMEOUT_MS"],
    daemonUpdateStrategy: process.env["DAEMON_UPDATE_STRATEGY"],
    daemonUpdateDelayMs: process.env["DAEMON_UPDATE_DELAY_MS"],
    daemonEphemeral: parseBooleanEnv("DAEMON_EPHEMERAL", process.env["DAEMON_EPHEMERAL"]),
    daemonMemoryFloorMb: process.env["DAEMON_MEMORY_FLOOR_MB"],
    daemonDiskFloorMb: process.env["DAEMON_DISK_FLOOR_MB"],

    // Group 12 — Triage — strict boolean parsing; rejects unrecognized values at startup.
    triageEnabled: parseBooleanEnv("TRIAGE_ENABLED", process.env["TRIAGE_ENABLED"]),
    triageModel: process.env["TRIAGE_MODEL"],
    triageConfidenceThreshold: process.env["TRIAGE_CONFIDENCE_THRESHOLD"],
    triageMaxTokens: process.env["TRIAGE_MAX_TOKENS"],
    triageTimeoutMs: process.env["TRIAGE_TIMEOUT_MS"],

    // Group 13 — Complexity → maxTurns (FR-008a)
    triageMaxTurnsTrivial: process.env["TRIAGE_MAXTURNS_TRIVIAL"],
    triageMaxTurnsModerate: process.env["TRIAGE_MAXTURNS_MODERATE"],
    triageMaxTurnsComplex: process.env["TRIAGE_MAXTURNS_COMPLEX"],
    defaultMaxTurns: process.env["DEFAULT_MAXTURNS"],

    // Group 14 — Isolated-job capacity back-pressure (US3)
    maxConcurrentIsolatedJobs: process.env["MAX_CONCURRENT_ISOLATED_JOBS"],
    pendingIsolatedJobQueueMax: process.env["PENDING_ISOLATED_JOB_QUEUE_MAX"],
  });
  assertOauthRequiresAllowlist(cfg);
  warnIfIsolatedJobWithoutKubernetesAuth(cfg);

  // H6: Warn when WebSocket URLs use unencrypted ws:// in production.
  // Installation tokens and DAEMON_AUTH_TOKEN are transmitted over this connection.
  if (cfg.nodeEnv === "production") {
    if (cfg.orchestratorUrl?.startsWith("ws://") === true) {
      console.warn(
        "[config] WARNING: ORCHESTRATOR_URL uses ws:// (unencrypted) in production. " +
          "Installation tokens and DAEMON_AUTH_TOKEN are transmitted in cleartext. Use wss:// for production.",
      );
    }
  }

  return cfg;
}

export const config = loadConfig();
