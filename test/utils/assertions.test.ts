/**
 * Tests for the test assertion helpers themselves.
 *
 * These helpers are exercised transitively by the main test suite, but that
 * transitive use does not cover their diagnostic/timeout error paths (non-Error
 * rejection in expectToReject, deadline exhaustion in waitFor). This file
 * covers those paths so `test/utils/assertions.ts` meets the per-file coverage
 * threshold.
 */

import { describe, expect, it } from "bun:test";

import { expectToReject, waitFor } from "./assertions";

describe("expectToReject", () => {
  it("succeeds when the promise rejects with an Error containing the substring", async () => {
    const promise = Promise.reject(new Error("boom: something went wrong"));
    await expectToReject(promise, "boom");
  });

  it("throws a diagnostic Error when the rejection is not an Error instance (string)", async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors, prefer-promise-reject-errors -- testing the non-Error diagnostic path intentionally
    const promise = Promise.reject("raw string rejection");
    let caught: unknown;
    try {
      await expectToReject(promise, "anything");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toContain("expectToReject: expected rejection to be an Error instance");
    expect(msg).toContain("got string");
    expect(msg).toContain("raw string rejection");
  });

  it("throws a diagnostic Error when the rejection is a plain object", async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors, prefer-promise-reject-errors -- testing the non-Error diagnostic path intentionally
    const promise = Promise.reject({ code: "E_BAD" });
    let caught: unknown;
    try {
      await expectToReject(promise, "anything");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("got object");
  });
});

describe("waitFor", () => {
  it("returns immediately when the predicate is already true", async () => {
    const start = Date.now();
    await waitFor(() => true);
    const elapsed = Date.now() - start;
    // Should return without waiting a full poll interval
    expect(elapsed).toBeLessThan(50);
  });

  it("returns once the predicate transitions to true", async () => {
    let flipped = false;
    setTimeout(() => {
      flipped = true;
    }, 20);
    await waitFor(() => flipped, { timeoutMs: 500, intervalMs: 5 });
    expect(flipped).toBe(true);
  });

  it("throws a descriptive Error when the predicate never becomes true within timeoutMs", async () => {
    let caught: unknown;
    try {
      await waitFor(() => false, { timeoutMs: 30, intervalMs: 5 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toContain("waitFor: predicate did not become true within");
    expect(msg).toContain("30ms");
  });
});
