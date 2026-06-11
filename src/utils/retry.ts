import pino from "pino";

import type { Logger } from "../logger";
import { errSerializer, REDACT_PATHS, resolveLogLevel } from "./log-redaction";
import { RETRY_LOG_EVENTS } from "./retry-log-fields";

// Config-free default logger (issue #184). Importing retry.ts must not pull in
// src/logger.ts -> src/config, so the stdio MCP servers that use retry (e.g.
// resolve-review-thread) stay config-free. `import type { Logger }` above is
// erased at emit, so it adds no runtime coupling. Same REDACT_PATHS +
// errSerializer as the root logger keeps redaction parity. The level reads
// LOG_LEVEL directly (config is intentionally not imported) via resolveLogLevel,
// which falls back to `info` on an invalid value so pino can't throw at import.
// Level visibility matches the root logger because both derive from LOG_LEVEL.
//
// Writes to stderr (like createMcpLogger), NOT pino's default stdout: a stdio
// MCP server speaks JSON-RPC over stdout, so a default-path retry warning on
// stdout would corrupt the protocol. stderr is safe in every context (k8s
// ships both streams; warn/error on stderr is conventional).
const defaultLog: Logger = pino(
  {
    level: resolveLogLevel(process.env["LOG_LEVEL"]),
    redact: { paths: [...REDACT_PATHS] },
    serializers: { err: errSerializer },
  },
  process.stderr,
);

/**
 * Retry configuration options.
 * Ported from claude-code-action's src/utils/retry.ts
 */
export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  /**
   * Optional scoped logger. Defaults to the config-free default logger when
   * omitted or `undefined` (the destructuring default below treats both the
   * same), so callers can forward a maybe-undefined logger without a guard.
   */
  log?: Logger | undefined;
  /**
   * Short dotted identifier for the wrapped operation (e.g. `"github.fetch"`,
   * `"mcp.comment.update"`). Surfaces on every `retry.*` event so an operator
   * can break the retry rate down per upstream call site. Defaults to
   * `"unknown"` when omitted so emits always carry a non-empty `op`.
   */
  op?: string | undefined;
}

/**
 * Validate a numeric retry option. Throws a descriptive Error identifying the
 * offending option name and value when the value is not finite, optionally not
 * an integer, or below the allowed minimum.
 *
 * Guards against the NaN/Infinity bypass of a naive `value < min` check:
 * `NaN < 1` is `false`, so a plain comparison would silently accept NaN and
 * later cause `throw undefined` in the exhaustion path.
 *
 * @param name - Option name used in the error message (e.g. "maxAttempts").
 * @param value - The numeric value to validate.
 * @param opts - Validation constraints: `min` (inclusive lower bound) and
 *   optional `requireInteger` flag for options that must be whole numbers.
 * @throws Error when the value is not finite, not an integer (when required),
 *   or below `min`.
 */
function validateNumberOption(
  name: string,
  value: number,
  opts: { min: number; requireInteger?: boolean },
): void {
  if (!Number.isFinite(value)) {
    throw new Error(`retryWithBackoff: ${name} must be a finite number, got ${String(value)}`);
  }
  if (opts.requireInteger === true && !Number.isInteger(value)) {
    throw new Error(`retryWithBackoff: ${name} must be an integer, got ${String(value)}`);
  }
  if (value < opts.min) {
    throw new Error(
      `retryWithBackoff: ${name} must be >= ${String(opts.min)}, got ${String(value)}`,
    );
  }
}

/**
 * Retry an async operation with exponential backoff.
 * Pass the delivery-scoped ctx.log to preserve deliveryId correlation in logs.
 */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelayMs = 5000,
    maxDelayMs = 20000,
    backoffFactor = 2,
    log = defaultLog,
    op = "unknown",
  } = options;

  // Fail fast on invalid input. Each check names the offending option and
  // value. Without these guards, NaN/Infinity/below-min values could bypass
  // the loop entirely and cause `throw lastError` to throw literal `undefined`.
  validateNumberOption("maxAttempts", maxAttempts, { min: 1, requireInteger: true });
  validateNumberOption("initialDelayMs", initialDelayMs, { min: 0 });
  validateNumberOption("maxDelayMs", maxDelayMs, { min: 0 });
  validateNumberOption("backoffFactor", backoffFactor, { min: 1 });

  const startedAt = Date.now();
  let delayMs = initialDelayMs;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const value = await operation();
      // Weak-flake leading indicator: emit only when the call succeeded after
      // at least one prior failure. First-try successes stay silent so the
      // event count tracks the body of the transient-failure distribution,
      // not normal traffic.
      if (attempt > 1) {
        log.info(
          {
            event: RETRY_LOG_EVENTS.succeededAfterRetry,
            op,
            attempt,
            max_attempts: maxAttempts,
            elapsed_ms: Date.now() - startedAt,
          },
          "Operation succeeded after retry",
        );
      }
      return value;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const elapsedMs = Date.now() - startedAt;

      if (isNonRetriable(error, lastError)) {
        const status = (error as { status?: number }).status;
        log.warn(
          {
            event: RETRY_LOG_EVENTS.nonRetriable,
            op,
            attempt,
            max_attempts: maxAttempts,
            elapsed_ms: elapsedMs,
            status,
            err: lastError,
          },
          "Non-retriable error, throwing immediately",
        );
        throw lastError;
      }

      // Compute the next delay BEFORE the emit so the line carries the delay
      // that will actually be slept. Omit the field on the final attempt
      // because no sleep will occur (the loop falls through to `exhausted`).
      const willRetry = attempt < maxAttempts;
      log.warn(
        {
          event: RETRY_LOG_EVENTS.attemptFailed,
          op,
          attempt,
          max_attempts: maxAttempts,
          elapsed_ms: elapsedMs,
          ...(willRetry ? { delay_ms: delayMs } : {}),
          err: lastError,
        },
        "Operation attempt failed",
      );

      if (willRetry) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * backoffFactor, maxDelayMs);
      }
    }
  }

  log.error(
    {
      event: RETRY_LOG_EVENTS.exhausted,
      op,
      attempt: maxAttempts,
      max_attempts: maxAttempts,
      elapsed_ms: Date.now() - startedAt,
      err: lastError,
    },
    "Operation failed after all attempts",
  );
  // Safe to assert: `maxAttempts >= 1` is enforced above, so the loop ran
  // at least once, meaning `lastError` was assigned in the catch block.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  throw lastError!;
}

/**
 * Decide whether an error is a permanent 4xx that should bypass retry.
 *
 * Octokit wraps HTTP errors with a `.status` property; non-HTTP errors lack
 * it. A 4xx is non-retriable EXCEPT 429 (Too Many Requests) and a 403 whose
 * message marks a GitHub *secondary* rate limit (delivered as 403, not 429).
 * The secondary-rate-limit marker is inspected only inside the 4xx branch so
 * non-4xx errors skip the string work. See issue #199.
 *
 * Extracted from `retryWithBackoff` so the main loop's complexity stays
 * tractable as more structured-log branches accumulate.
 */
function isNonRetriable(error: unknown, normalized: Error): boolean {
  const status = (error as { status?: number }).status;
  if (status === undefined || status < 400 || status >= 500 || status === 429) {
    return false;
  }
  const isSecondaryRateLimit = normalized.message.toLowerCase().includes("secondary rate limit");
  return !isSecondaryRateLimit;
}
