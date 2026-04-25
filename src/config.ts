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
    // optional input for anthropic. The schema-level .transform below defaults the
    // anthropic path to "claude-opus-4-7", so the inferred Config.model is `string`
    // (not `string | undefined`) — consumers do not need to handle the undefined case.
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
    // Default 60 minutes — implement / review steps on non-trivial issues
    // routinely take 30-50 min of real work; capping shorter cuts the agent
    // off mid-task and loses progress. Hung-process risk is bounded by
    // container resource limits, not this number. Set AGENT_TIMEOUT_MS lower
    // for testing or smaller-scope deployments.
    agentTimeoutMs: z.coerce.number().int().positive().default(3_600_000),

    // Override max turns for the Claude Agent SDK, used as a FALLBACK ONLY on
    // src/core/executor.ts when invoked without an explicit `maxTurns`
    // argument. Since the dispatch-collapse, the orchestrator always passes
    // `config.defaultMaxTurns` to the daemon, so this knob only affects
    // non-dispatched internal callers.
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

    // --- 6. Data layer (mandatory in server mode) ---

    // `valkeyUrl` backs the daemon job queue. `databaseUrl` backs the
    // `executions` + `triage_results` tables. Both are required in server
    // mode (no ORCHESTRATOR_URL) and optional in daemon mode (the daemon
    // talks to the orchestrator over WebSocket, not to the data layer).
    valkeyUrl: z.string().optional(),
    databaseUrl: z.string().optional(),

    // --- 7. Orchestrator ---

    // Orchestrator WebSocket listener port. Bound ONLY in server mode
    // (src/orchestrator/ws-server.ts). Daemons connect OUT to this port; they do
    // not bind. Must differ from `port` to avoid a collision in single-process mode.
    wsPort: z.coerce.number().int().positive().default(3002),

    // --- 8. Daemon / Orchestrator WebSocket ---

    // Shared secret for the daemon ⇄ orchestrator WebSocket handshake. A mismatch
    // on either side rejects the connection. Required on both sides.
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
    // it as abandoned and marks it failed. Should generally be ≥ agentTimeoutMs
    // so a legitimate long run isn't reaped mid-flight; the built-in default
    // equals agentTimeoutMs (both 3_600_000ms / 60 min), which is the minimum
    // safe setting.
    staleExecutionThresholdMs: z.coerce.number().int().positive().default(3_600_000),

    // Post-SIGTERM window the daemon uses to finish in-flight work before
    // force-exit. The default (300_000ms) is intentionally shorter than
    // agentTimeoutMs — operators who want to guarantee no mid-run kills on
    // graceful shutdown should raise this to ≥ agentTimeoutMs.
    daemonDrainTimeoutMs: z.coerce.number().int().positive().default(300_000),

    // Retries for TRANSIENT daemon dispatch failures only.
    jobMaxRetries: z.coerce.number().int().nonnegative().default(3),

    // How long the orchestrator waits for a daemon in the fleet to claim a
    // job offer before re-queueing it for another daemon to pick up.
    offerTimeoutMs: z.coerce.number().int().positive().default(5_000),

    // Maximum sleep between queue-worker iterations when a leased job has no
    // locally-connected capable daemon and is re-pushed for another instance
    // to claim. Backoff doubles per retry attempt; this caps it.
    queueWorkerBackoffMaxMs: z.coerce.number().int().positive().default(5_000),

    // Cadence of the heartbeat-based liveness reaper (src/orchestrator/
    // liveness-reaper.ts). On each tick the reaper scans Valkey for live
    // orchestrator + daemon heartbeats and fails any in-flight workflow_runs
    // row whose owner heartbeat is missing. Replaces the prior
    // time-threshold daemons reaper (5-minute blind window).
    //
    // Min sane value is the orchestrator heartbeat refresh interval (20s);
    // below that, a heartbeat momentarily not yet republished could trigger
    // a false reap.
    livenessReaperIntervalMs: z.coerce.number().int().min(20_000).default(30_000),

    // Advisory hint REPORTED to the orchestrator after an update signal. The
    // daemon itself always calls initiateGracefulShutdown() regardless of value
    // (src/daemon/main.ts) — the orchestrator is the actual consumer.
    daemonUpdateStrategy: z.enum(["exit", "pull", "notify"]).default("exit"),

    // Delay before the daemon initiates shutdown after receiving an update signal.
    // Gives the orchestrator room to drain in-flight offers before the daemon disconnects.
    daemonUpdateDelayMs: z.coerce.number().int().nonnegative().default(0),

    // Minimum free resource gates published in the daemon's heartbeat. The
    // orchestrator refuses to dispatch to a daemon that reports below either floor.
    daemonMemoryFloorMb: z.coerce.number().int().nonnegative().default(512),
    daemonDiskFloorMb: z.coerce.number().int().nonnegative().default(1024),

    // --- 9. Ephemeral daemon (K8s-spawned scale-up) ---

    // When true, this daemon process treats itself as ephemeral — it exits
    // cleanly after `ephemeralDaemonIdleTimeoutMs` of idleness. Set on
    // orchestrator-spawned Pods via `DAEMON_EPHEMERAL=true`; leave unset on
    // persistent daemons.
    daemonEphemeral: z.boolean().default(false),

    // Idle-exit timeout for ephemeral daemons. After this much wall-clock time
    // with zero active jobs, the ephemeral daemon shuts down and the Pod is
    // reclaimed by K8s. Capped below the Pod's default
    // `activeDeadlineSeconds` (3600s = 3_600_000ms, see
    // `src/k8s/ephemeral-daemon-spawner.ts`) minus a 10-minute safety
    // margin so a still-running job cannot be killed by K8s before the
    // idle loop gets a chance to exit gracefully.
    ephemeralDaemonIdleTimeoutMs: z.coerce
      .number()
      .int()
      .positive()
      .max(3_000_000, "EPHEMERAL_DAEMON_IDLE_TIMEOUT_MS must be < 3_000_000 (50 min)")
      .default(120_000),

    // Minimum interval between ephemeral-daemon spawns (orchestrator side).
    // Prevents a burst of events from launching a burst of Pods.
    ephemeralDaemonSpawnCooldownMs: z.coerce.number().int().nonnegative().default(30_000),

    // Queue depth that, when combined with a saturated persistent pool, triggers
    // an overflow spawn. Scaled down for dev / scaled up for fleets with large
    // burst headroom.
    ephemeralDaemonSpawnQueueThreshold: z.coerce.number().int().positive().default(3),

    // K8s namespace into which the orchestrator spawns ephemeral-daemon Pods.
    // The orchestrator's ServiceAccount must hold `create/get/delete` on pods
    // in this namespace.
    ephemeralDaemonNamespace: z.string().default("default"),

    // Container image the orchestrator launches for ephemeral daemons. Should
    // match the tag the persistent daemon Deployment is running. Optional at
    // startup — only required when an ephemeral spawn is actually triggered;
    // the router reports `ephemeral-spawn-failed` if unset.
    daemonImage: z.string().optional(),

    // Public ws:// / wss:// URL the ephemeral daemon uses to reach this
    // orchestrator. Distinct from `orchestratorUrl` (which is the daemon-side
    // dial target when this process is itself a daemon). Optional at startup
    // for the same reason as `daemonImage`.
    orchestratorPublicUrl: z
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
      }, "ORCHESTRATOR_PUBLIC_URL must be a valid ws:// or wss:// URL"),

    // --- 10. Triage (binary heavy classifier) ---

    // Kill-switch for the triage LLM call. When false, the router skips the call
    // and the scaler sees `heavy === false`.
    triageEnabled: z.boolean().default(true),

    // Model ID for the single-turn triage call via src/ai/llm-client.ts. Affects
    // triage latency/cost only — does NOT change the main agent's model.
    triageModel: z.string().default("haiku-3-5"),

    // Strict (1.0) on day 1 so only perfectly confident triage decisions are
    // accepted; below threshold, the scaler falls back to persistent-daemon routing.
    triageConfidenceThreshold: z.coerce.number().min(0).max(1).default(1.0),

    // Cap on the triage JSON response. The response schema is small (~60 tokens),
    // so values much above 100 are waste and only risk letting a malformed
    // response chew budget.
    triageMaxTokens: z.coerce.number().int().positive().default(256),

    // Hard cap per triage LLM call. Beyond this, the call is treated as a
    // failure and the circuit breaker's consecutive-failure counter increments.
    triageTimeoutMs: z.coerce.number().int().positive().default(5_000),

    // Minimum model confidence to accept an intent-classifier verdict. Below
    // this threshold the dispatcher treats the comment as ambiguous and posts
    // a clarification request instead of dispatching (FR-009). 0.75 matches
    // the SC-005 target accuracy band.
    intentConfidenceThreshold: z.coerce.number().min(0).max(1).default(0.75),

    // --- 11. Agent maxTurns ---

    // Optional turn cap. Unset by default so workflows run end-to-end without
    // losing progress to a mid-run cap. Set DEFAULT_MAXTURNS only when ops
    // needs a hard ceiling. AGENT_MAX_TURNS overrides this when both are set.
    defaultMaxTurns: z.coerce.number().int().positive().optional(),
  })
  .superRefine((data, ctx) => {
    validateServerModeCredentials(data, ctx);
    validateProviderCredentials(data, ctx);
    validateDataLayerConfig(data, ctx);
  })
  // Runs only if .superRefine added no issues, so by this point:
  //   - provider=bedrock guarantees data.model is defined
  //     (validateProviderCredentials errors otherwise)
  //   - provider=anthropic falls through with data.model possibly undefined
  // We default the anthropic branch to Opus 4.7 here. Doing it in .transform
  // narrows the inferred Config type: `model` becomes `string`, not
  // `string | undefined`, so downstream code drops the defensive `?.` / `??`.
  // Override via CLAUDE_MODEL when cost-sensitive.
  .transform((data) => ({
    ...data,
    model: data.model ?? "claude-opus-4-7",
  }));

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
 * After the dispatch-to-daemon collapse, every server-mode process needs
 * the data layer (DB + Valkey + DAEMON_AUTH_TOKEN) to orchestrate the
 * daemon fleet. Daemon-mode processes only need DAEMON_AUTH_TOKEN for the
 * WebSocket handshake.
 */
