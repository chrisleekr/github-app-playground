/**
 * Test assertion helpers.
 *
 * Why this file exists: Bun's type declarations for `expect(x).rejects.toThrow(...)`
 * return `void` instead of `Promise<void>`, causing ESLint's `await-thenable` and
 * `no-confusing-void-expression` rules to fire on `await expect(...).rejects.toThrow(...)`
 * patterns even though they work at runtime. Rather than broadly disabling those rules
 * for all test files, we use an explicit try/catch helper that is type-safe.
 */

import { expect } from "bun:test";

/**
 * Assert that a promise rejects with an `Error` instance whose message contains
 * `messageSubstring`. Fails the test if the promise resolves, if the rejection
 * is not an `Error` instance, or if the error message does not match.
 *
 * **Narrow contract**: the rejection value MUST be an `Error` instance. If the
 * caller rejects with a non-Error value (a string, a plain object, `undefined`,
 * etc.), this helper throws an explicit diagnostic error BEFORE the matcher
 * assertion so the test author gets an actionable message instead of a cryptic
 * `toBeInstanceOf` matcher failure. Code that rejects with non-Error values
 * should be fixed at the source (throwing non-Errors is a code smell).
 *
 * @param promise - The promise expected to reject with an `Error` instance.
 * @param messageSubstring - Substring expected in the thrown `Error`'s message.
 * @throws Error with a diagnostic message when the rejection is not an `Error`
 *   instance, identifying the actual type and serialized value.
 */
export async function expectToReject(
  promise: Promise<unknown>,
  messageSubstring: string,
): Promise<void> {
  let threw = false;
  let caught: unknown;
  try {
    await promise;
  } catch (err: unknown) {
    threw = true;
    caught = err;
  }

  expect(threw).toBe(true);
  if (!(caught instanceof Error)) {
    throw new Error(
      `expectToReject: expected rejection to be an Error instance, got ${typeof caught}: ${String(caught)}`,
    );
  }
  expect(caught.message).toContain(messageSubstring);
}

/**
 * Poll `predicate` until it returns `true` or the timeout elapses. Replaces
 * flaky `setTimeout`-based sync points in tests with a deterministic condition
 * wait: the helper returns as soon as the predicate is satisfied rather than
 * blocking for a fixed (and often overly-generous) duration.
 *
 * @param predicate - Synchronous function returning `true` when the awaited
 *   condition has been met. Called on a fixed interval until it returns
 *   truthy or the timeout is exceeded.
 * @param opts - Optional tuning: `timeoutMs` (default 2000) is the maximum
 *   total wait; `intervalMs` (default 5) is the polling cadence.
 * @throws Error with the timeout value when the predicate never returns
 *   `true` within `timeoutMs`.
 */
export async function waitFor(
  predicate: () => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const intervalMs = opts.intervalMs ?? 5;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  if (predicate()) return;
  throw new Error(`waitFor: predicate did not become true within ${String(timeoutMs)}ms`);
}
