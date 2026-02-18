/**
 * Test environment preload script.
 * Runs before each test file to set consistent environment variables.
 * Configured in bunfig.toml [test].preload
 */

// Force test environment
process.env["NODE_ENV"] = "test";

// Consistent timezone for date-dependent tests
process.env["TZ"] = "UTC";

// Always use the Anthropic provider in tests so the config singleton resolves
// without needing AWS credentials. This overrides any CLAUDE_PROVIDER value
// that Bun auto-loads from a local .env file (e.g. "bedrock" for local dev).
process.env["CLAUDE_PROVIDER"] = "anthropic";

// Helper: set env var to a fallback when absent or empty.
// ?? (nullish coalescing) only replaces null/undefined, not "". A local .env
// file may contain KEY= (empty string), which Bun loads as "" into process.env.
// We use explicit comparison so empty strings from .env are also replaced.
const setIfEmpty = (key: string, fallback: string): void => {
  // eslint-disable-next-line security/detect-object-injection
  const current = process.env[key];
  if (current === undefined || current === "") {
    // eslint-disable-next-line security/detect-object-injection
    process.env[key] = fallback;
  }
};

// Provide dummy values for required config env vars so modules that
// import `config` can load without crashing in unit tests.
setIfEmpty("GITHUB_APP_ID", "test-app-id");
setIfEmpty("GITHUB_APP_PRIVATE_KEY", "test-private-key");
setIfEmpty("GITHUB_WEBHOOK_SECRET", "test-webhook-secret");
// ANTHROPIC_API_KEY: Required because CLAUDE_PROVIDER is forced to "anthropic" above,
// and superRefine enforces the key for that provider.
setIfEmpty("ANTHROPIC_API_KEY", "test-anthropic-key");
