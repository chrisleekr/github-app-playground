import { z } from "zod";

/**
 * Zod-validated environment variables.
 * Fails fast at startup if required vars are missing.
 */
const configSchema = z
  .object({
    // GitHub App credentials — required for server mode, optional for daemon-only mode.
    // Daemon mode (ORCHESTRATOR_URL set) does not need these; validated in superRefine.
    appId: z.string().optional(),
    privateKey: z.string().optional(),
    webhookSecret: z.string().optional(),

    // AI provider selection: "anthropic" (default) or "bedrock"
    provider: z.enum(["anthropic", "bedrock"]).default("anthropic"),

    // Claude API credentials — when provider=anthropic, at least one of these is required
    // (both may be set; the Claude CLI's own auth precedence chain picks one at runtime:
    // ANTHROPIC_API_KEY at position 3 beats CLAUDE_CODE_OAUTH_TOKEN at position 5).
    // Either Console API key (pay-as-you-go) or Max/Pro subscription OAuth token
    // (generated via `claude setup-token`, sk-ant-oat... prefix).
    // See https://code.claude.com/docs/en/authentication#authentication-precedence
    anthropicApiKey: z.string().optional(),
    claudeCodeOauthToken: z.string().optional(),

    // Model override — required when provider=bedrock (Bedrock uses different model ID format),
    // optional for anthropic (SDK uses its default)
    model: z.string().min(1).optional(),

    // AWS Bedrock — required fields validated in superRefine below
    awsRegion: z.string().optional(),
    // Local dev: AWS SSO profile (after: le aws login -e dev).
    // Passed to the Claude Code subprocess env so the AWS SDK credential chain resolves it.
    awsProfile: z.string().optional(),
    // Explicit key credentials (CI/CD or non-SSO environments)
    awsAccessKeyId: z.string().optional(),
    awsSecretAccessKey: z.string().optional(),
    awsSessionToken: z.string().optional(),
    // OIDC bearer token (GitHub Actions with aws-actions/configure-aws-credentials)
    awsBearerTokenBedrock: z.string().optional(),
    // Optional Bedrock endpoint override
    anthropicBedrockBaseUrl: z.string().optional(),

    // Context7 (optional - higher rate limits with key)
    context7ApiKey: z.string().optional(),

    // Repo checkout base directory
    cloneBaseDir: z.string().default("/tmp/bot-workspaces"),

    // App configuration
    triggerPhrase: z.string().default("@chrisleekr-bot"),
    port: z.coerce.number().int().positive().default(3000),
    logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    nodeEnv: z.enum(["production", "development", "test"]).default("production"),
    // Limits concurrent Claude agent executions to prevent API budget exhaustion
    // and resource saturation. Set via MAX_CONCURRENT_REQUESTS env var.
    maxConcurrentRequests: z.coerce.number().int().positive().default(3),
    // Wall-clock timeout for a single Claude agent execution in milliseconds.
    // Guards against resource exhaustion from hung model responses or MCP servers.
    // Set via AGENT_TIMEOUT_MS env var (default: 10 minutes).
    agentTimeoutMs: z.coerce.number().int().positive().default(600_000),
    // Override max turns for the Claude Agent SDK. When set, takes precedence over
    // complexity-based turns. Set via AGENT_MAX_TURNS env var.
    agentMaxTurns: z.coerce.number().int().positive().optional(),
    // Git clone depth for repo checkout. Increase for PRs with deeply diverged branches.
    // Set via CLONE_DEPTH env var (default: 50).
    cloneDepth: z.coerce.number().int().positive().default(50),
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

    // --- Dispatch mode (Phase 2+) ---
    // AGENT_JOB_MODE determines how triggered work is executed.
    // "inline" (default) = current behaviour, no external deps needed.
    agentJobMode: z.enum(["inline", "shared-runner", "ephemeral-job", "auto"]).default("inline"),
    defaultDispatchMode: z.enum(["shared-runner", "ephemeral-job"]).default("shared-runner"),

    // --- K8s Job spawner ---
    jobNamespace: z.string().default("github-app"),
    jobImage: z.string().optional(),
    jobTtlSeconds: z.coerce.number().int().positive().default(300),
    sharedRunnerUrl: z.url().optional(),

    // --- Data layer ---
    valkeyUrl: z.string().optional(),
    databaseUrl: z.string().optional(),

    // --- Orchestrator ---
    wsPort: z.coerce.number().int().positive().default(3002),
    jobMaxCostUsd: z.coerce.number().positive().default(80),

    // --- Shared runner auth (ADR-011) ---
    sharedRunnerToken: z.string().optional(),
    internalRunnerToken: z.string().optional(),

    // --- Daemon / Orchestrator (Phase 2) ---
    daemonAuthToken: z.string().optional(),
    heartbeatIntervalMs: z.coerce.number().int().positive().default(30_000),
    heartbeatTimeoutMs: z.coerce.number().int().positive().default(90_000),
    staleExecutionThresholdMs: z.coerce.number().int().positive().default(600_000),
    daemonDrainTimeoutMs: z.coerce.number().int().positive().default(300_000),
    jobMaxRetries: z.coerce.number().int().nonnegative().default(3),
    offerTimeoutMs: z.coerce.number().int().positive().default(5_000),
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
    daemonUpdateStrategy: z.enum(["exit", "pull", "notify"]).default("exit"),
    daemonUpdateDelayMs: z.coerce.number().int().nonnegative().default(0),
    daemonEphemeral: z.boolean().default(false),
    daemonMemoryFloorMb: z.coerce.number().int().nonnegative().default(512),
    daemonDiskFloorMb: z.coerce.number().int().nonnegative().default(1024),

    // --- Triage pre-classifier ---
    triageEnabled: z.boolean().default(true),
    triageModel: z.string().default("haiku-3-5"),
    triageConfidenceThreshold: z.coerce.number().min(0).max(1).default(1.0),
    triageMaxTokens: z.coerce.number().int().positive().default(256),

    // --- Max turns per complexity class (maps triage output to agent maxTurns) ---
    maxTurnsPerComplexity: z
      .object({
        trivial: z.coerce.number().int().positive().default(10),
        moderate: z.coerce.number().int().positive().default(30),
        complex: z.coerce.number().int().positive().default(50),
      })
      .default({ trivial: 10, moderate: 30, complex: 50 }),
  })
  .superRefine((data, ctx) => {
    validateServerModeCredentials(data, ctx);
    validateProviderCredentials(data, ctx);
    validateDataLayerConfig(data, ctx);
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
 * Parse MAX_TURNS_PER_COMPLEXITY env var with a clear error message on malformed JSON.
 * Returns undefined when the var is not set (triggers Zod .default()).
 *
 * Exported so tests can exercise the error path directly without re-importing
 * the config singleton (same pattern as assertOauthRequiresAllowlist).
 */
export function parseMaxTurnsEnv(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(
      `MAX_TURNS_PER_COMPLEXITY must be valid JSON (e.g. '{"trivial":10,"moderate":30,"complex":50}'). Got: ${raw}`,
    );
  }
}

/**
 * Parse and validate config from environment variables.
 * Throws on invalid/missing required values -- fail fast at startup.
 */
function loadConfig(): Config {
  const cfg = configSchema.parse({
    appId: process.env["GITHUB_APP_ID"],
    privateKey: process.env["GITHUB_APP_PRIVATE_KEY"],
    webhookSecret: process.env["GITHUB_WEBHOOK_SECRET"],
    provider: process.env["CLAUDE_PROVIDER"],
    anthropicApiKey: process.env["ANTHROPIC_API_KEY"],
    claudeCodeOauthToken: process.env["CLAUDE_CODE_OAUTH_TOKEN"],
    model: process.env["CLAUDE_MODEL"],
    awsRegion: process.env["AWS_REGION"],
    awsProfile: process.env["AWS_PROFILE"],
    awsAccessKeyId: process.env["AWS_ACCESS_KEY_ID"],
    awsSecretAccessKey: process.env["AWS_SECRET_ACCESS_KEY"],
    awsSessionToken: process.env["AWS_SESSION_TOKEN"],
    awsBearerTokenBedrock: process.env["AWS_BEARER_TOKEN_BEDROCK"],
    anthropicBedrockBaseUrl: process.env["ANTHROPIC_BEDROCK_BASE_URL"],
    context7ApiKey: process.env["CONTEXT7_API_KEY"],
    cloneBaseDir: process.env["CLONE_BASE_DIR"],
    triggerPhrase: process.env["TRIGGER_PHRASE"],
    port: process.env["PORT"],
    logLevel: process.env["LOG_LEVEL"],
    nodeEnv: process.env.NODE_ENV,
    maxConcurrentRequests: process.env["MAX_CONCURRENT_REQUESTS"],
    agentTimeoutMs: process.env["AGENT_TIMEOUT_MS"],
    agentMaxTurns: process.env["AGENT_MAX_TURNS"],
    cloneDepth: process.env["CLONE_DEPTH"],
    claudeCodePath: process.env["CLAUDE_CODE_PATH"],
    allowedOwners: process.env["ALLOWED_OWNERS"],

    // Dispatch mode
    agentJobMode: process.env["AGENT_JOB_MODE"],
    defaultDispatchMode: process.env["DEFAULT_DISPATCH_MODE"],

    // K8s Job spawner
    jobNamespace: process.env["JOB_NAMESPACE"],
    jobImage: process.env["JOB_IMAGE"],
    jobTtlSeconds: process.env["JOB_TTL_SECONDS"],
    sharedRunnerUrl: process.env["SHARED_RUNNER_URL"],

    // Data layer
    valkeyUrl: process.env["VALKEY_URL"],
    databaseUrl: process.env["DATABASE_URL"],

    // Orchestrator
    wsPort: process.env["WS_PORT"],
    jobMaxCostUsd: process.env["JOB_MAX_COST_USD"],

    // Shared runner auth
    sharedRunnerToken: process.env["SHARED_RUNNER_TOKEN"],
    internalRunnerToken: process.env["INTERNAL_RUNNER_TOKEN"],

    // Daemon / Orchestrator
    daemonAuthToken: process.env["DAEMON_AUTH_TOKEN"],
    heartbeatIntervalMs: process.env["HEARTBEAT_INTERVAL_MS"],
    heartbeatTimeoutMs: process.env["HEARTBEAT_TIMEOUT_MS"],
    staleExecutionThresholdMs: process.env["STALE_EXECUTION_THRESHOLD_MS"],
    daemonDrainTimeoutMs: process.env["DAEMON_DRAIN_TIMEOUT_MS"],
    jobMaxRetries: process.env["JOB_MAX_RETRIES"],
    offerTimeoutMs: process.env["OFFER_TIMEOUT_MS"],
    orchestratorUrl: process.env["ORCHESTRATOR_URL"],
    daemonUpdateStrategy: process.env["DAEMON_UPDATE_STRATEGY"],
    daemonUpdateDelayMs: process.env["DAEMON_UPDATE_DELAY_MS"],
    daemonEphemeral: parseBooleanEnv("DAEMON_EPHEMERAL", process.env["DAEMON_EPHEMERAL"]),
    daemonMemoryFloorMb: process.env["DAEMON_MEMORY_FLOOR_MB"],
    daemonDiskFloorMb: process.env["DAEMON_DISK_FLOOR_MB"],

    // Triage — strict boolean parsing; rejects unrecognized values at startup.
    triageEnabled: parseBooleanEnv("TRIAGE_ENABLED", process.env["TRIAGE_ENABLED"]),
    triageModel: process.env["TRIAGE_MODEL"],
    triageConfidenceThreshold: process.env["TRIAGE_CONFIDENCE_THRESHOLD"],
    triageMaxTokens: process.env["TRIAGE_MAX_TOKENS"],

    // Max turns per complexity
    maxTurnsPerComplexity: parseMaxTurnsEnv(process.env["MAX_TURNS_PER_COMPLEXITY"]),
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
