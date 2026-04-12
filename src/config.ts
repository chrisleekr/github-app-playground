import { z } from "zod";

/**
 * Zod-validated environment variables.
 * Fails fast at startup if required vars are missing.
 */
const configSchema = z
  .object({
    // GitHub App credentials
    appId: z.string().min(1, "GITHUB_APP_ID is required"),
    privateKey: z.string().min(1, "GITHUB_APP_PRIVATE_KEY is required"),
    webhookSecret: z.string().min(1, "GITHUB_WEBHOOK_SECRET is required"),

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
  })
  .superRefine((data, ctx) => {
    if (data.provider === "anthropic") {
      // Direct Anthropic API requires a non-empty credential:
      //   - ANTHROPIC_API_KEY (Console pay-as-you-go), OR
      //   - CLAUDE_CODE_OAUTH_TOKEN (Max/Pro subscription, sk-ant-oat... prefix)
      // If both are set, the Claude CLI's own auth precedence chain picks one
      // (API key wins). Rejecting "both set" would duplicate CLI-side logic.
      // `.trim()` guards against whitespace-only values pasted into .env files —
      // those would otherwise pass startup and fail later on the first API call.
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
      // provider === "bedrock" (the only other enum value)
      // Bedrock always needs a region to construct the endpoint
      if (data.awsRegion === undefined || data.awsRegion === "") {
        ctx.addIssue({
          code: "custom",
          message: "AWS_REGION is required when CLAUDE_PROVIDER=bedrock",
          path: ["awsRegion"],
        });
      }
      // Bedrock uses a different model ID format (e.g. us.anthropic.claude-sonnet-4-6).
      // The SDK only passes --model if provided; without it the CLI uses an Anthropic-format
      // default that the Bedrock API will reject.
      if (data.model === undefined) {
        ctx.addIssue({
          code: "custom",
          message:
            "CLAUDE_MODEL is required when CLAUDE_PROVIDER=bedrock (e.g. us.anthropic.claude-sonnet-4-6)",
          path: ["model"],
        });
      }
      // Credentials are NOT validated here: the AWS SDK credential chain in the subprocess
      // handles all cases — AWS_PROFILE (local SSO), IRSA, explicit keys, or bearer token.
      // Runtime will surface any credential error on first API call.
    }
  });

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
    cfg.allowedOwners === undefined
  ) {
    throw new Error(
      "ALLOWED_OWNERS is required when CLAUDE_CODE_OAUTH_TOKEN is set. " +
        "See https://code.claude.com/docs/en/agent-sdk/overview",
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
    cloneDepth: process.env["CLONE_DEPTH"],
    claudeCodePath: process.env["CLAUDE_CODE_PATH"],
    allowedOwners: process.env["ALLOWED_OWNERS"],
  });
  assertOauthRequiresAllowlist(cfg);
  return cfg;
}

export const config = loadConfig();
