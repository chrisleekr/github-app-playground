import { type Logger, logger as rootLogger } from "../logger";

/**
 * Retry configuration options.
 * Ported from claude-code-action's src/utils/retry.ts
 */
export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  /** Optional scoped logger. Defaults to the root logger when omitted. */
  log?: Logger;
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
    log = rootLogger,
  } = options;

  let delayMs = initialDelayMs;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Do not retry permanent client errors (4xx except 429 Too Many Requests).
      // Octokit wraps HTTP errors with a .status property; non-HTTP errors lack it.
      const status = (error as { status?: number }).status;
      if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
        log.warn({ attempt, status, err: lastError }, "Non-retriable error, throwing immediately");
        throw lastError;
      }

      log.warn({ attempt, maxAttempts, err: lastError }, "Operation attempt failed");

      if (attempt < maxAttempts) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * backoffFactor, maxDelayMs);
      }
    }
  }

  log.error({ maxAttempts }, "Operation failed after all attempts");
  // lastError is guaranteed to be set after at least one failed attempt
  throw lastError as Error;
}
