import { describe, expect, it } from "bun:test";

import { configSchema } from "../src/config";

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
