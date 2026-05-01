import pino, { type SerializedError } from "pino";

import { config } from "./config";
import { redactGitHubTokens } from "./utils/sanitize";

/**
 * Path-based redaction list for the root pino logger.
 *
 * These cover the *named-field* leak surface: any log object whose key path
 * matches a pattern below is replaced with the censor placeholder before
 * the line is emitted. Pino's path syntax supports `*` wildcards at one
 * intermediate level and bracket notation for keys with hyphens.
 *
 * The `err` serializer below handles the *free-text* leak surface
 * (secrets embedded in error messages and stacks).
 */
export const REDACT_PATHS: string[] = [
  // Generic auth tokens — Octokit RequestError carries these on err.request.headers
  "authorization",
  "*.authorization",
  "headers.authorization",
  "*.headers.authorization",
  "req.headers.authorization",
  "request.headers.authorization",
  // Webhook signature header — octokit lowercases incoming header names
  'headers["x-hub-signature-256"]',
  '*.headers["x-hub-signature-256"]',
  'req.headers["x-hub-signature-256"]',
  'request.headers["x-hub-signature-256"]',
  // GitHub 401 bodies sometimes echo a token field
  "response.data.token",
  // Generic credential fields used throughout the codebase
  "token",
  "installationToken",
  "privateKey",
  "webhookSecret",
  "anthropicApiKey",
  "claudeCodeOauthToken",
  "daemonAuthToken",
  "awsSecretAccessKey",
  "awsSessionToken",
  "awsBearerTokenBedrock",
  "*.password",
];

/**
 * Strip user:pass credentials from any URL in free-text. Mirrors the
 * URL-parse approach in `redactValkeyUrl` (`src/orchestrator/valkey.ts`)
 * but as a regex so it can run over arbitrary message/stack strings
 * without having to first locate the URL boundaries.
 */
function redactCredentialUrls(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+\-.]*:\/\/)([^@/\s:]+):([^@/\s]+)@/gi, "$1***:***@");
}

/** Censor placeholder — matches pino's default so output is uniform. */
const CENSOR = "[Redacted]";

/**
 * Header names that always carry a secret on Octokit / webhook errors and
 * must be replaced wholesale rather than scrubbed for embedded tokens.
 * Compared lower-case because Node lowercases incoming header names.
 */
const SENSITIVE_HEADER_NAMES = new Set(["authorization", "x-hub-signature-256"]);

/** Compose all string-scrubbers applied to free-text fields. */
function scrubString(value: string): string {
  return redactCredentialUrls(redactGitHubTokens(value));
}

/**
 * Scrub a `headers` object: replace known-sensitive header values with the
 * censor placeholder and run the GitHub-token / URL-credential regex over
 * the rest. Returns a new object so the original Error is never mutated.
 *
 * This duplicates the intent of pino's path-based redaction for the
 * `err.request.headers.*` namespace because pino's path syntax does not
 * traverse arbitrary depth — `*.headers.authorization` matches a 3-segment
 * path but `err.request.headers.authorization` is 4 segments deep.
 */
function scrubHeaders(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    /* eslint-disable security/detect-object-injection -- key originates from Object.entries on a header object the pino err serializer just produced; not user-controlled. */
    if (SENSITIVE_HEADER_NAMES.has(k.toLowerCase())) {
      out[k] = CENSOR;
    } else {
      out[k] = typeof v === "string" ? scrubString(v) : v;
    }
    /* eslint-enable security/detect-object-injection */
  }
  return out;
}

/**
 * Scrub a `response.data` object on an Octokit error: `data.token` is
 * replaced wholesale (mirrors the path-based `response.data.token` rule
 * for the err-namespace case), and other string values are passed through
 * the GitHub-token / URL-credential regex.
 */
function scrubResponseData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    /* eslint-disable security/detect-object-injection -- key originates from Object.entries on the err serializer output; not user-controlled. */
    if (k === "token") {
      out[k] = CENSOR;
    } else {
      out[k] = typeof v === "string" ? scrubString(v) : v;
    }
    /* eslint-enable security/detect-object-injection */
  }
  return out;
}

/**
 * Custom error serializer.
 *
 * Defers to pino's default `stdSerializers.err` (so the shape stays
 * compatible with downstream tooling) and then runs string-scrubbers
 * over the fields that empirically carry secrets:
 *
 * - `message` and `stack` — Octokit `RequestError` includes the URL
 *   and sometimes the response body in its message; both can echo a
 *   `ghs_…` installation token or an App JWT verbatim.
 * - `request.headers` — `authorization` is covered by the redact path
 *   list above, but other free-text headers may also carry secrets.
 * - `response.data` — when the upstream replies with a JSON-encoded
 *   error body that includes a token.
 *
 * Operates on a copy so the original Error object is never mutated.
 */
function scrubRequest(request: object): Record<string, unknown> {
  const reqObj = request as { headers?: unknown } & Record<string, unknown>;
  const headers = reqObj.headers;
  if (headers !== null && typeof headers === "object") {
    return { ...reqObj, headers: scrubHeaders(headers as Record<string, unknown>) };
  }
  return { ...reqObj };
}

function scrubResponse(response: object): Record<string, unknown> {
  const resObj = response as { data?: unknown } & Record<string, unknown>;
  if (typeof resObj.data === "string") {
    return { ...resObj, data: scrubString(resObj.data) };
  }
  if (resObj.data !== null && typeof resObj.data === "object") {
    return { ...resObj, data: scrubResponseData(resObj.data as Record<string, unknown>) };
  }
  return { ...resObj };
}

export function errSerializer(err: unknown): unknown {
  const serialized = pino.stdSerializers.err(err as Error);
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- pino types claim Error in / SerializedError out, but at runtime stdSerializers.err returns the input unchanged for non-error-likes (see pino-std-serializers/lib/err.js). Guard preserves that pass-through and lets callers feed in `unknown`.
  if (serialized === null || typeof serialized !== "object") {
    return serialized;
  }

  const out: Record<string, unknown> = { ...(serialized as unknown as SerializedError) };

  const message = out["message"];
  if (typeof message === "string") {
    out["message"] = scrubString(message);
  }
  const stack = out["stack"];
  if (typeof stack === "string") {
    out["stack"] = scrubString(stack);
  }

  const request = out["request"];
  if (request !== null && typeof request === "object") {
    out["request"] = scrubRequest(request);
  }

  const response = out["response"];
  if (response !== null && typeof response === "object") {
    out["response"] = scrubResponse(response);
  }

  return out;
}

/**
 * Root logger instance.
 * JSON output in production, pino-pretty in development.
 *
 * Redaction is configured at this level so EVERY child logger and
 * EVERY emitted line passes through the same chokepoint — point
 * helpers like `redactGitHubTokens` (`src/utils/sanitize.ts`) and
 * `redactValkeyUrl` (`src/orchestrator/valkey.ts`) only cover their
 * own call sites. See `docs/operate/observability.md`.
 */
export const logger = pino({
  level: config.logLevel,
  redact: { paths: REDACT_PATHS },
  serializers: { err: errSerializer },
  ...(config.nodeEnv === "development" ? { transport: { target: "pino-pretty" } } : {}),
});

/**
 * Create a child logger scoped to a specific webhook delivery.
 * Consistent fields across all log lines for a single request.
 */
export function createChildLogger(fields: {
  deliveryId: string;
  owner: string;
  repo: string;
  entityNumber: number;
}): pino.Logger {
  return logger.child(fields);
}

export type Logger = pino.Logger;
