import { describe, expect, it } from "bun:test";

import { buildProviderEnv } from "../../src/core/executor";

// `buildProviderEnv` intentionally inherits `process.env` (minus the two
// Claude credential keys it explicitly scrubs) so the spawned subprocess
// has PATH/HOME/etc. These tests therefore only assert on keys the function
// itself sets — they do not assert that other keys are absent, since that
// would be coupled to test-runner env hygiene.

describe("buildProviderEnv", () => {
  it("forwards an installation token as both GH_TOKEN and GITHUB_TOKEN", () => {
    const env = buildProviderEnv("ghs_test_token");
    expect(env["GH_TOKEN"]).toBe("ghs_test_token");
    expect(env["GITHUB_TOKEN"]).toBe("ghs_test_token");
  });

  it("exports BOT_ARTIFACT_DIR when an artifacts directory is supplied", () => {
    const env = buildProviderEnv(undefined, "/tmp/work-abc-artifacts");
    expect(env["BOT_ARTIFACT_DIR"]).toBe("/tmp/work-abc-artifacts");
  });

  it("emits both token vars and BOT_ARTIFACT_DIR together when both inputs are supplied", () => {
    const env = buildProviderEnv("ghs_token", "/tmp/work-xyz-artifacts");
    expect(env["GH_TOKEN"]).toBe("ghs_token");
    expect(env["GITHUB_TOKEN"]).toBe("ghs_token");
    expect(env["BOT_ARTIFACT_DIR"]).toBe("/tmp/work-xyz-artifacts");
  });

  it("scrubs blank ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN so the SDK does not select an empty credential", () => {
    // Regression guard for the auth-precedence bug documented in
    // buildProviderEnv: an empty string in either of these env vars wins
    // the SDK's precedence chain and blocks the real credential. The
    // function strips them explicitly before forwarding parent env.
    const prevApi = process.env["ANTHROPIC_API_KEY"];
    const prevOauth = process.env["CLAUDE_CODE_OAUTH_TOKEN"];
    process.env["ANTHROPIC_API_KEY"] = "  ";
    process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "";
    try {
      const env = buildProviderEnv("ghs_token");
      expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
      expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBeUndefined();
    } finally {
      if (prevApi === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = prevApi;
      if (prevOauth === undefined) delete process.env["CLAUDE_CODE_OAUTH_TOKEN"];
      else process.env["CLAUDE_CODE_OAUTH_TOKEN"] = prevOauth;
    }
  });
});
