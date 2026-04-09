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
 * Assert that a promise rejects with an error whose message contains `messageSubstring`.
 * Fails the test if the promise resolves or if the error message does not match.
 *
 * @param promise - The promise expected to reject
 * @param messageSubstring - Substring expected in the thrown Error's message
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
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toContain(messageSubstring);
}
