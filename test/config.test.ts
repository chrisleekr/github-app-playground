import { describe, expect, it } from "bun:test";

import {
  assertOauthRequiresAllowlist,
  type Config,
  configSchema,
  parseBooleanEnv,
  warnIfIsolatedJobWithoutKubernetesAuth,
} from "../src/config";

// Minimal required GitHub App fields shared by all test cases
const BASE = {
  appId: "123",
  privateKey: "-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----",
  webhookSecret: "secret",
};

describe("configSchema — Anthropic provider", () => {
  it("parses successfully with an API key", () => {
    const result = configSchema.safeParse({
      ...BASE,
      provider: "anthropic",
      anthropicApiKey: "sk-ant-test",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provider).toBe("anthropic");
      expect(result.data.anthropicApiKey).toBe("sk-ant-test");
    }
  });

  it("defaults to anthropic provider when CLAUDE_PROVIDER is absent", () => {
    const result = configSchema.safeParse({
      ...BASE,
      anthropicApiKey: "sk-ant-test",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provider).toBe("anthropic");
    }
  });

  it("parses successfully with CLAUDE_CODE_OAUTH_TOKEN and no ANTHROPIC_API_KEY", () => {
    // Max/Pro subscription authentication via `claude setup-token`.
    // The Claude CLI picks up CLAUDE_CODE_OAUTH_TOKEN at auth precedence position 5.
    const result = configSchema.safeParse({
      ...BASE,
      provider: "anthropic",
      claudeCodeOauthToken: "sk-ant-oat-test",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.claudeCodeOauthToken).toBe("sk-ant-oat-test");
      expect(result.data.anthropicApiKey).toBeUndefined();
    }
  });

  it("parses successfully with BOTH ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN set", () => {
    // Schema does not reject when both credentials are provided — the Claude CLI's
    // own precedence chain decides which to use (API key wins). Re-implementing
    // that choice here would duplicate upstream behavior and risk drift.
    const result = configSchema.safeParse({
      ...BASE,
      provider: "anthropic",
      anthropicApiKey: "sk-ant-test",
      claudeCodeOauthToken: "sk-ant-oat-test",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.anthropicApiKey).toBe("sk-ant-test");
      expect(result.data.claudeCodeOauthToken).toBe("sk-ant-oat-test");
    }
  });

  it("rejects when neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is provided", () => {
    const result = configSchema.safeParse({
      ...BASE,
      provider: "anthropic",
      // both credentials intentionally omitted
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("anthropicApiKey");
      // Error message must mention BOTH env var names so users can fix it.
      const messages = result.error.issues.map((i) => i.message).join(" ");
      expect(messages).toContain("ANTHROPIC_API_KEY");
      expect(messages).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    }
  });

  it("rejects when both credentials are whitespace-only strings", () => {
    // `"   "` would previously slip past `!== ""` and produce a "valid" config
    // that fails at first API call. `.trim()` in the schema guards against this.
    const result = configSchema.safeParse({
      ...BASE,
      provider: "anthropic",
      anthropicApiKey: "   ",
      claudeCodeOauthToken: "   ",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("anthropicApiKey");
    }
  });
});

describe("configSchema — Bedrock provider", () => {
  it("rejects when AWS_REGION is missing", () => {
    const result = configSchema.safeParse({
      ...BASE,
      provider: "bedrock",
      model: "us.anthropic.claude-sonnet-4-6",
      // awsRegion intentionally omitted
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("awsRegion");
    }
  });

  it("rejects when CLAUDE_MODEL is missing (Bedrock requires provider-specific model ID)", () => {
    const result = configSchema.safeParse({
      ...BASE,
      provider: "bedrock",
      awsRegion: "us-east-1",
      // model intentionally omitted
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("model");
    }
  });

  it("accepts AWS_REGION + model with AWS_PROFILE (local dev SSO)", () => {
    const result = configSchema.safeParse({
      ...BASE,
      provider: "bedrock",
      awsRegion: "us-east-1",
      model: "us.anthropic.claude-sonnet-4-6",
      awsProfile: "default",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.awsProfile).toBe("default");
      expect(result.data.anthropicApiKey).toBeUndefined();
    }
  });

  it("accepts AWS_REGION + model with no credentials (IRSA / IAM Role for K8s)", () => {
    // In production the kubelet injects AWS_WEB_IDENTITY_TOKEN_FILE into the pod;
    // config.ts does not need to know about it — the subprocess inherits process.env.
    const result = configSchema.safeParse({
      ...BASE,
      provider: "bedrock",
      awsRegion: "us-east-1",
      model: "us.anthropic.claude-sonnet-4-6",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.awsProfile).toBeUndefined();
      expect(result.data.awsAccessKeyId).toBeUndefined();
      expect(result.data.awsBearerTokenBedrock).toBeUndefined();
    }
  });

  it("accepts AWS_REGION + model with explicit access keys (CI/CD)", () => {
    const result = configSchema.safeParse({
      ...BASE,
      provider: "bedrock",
      awsRegion: "us-east-1",
      model: "us.anthropic.claude-sonnet-4-6",
      awsAccessKeyId: "AKIAIOSFODNN7EXAMPLE",
      awsSecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      awsSessionToken: "FwoGZXIvYXdzEJr//////////wE=",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.awsAccessKeyId).toBe("AKIAIOSFODNN7EXAMPLE");
      expect(result.data.awsSessionToken).toBe("FwoGZXIvYXdzEJr//////////wE=");
    }
  });

  it("accepts AWS_REGION + model with OIDC bearer token", () => {
    const result = configSchema.safeParse({
      ...BASE,
      provider: "bedrock",
      awsRegion: "us-east-1",
      model: "us.anthropic.claude-sonnet-4-6",
      awsBearerTokenBedrock: "oidc-token-example",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.awsBearerTokenBedrock).toBe("oidc-token-example");
    }
  });
});

describe("configSchema — allowedOwners parsing", () => {
  // These cases exercise the ALLOWED_OWNERS env var transform. Empty/unset maps
  // to `undefined` ("no restriction"), preserving backward compatibility with
  // deployments that use ANTHROPIC_API_KEY (which is multi-tenant safe).
  const ANTHROPIC_BASE = {
    ...BASE,
    provider: "anthropic" as const,
    anthropicApiKey: "sk-ant-test",
  };

  it("yields undefined when ALLOWED_OWNERS is absent", () => {
    const result = configSchema.safeParse(ANTHROPIC_BASE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowedOwners).toBeUndefined();
    }
  });

  it("yields undefined when ALLOWED_OWNERS is an empty string", () => {
    const result = configSchema.safeParse({ ...ANTHROPIC_BASE, allowedOwners: "" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowedOwners).toBeUndefined();
    }
  });

  it("parses a single owner", () => {
    const result = configSchema.safeParse({ ...ANTHROPIC_BASE, allowedOwners: "user1" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowedOwners).toEqual(["user1"]);
    }
  });

  it("parses multiple owners, trimming whitespace and dropping empty entries", () => {
    // Messy input mirrors what users actually write in .env files.
    const result = configSchema.safeParse({
      ...ANTHROPIC_BASE,
      allowedOwners: "user1, user2 ,user3, , ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowedOwners).toEqual(["user1", "user2", "user3"]);
    }
  });

  it("yields undefined when ALLOWED_OWNERS contains only whitespace/commas", () => {
    // After trim + filter(Boolean), no entries remain → treat as "no restriction".
    const result = configSchema.safeParse({ ...ANTHROPIC_BASE, allowedOwners: " , , " });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowedOwners).toBeUndefined();
    }
  });
});

describe("configSchema — daemon orchestration defaults", () => {
  const ANTHROPIC_BASE = {
    ...BASE,
    provider: "anthropic" as const,
    anthropicApiKey: "sk-ant-test",
  };

  it("defaults agentJobMode to 'inline' when AGENT_JOB_MODE is absent", () => {
    const result = configSchema.safeParse(ANTHROPIC_BASE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agentJobMode).toBe("inline");
    }
  });

  it("accepts all valid agentJobMode enum values", () => {
    const nonInlineBase = {
      ...ANTHROPIC_BASE,
      databaseUrl: "postgres://localhost/test",
      valkeyUrl: "redis://localhost:6379",
      daemonAuthToken: "test-token",
      // Required when agentJobMode is shared-runner or auto.
      internalRunnerUrl: "http://runner.svc.cluster.local:8080",
      internalRunnerToken: "runner-token",
    };

    for (const mode of ["inline", "daemon", "shared-runner", "isolated-job", "auto"] as const) {
      const input =
        mode === "inline"
          ? { ...ANTHROPIC_BASE, agentJobMode: mode }
          : { ...nonInlineBase, agentJobMode: mode };
      const result = configSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.agentJobMode).toBe(mode);
      }
    }
  });

  it("rejects invalid agentJobMode values", () => {
    const result = configSchema.safeParse({ ...ANTHROPIC_BASE, agentJobMode: "invalid" });
    expect(result.success).toBe(false);
  });

  it("defaults defaultDispatchTarget to 'shared-runner'", () => {
    const result = configSchema.safeParse(ANTHROPIC_BASE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.defaultDispatchTarget).toBe("shared-runner");
    }
  });

  it("defaults wsPort to 3002", () => {
    const result = configSchema.safeParse(ANTHROPIC_BASE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.wsPort).toBe(3002);
    }
  });

  it("defaults jobMaxCostUsd to 80", () => {
    const result = configSchema.safeParse(ANTHROPIC_BASE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.jobMaxCostUsd).toBe(80);
    }
  });

  it("defaults triageEnabled to true", () => {
    const result = configSchema.safeParse(ANTHROPIC_BASE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.triageEnabled).toBe(true);
    }
  });

  it("defaults triageConfidenceThreshold to 1.0", () => {
    const result = configSchema.safeParse(ANTHROPIC_BASE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.triageConfidenceThreshold).toBe(1.0);
    }
  });

  it("defaults triage maxTurns ladder to 10 / 30 / 50 with DEFAULT_MAXTURNS=30", () => {
    const result = configSchema.safeParse(ANTHROPIC_BASE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.triageMaxTurnsTrivial).toBe(10);
      expect(result.data.triageMaxTurnsModerate).toBe(30);
      expect(result.data.triageMaxTurnsComplex).toBe(50);
      expect(result.data.defaultMaxTurns).toBe(30);
    }
  });

  it("defaults jobTtlSeconds to 300", () => {
    const result = configSchema.safeParse(ANTHROPIC_BASE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.jobTtlSeconds).toBe(300);
    }
  });

  it("defaults triageModel to 'haiku-3-5'", () => {
    const result = configSchema.safeParse(ANTHROPIC_BASE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.triageModel).toBe("haiku-3-5");
    }
  });
});

