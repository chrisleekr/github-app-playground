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

  it("rejects when ANTHROPIC_API_KEY is missing", () => {
    const result = configSchema.safeParse({
      ...BASE,
      provider: "anthropic",
      // anthropicApiKey intentionally omitted
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