function validateDataLayerConfig(
  data: {
    orchestratorUrl?: string | undefined;
    databaseUrl?: string | undefined;
    valkeyUrl?: string | undefined;
    daemonAuthToken?: string | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  const isDaemonMode = (data.orchestratorUrl?.trim().length ?? 0) > 0;

  if ((data.daemonAuthToken?.trim().length ?? 0) === 0) {
    ctx.addIssue({
      code: "custom",
      message: "DAEMON_AUTH_TOKEN is required (set on both orchestrator and daemon)",
      path: ["daemonAuthToken"],
    });
  }

  if (isDaemonMode) return;

  if ((data.databaseUrl?.trim().length ?? 0) === 0) {
    ctx.addIssue({
      code: "custom",
      message: "DATABASE_URL is required in server mode",
      path: ["databaseUrl"],
    });
  }
  if ((data.valkeyUrl?.trim().length ?? 0) === 0) {
    ctx.addIssue({
      code: "custom",
      message: "VALKEY_URL is required in server mode",
      path: ["valkeyUrl"],
    });
  }
}

export type Config = z.infer<typeof configSchema>;

// Export schema for use in tests (avoids importing the singleton which runs loadConfig())
export { configSchema };

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
    // Normalize literal "\n" escape sequences to real newlines. K8s Secrets
    // populated from SETUP.md's single-line `"---BEGIN---\n...\n---END---"`
    // pattern decode to bytes that contain backslash+n, not 0x0a, which
    // trips Node's createPrivateKey with ERR_OSSL_BAD_END_LINE (issue #7).
    // Idempotent: real newlines do not match /\\n/.
    privateKey: process.env["GITHUB_APP_PRIVATE_KEY"]?.replace(/\\n/g, "\n"),
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

    // Group 6 — Data layer
    valkeyUrl: process.env["VALKEY_URL"],
    databaseUrl: process.env["DATABASE_URL"],

    // Group 7 — Orchestrator
    wsPort: process.env["WS_PORT"],

    // Group 8 — Daemon / Orchestrator WebSocket
    daemonAuthToken: process.env["DAEMON_AUTH_TOKEN"],
    orchestratorUrl: process.env["ORCHESTRATOR_URL"],
    heartbeatIntervalMs: process.env["HEARTBEAT_INTERVAL_MS"],
    heartbeatTimeoutMs: process.env["HEARTBEAT_TIMEOUT_MS"],
    staleExecutionThresholdMs: process.env["STALE_EXECUTION_THRESHOLD_MS"],
    daemonDrainTimeoutMs: process.env["DAEMON_DRAIN_TIMEOUT_MS"],
    jobMaxRetries: process.env["JOB_MAX_RETRIES"],
    offerTimeoutMs: process.env["OFFER_TIMEOUT_MS"],
    queueWorkerBackoffMaxMs: process.env["QUEUE_WORKER_BACKOFF_MAX_MS"],
    livenessReaperIntervalMs: process.env["LIVENESS_REAPER_INTERVAL_MS"],
    daemonUpdateStrategy: process.env["DAEMON_UPDATE_STRATEGY"],
    daemonUpdateDelayMs: process.env["DAEMON_UPDATE_DELAY_MS"],
    daemonMemoryFloorMb: process.env["DAEMON_MEMORY_FLOOR_MB"],
    daemonDiskFloorMb: process.env["DAEMON_DISK_FLOOR_MB"],

    // Group 9 — Ephemeral daemon (K8s-spawned scale-up)
    daemonEphemeral: parseBooleanEnv("DAEMON_EPHEMERAL", process.env["DAEMON_EPHEMERAL"]),
    ephemeralDaemonIdleTimeoutMs: process.env["EPHEMERAL_DAEMON_IDLE_TIMEOUT_MS"],
    ephemeralDaemonSpawnCooldownMs: process.env["EPHEMERAL_DAEMON_SPAWN_COOLDOWN_MS"],
    ephemeralDaemonSpawnQueueThreshold: process.env["EPHEMERAL_DAEMON_SPAWN_QUEUE_THRESHOLD"],
    ephemeralDaemonNamespace: process.env["EPHEMERAL_DAEMON_NAMESPACE"],
    daemonImage: process.env["DAEMON_IMAGE"],
    orchestratorPublicUrl: process.env["ORCHESTRATOR_PUBLIC_URL"],

    // Group 10 — Triage — strict boolean parsing; rejects unrecognized values at startup.
    triageEnabled: parseBooleanEnv("TRIAGE_ENABLED", process.env["TRIAGE_ENABLED"]),
    triageModel: process.env["TRIAGE_MODEL"],
    triageConfidenceThreshold: process.env["TRIAGE_CONFIDENCE_THRESHOLD"],
    triageMaxTokens: process.env["TRIAGE_MAX_TOKENS"],
    triageTimeoutMs: process.env["TRIAGE_TIMEOUT_MS"],
    intentConfidenceThreshold: process.env["INTENT_CONFIDENCE_THRESHOLD"],

    // Group 11 — Agent maxTurns
    defaultMaxTurns: process.env["DEFAULT_MAXTURNS"],
  });

  assertOauthRequiresAllowlist(cfg);

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