describe("configSchema — non-inline mode requires data layer", () => {
  const ANTHROPIC_BASE = {
    ...BASE,
    provider: "anthropic" as const,
    anthropicApiKey: "sk-ant-test",
  };

  it("rejects agentJobMode='shared-runner' without DATABASE_URL", () => {
    const result = configSchema.safeParse({
      ...ANTHROPIC_BASE,
      agentJobMode: "shared-runner",
      valkeyUrl: "redis://localhost:6379",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("databaseUrl");
    }
  });

  it("rejects agentJobMode='auto' without VALKEY_URL", () => {
    const result = configSchema.safeParse({
      ...ANTHROPIC_BASE,
      agentJobMode: "auto",
      databaseUrl: "postgres://localhost/test",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("valkeyUrl");
    }
  });

  it("accepts agentJobMode='shared-runner' with all required fields", () => {
    const result = configSchema.safeParse({
      ...ANTHROPIC_BASE,
      agentJobMode: "shared-runner",
      databaseUrl: "postgres://localhost/test",
      valkeyUrl: "redis://localhost:6379",
      daemonAuthToken: "test-token",
      internalRunnerUrl: "http://runner.svc.cluster.local:8080",
      internalRunnerToken: "runner-token",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agentJobMode).toBe("shared-runner");
    }
  });

  it("does not require DATABASE_URL or VALKEY_URL in inline mode", () => {
    const result = configSchema.safeParse(ANTHROPIC_BASE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agentJobMode).toBe("inline");
      expect(result.data.databaseUrl).toBeUndefined();
      expect(result.data.valkeyUrl).toBeUndefined();
    }
  });
});

describe("configSchema — triage maxTurns ladder (FR-008a)", () => {
  it("accepts per-complexity overrides via individual env vars", () => {
    const result = configSchema.safeParse({
      ...BASE,
      anthropicApiKey: "sk-ant-test",
      triageMaxTurnsTrivial: 5,
      triageMaxTurnsModerate: 15,
      triageMaxTurnsComplex: 25,
      defaultMaxTurns: 20,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.triageMaxTurnsTrivial).toBe(5);
      expect(result.data.triageMaxTurnsModerate).toBe(15);
      expect(result.data.triageMaxTurnsComplex).toBe(25);
      expect(result.data.defaultMaxTurns).toBe(20);
    }
  });
});

describe("parseBooleanEnv", () => {
  it("returns undefined when input is undefined", () => {
    expect(parseBooleanEnv("TEST", undefined)).toBeUndefined();
  });

  it.each(["true", "TRUE", "True", "1", "yes", "YES"])("returns true for '%s'", (val) => {
    expect(parseBooleanEnv("TEST", val)).toBe(true);
  });

  it.each(["false", "FALSE", "False", "0", "no", "NO"])("returns false for '%s'", (val) => {
    expect(parseBooleanEnv("TEST", val)).toBe(false);
  });

  it("trims whitespace before parsing", () => {
    expect(parseBooleanEnv("TEST", "  true  ")).toBe(true);
  });

  it("throws on unrecognized values like 'tru'", () => {
    expect(() => parseBooleanEnv("TRIAGE_ENABLED", "tru")).toThrow(
      /TRIAGE_ENABLED must be one of: true, false, 1, 0, yes, no/,
    );
  });

  it("throws on empty string", () => {
    expect(() => parseBooleanEnv("TEST", "")).toThrow(/TEST must be one of/);
  });
});

describe("configSchema — non-inline mode rejects whitespace-only data-layer URLs", () => {
  const ANTHROPIC_BASE = {
    ...BASE,
    provider: "anthropic" as const,
    anthropicApiKey: "sk-ant-test",
  };

  it("rejects whitespace-only DATABASE_URL in non-inline mode", () => {
    const result = configSchema.safeParse({
      ...ANTHROPIC_BASE,
      agentJobMode: "shared-runner",
      databaseUrl: "   ",
      valkeyUrl: "redis://localhost:6379",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("databaseUrl");
    }
  });

  it("rejects whitespace-only VALKEY_URL in non-inline mode", () => {
    const result = configSchema.safeParse({
      ...ANTHROPIC_BASE,
      agentJobMode: "shared-runner",
      databaseUrl: "postgres://localhost/test",
      valkeyUrl: "   ",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("valkeyUrl");
    }
  });
});

describe("assertOauthRequiresAllowlist", () => {
  // ToS guard: CLAUDE_CODE_OAUTH_TOKEN is a personal Max/Pro subscription credential.
  // The Agent SDK Note prohibits serving other users' repos from that quota, so
  // OAuth mode requires an owner allowlist as a hard startup precondition. These
  // tests exercise the exported helper directly against a parsed `Config` so the
  // rule can be verified without round-tripping env vars through loadConfig().
  function parse(input: Record<string, unknown>): Config {
    const result = configSchema.parse(input);
    return result;
  }

  it("throws when OAuth token is set without ALLOWED_OWNERS (the ToS gap)", () => {
    const cfg = parse({
      ...BASE,
      provider: "anthropic",
      claudeCodeOauthToken: "sk-ant-oat-test",
      // allowedOwners intentionally omitted
    });
    expect(() => {
      assertOauthRequiresAllowlist(cfg);
    }).toThrow(/ALLOWED_OWNERS must contain exactly one owner/);
  });

  it("throws when OAuth token is set and ALLOWED_OWNERS is whitespace-only", () => {
    // The zod transform treats whitespace-only as `undefined`, so this exercises
    // the same branch but via a different user mistake (setting ALLOWED_OWNERS="   ").
    const cfg = parse({
      ...BASE,
      provider: "anthropic",
      claudeCodeOauthToken: "sk-ant-oat-test",
      allowedOwners: "   ",
    });
    expect(() => {
      assertOauthRequiresAllowlist(cfg);
    }).toThrow(/ALLOWED_OWNERS must contain exactly one owner/);
  });

  it("throws when OAuth token is set with multiple ALLOWED_OWNERS (must be single-tenant)", () => {
    const cfg = parse({
      ...BASE,
      provider: "anthropic",
      claudeCodeOauthToken: "sk-ant-oat-test",
      allowedOwners: "owner-a,owner-b",
    });
    expect(() => {
      assertOauthRequiresAllowlist(cfg);
    }).toThrow(/ALLOWED_OWNERS must contain exactly one owner/);
  });

  it("allows OAuth token with a non-empty ALLOWED_OWNERS (single-tenant in-policy)", () => {
    const cfg = parse({
      ...BASE,
      provider: "anthropic",
      claudeCodeOauthToken: "sk-ant-oat-test",
      allowedOwners: "chrisleekr",
    });
    expect(() => {
      assertOauthRequiresAllowlist(cfg);
    }).not.toThrow();
  });

  it("allows API-key-only deployments with no ALLOWED_OWNERS (multi-tenant in-policy)", () => {
    // Pay-as-you-go API key has its own billing boundary; the ToS guard only
    // applies to subscription OAuth tokens. This must remain unrestricted.
    const cfg = parse({
      ...BASE,
      provider: "anthropic",
      anthropicApiKey: "sk-ant-test",
    });
    expect(() => {
      assertOauthRequiresAllowlist(cfg);
    }).not.toThrow();
  });

  it("allows OAuth token + API key together when ALLOWED_OWNERS is set", () => {
    // If both credentials are set, the CLI precedence picks API key at runtime.
    // The assertion still requires the allowlist because OAuth is *present* —
    // defense-in-depth against upstream precedence changes.
    const cfg = parse({
      ...BASE,
      provider: "anthropic",
      anthropicApiKey: "sk-ant-test",
      claudeCodeOauthToken: "sk-ant-oat-test",
      allowedOwners: "chrisleekr",
    });
    expect(() => {
      assertOauthRequiresAllowlist(cfg);
    }).not.toThrow();
  });

  it("throws when OAuth + API key are BOTH set but ALLOWED_OWNERS is missing", () => {
    // Defense-in-depth: presence of OAuth triggers the rule regardless of which
    // credential the CLI ultimately uses at runtime.
    const cfg = parse({
      ...BASE,
      provider: "anthropic",
      anthropicApiKey: "sk-ant-test",
      claudeCodeOauthToken: "sk-ant-oat-test",
    });
    expect(() => {
      assertOauthRequiresAllowlist(cfg);
    }).toThrow(/ALLOWED_OWNERS must contain exactly one owner/);
  });

  it("does not apply to Bedrock deployments", () => {
    // OAuth token is Anthropic-only; Bedrock has its own AWS credential chain
    // and is not subject to the Agent SDK subscription Note.
    const cfg = parse({
      ...BASE,
      provider: "bedrock",
      awsRegion: "us-east-1",
      model: "us.anthropic.claude-sonnet-4-6",
      // No allowlist required for Bedrock.
    });
    expect(() => {
      assertOauthRequiresAllowlist(cfg);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// T005: new env-var defaults, cross-field rules, and K8s-auth warning.
// ---------------------------------------------------------------------------

describe("configSchema — triage-dispatch-modes new defaults (T004/T005)", () => {
  const ANTHROPIC_BASE = {
    ...BASE,
    provider: "anthropic" as const,
    anthropicApiKey: "sk-ant-test",
  };

  it("defaults triageTimeoutMs to 5000", () => {
    const result = configSchema.safeParse(ANTHROPIC_BASE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.triageTimeoutMs).toBe(5_000);
    }
  });

  it("defaults maxConcurrentIsolatedJobs to 3", () => {
    const result = configSchema.safeParse(ANTHROPIC_BASE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxConcurrentIsolatedJobs).toBe(3);
    }
  });

  it("defaults pendingIsolatedJobQueueMax to 20", () => {
    const result = configSchema.safeParse(ANTHROPIC_BASE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pendingIsolatedJobQueueMax).toBe(20);
    }
  });

  it("coerces numeric env-var strings for all new fields", () => {
    // Env vars always arrive as strings from process.env. Coercion is
    // security-critical — a silent NaN would map every FR-008a complexity
    // to a bogus maxTurns.
    const result = configSchema.safeParse({
      ...ANTHROPIC_BASE,
      triageTimeoutMs: "7500",
      triageMaxTurnsTrivial: "8",
      triageMaxTurnsModerate: "20",
      triageMaxTurnsComplex: "40",
      defaultMaxTurns: "25",
      maxConcurrentIsolatedJobs: "5",
      pendingIsolatedJobQueueMax: "30",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.triageTimeoutMs).toBe(7_500);
      expect(result.data.triageMaxTurnsTrivial).toBe(8);
      expect(result.data.triageMaxTurnsModerate).toBe(20);
      expect(result.data.triageMaxTurnsComplex).toBe(40);
      expect(result.data.defaultMaxTurns).toBe(25);
      expect(result.data.maxConcurrentIsolatedJobs).toBe(5);
      expect(result.data.pendingIsolatedJobQueueMax).toBe(30);
    }
  });

  it("rejects non-positive values for every numeric FR-008a / FR-018 knob", () => {
    const zeroRejects: readonly string[] = [
      "triageTimeoutMs",
      "triageMaxTurnsTrivial",
      "triageMaxTurnsModerate",
      "triageMaxTurnsComplex",
      "defaultMaxTurns",
      "maxConcurrentIsolatedJobs",
      "pendingIsolatedJobQueueMax",
    ];
    for (const key of zeroRejects) {
      const input = { ...ANTHROPIC_BASE, [key]: 0 };
      const result = configSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        const paths = result.error.issues.map((i) => i.path.join("."));
        expect(paths).toContain(key);
      }
    }
  });
});

describe("configSchema — auto mode requires non-inline default (FR-003)", () => {
  const AUTO_BASE = {
    ...BASE,
    provider: "anthropic" as const,
    anthropicApiKey: "sk-ant-test",
    agentJobMode: "auto" as const,
    databaseUrl: "postgres://localhost/test",
    valkeyUrl: "redis://localhost:6379",
    daemonAuthToken: "test-token",
    internalRunnerUrl: "http://runner.svc.cluster.local:8080",
    internalRunnerToken: "runner-token",
  };

  it("rejects agentJobMode='auto' with defaultDispatchTarget='inline'", () => {
    const result = configSchema.safeParse({ ...AUTO_BASE, defaultDispatchTarget: "inline" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("defaultDispatchTarget");
    }
  });

  it("accepts agentJobMode='auto' with any non-inline default", () => {
    for (const target of ["daemon", "shared-runner", "isolated-job"] as const) {
      const result = configSchema.safeParse({ ...AUTO_BASE, defaultDispatchTarget: target });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.defaultDispatchTarget).toBe(target);
      }
    }
  });

  it("allows defaultDispatchTarget='inline' in non-auto modes (not meaningful but not invalid)", () => {
    // In inline mode the default is unused; no need to restrict it.
    const result = configSchema.safeParse({
      ...BASE,
      provider: "anthropic",
      anthropicApiKey: "sk-ant-test",
      agentJobMode: "inline",
      defaultDispatchTarget: "inline",
    });
    expect(result.success).toBe(true);
  });
});

describe("configSchema — shared-runner auth (FR-006, contracts/shared-runner-internal)", () => {
  const SHARED_RUNNER_BASE = {
    ...BASE,
    provider: "anthropic" as const,
    anthropicApiKey: "sk-ant-test",
    agentJobMode: "shared-runner" as const,
    databaseUrl: "postgres://localhost/test",
    valkeyUrl: "redis://localhost:6379",
    daemonAuthToken: "test-token",
  };

  it("rejects agentJobMode='shared-runner' without INTERNAL_RUNNER_URL", () => {
    const result = configSchema.safeParse({
      ...SHARED_RUNNER_BASE,
      internalRunnerToken: "token",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("internalRunnerUrl");
    }
  });

  it("rejects agentJobMode='shared-runner' without INTERNAL_RUNNER_TOKEN", () => {
    const result = configSchema.safeParse({
      ...SHARED_RUNNER_BASE,
      internalRunnerUrl: "http://runner:8080",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("internalRunnerToken");
    }
  });

  it("rejects agentJobMode='auto' without shared-runner creds (auto can route there)", () => {
    const result = configSchema.safeParse({
      ...SHARED_RUNNER_BASE,
      agentJobMode: "auto",
      defaultDispatchTarget: "shared-runner",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("internalRunnerUrl");
      expect(paths).toContain("internalRunnerToken");
    }
  });

  it("does not require shared-runner creds in daemon or isolated-job modes", () => {
    for (const mode of ["daemon", "isolated-job"] as const) {
      const result = configSchema.safeParse({
        ...SHARED_RUNNER_BASE,
        agentJobMode: mode,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.agentJobMode).toBe(mode);
      }
    }
  });
});

describe("warnIfIsolatedJobWithoutKubernetesAuth (FR-018)", () => {
  const parse = (input: Record<string, unknown>): Config => {
    const result = configSchema.safeParse(input);
    if (!result.success) throw new Error("parse failed");
    return result.data;
  };

  const ISOLATED_BASE = {
    ...BASE,
    provider: "anthropic" as const,
    anthropicApiKey: "sk-ant-test",
    agentJobMode: "isolated-job" as const,
    databaseUrl: "postgres://localhost/test",
    valkeyUrl: "redis://localhost:6379",
    daemonAuthToken: "test-token",
  };

  /** Run the warning function with a locally scoped env, capturing console.warn. */
  function runWithEnv(cfg: Config, envPatch: Record<string, string | undefined>): string[] {
    const original: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(envPatch)) {
      original[key] = process.env[key];
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      warnIfIsolatedJobWithoutKubernetesAuth(cfg);
    } finally {
      console.warn = originalWarn;
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) {
          Reflect.deleteProperty(process.env, key);
        } else {
          process.env[key] = value;
        }
      }
    }
    return warnings;
  }

  it("warns when agentJobMode='isolated-job' and neither KUBERNETES_SERVICE_HOST nor KUBECONFIG is set", () => {
    const cfg = parse(ISOLATED_BASE);
    const warnings = runWithEnv(cfg, { KUBERNETES_SERVICE_HOST: undefined, KUBECONFIG: undefined });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/AGENT_JOB_MODE=isolated-job/);
    expect(warnings[0]).toMatch(/infra-absent/);
  });

  it("warns when agentJobMode='auto' and K8s auth is absent (auto can route to isolated-job)", () => {
    const cfg = parse({
      ...ISOLATED_BASE,
      agentJobMode: "auto",
      internalRunnerUrl: "http://runner:8080",
      internalRunnerToken: "runner-token",
    });
    const warnings = runWithEnv(cfg, { KUBERNETES_SERVICE_HOST: undefined, KUBECONFIG: undefined });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/AGENT_JOB_MODE=auto/);
  });

  it("does not warn when KUBERNETES_SERVICE_HOST is set (in-cluster)", () => {
    const cfg = parse(ISOLATED_BASE);
    const warnings = runWithEnv(cfg, {
      KUBERNETES_SERVICE_HOST: "10.0.0.1",
      KUBECONFIG: undefined,
    });
    expect(warnings.length).toBe(0);
  });

  it("does not warn when KUBECONFIG is set (out-of-cluster)", () => {
    const cfg = parse(ISOLATED_BASE);
    const warnings = runWithEnv(cfg, {
      KUBERNETES_SERVICE_HOST: undefined,
      KUBECONFIG: "/home/user/.kube/config",
    });
    expect(warnings.length).toBe(0);
  });

  it("does not warn in inline / daemon / shared-runner modes (isolated-job target unused)", () => {
    for (const mode of ["inline", "daemon", "shared-runner"] as const) {
      const cfg = parse(
        mode === "inline"
          ? { ...BASE, provider: "anthropic", anthropicApiKey: "sk-ant-test" }
          : {
              ...ISOLATED_BASE,
              agentJobMode: mode,
              ...(mode === "shared-runner"
                ? {
                    internalRunnerUrl: "http://runner:8080",
                    internalRunnerToken: "runner-token",
                  }
                : {}),
            },
      );
      const warnings = runWithEnv(cfg, {
        KUBERNETES_SERVICE_HOST: undefined,
        KUBECONFIG: undefined,
      });
      expect(warnings.length).toBe(0);
    }
  });
});
