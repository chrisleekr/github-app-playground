import { describe, expect, it } from "bun:test";

import { RETRY_LOG_EVENTS, RetryLogFieldsSchema } from "../../src/utils/retry-log-fields";

describe("RETRY_LOG_EVENTS", () => {
  it("pins the four canonical event strings", () => {
    expect(RETRY_LOG_EVENTS.attemptFailed).toBe("retry.attempt_failed");
    expect(RETRY_LOG_EVENTS.nonRetriable).toBe("retry.non_retriable");
    expect(RETRY_LOG_EVENTS.exhausted).toBe("retry.exhausted");
    expect(RETRY_LOG_EVENTS.succeededAfterRetry).toBe("retry.succeeded_after_retry");
  });
});

describe("RetryLogFieldsSchema: accepts well-formed events", () => {
  it("accepts retry.attempt_failed with delay_ms (an attempt before the last)", () => {
    const result = RetryLogFieldsSchema.safeParse({
      event: RETRY_LOG_EVENTS.attemptFailed,
      op: "github.fetch",
      attempt: 1,
      max_attempts: 3,
      elapsed_ms: 42,
      delay_ms: 5000,
    });
    expect(result.success).toBe(true);
  });

  it("accepts retry.attempt_failed without delay_ms (the final attempt)", () => {
    const result = RetryLogFieldsSchema.safeParse({
      event: RETRY_LOG_EVENTS.attemptFailed,
      op: "github.fetch",
      attempt: 3,
      max_attempts: 3,
      elapsed_ms: 15_000,
    });
    expect(result.success).toBe(true);
  });

  it("accepts retry.non_retriable with status", () => {
    const result = RetryLogFieldsSchema.safeParse({
      event: RETRY_LOG_EVENTS.nonRetriable,
      op: "github.fetch",
      attempt: 1,
      max_attempts: 3,
      elapsed_ms: 12,
      status: 404,
    });
    expect(result.success).toBe(true);
  });

  it("accepts retry.exhausted", () => {
    const result = RetryLogFieldsSchema.safeParse({
      event: RETRY_LOG_EVENTS.exhausted,
      op: "github.fetch",
      attempt: 3,
      max_attempts: 3,
      elapsed_ms: 30_000,
    });
    expect(result.success).toBe(true);
  });

  it("accepts retry.succeeded_after_retry", () => {
    const result = RetryLogFieldsSchema.safeParse({
      event: RETRY_LOG_EVENTS.succeededAfterRetry,
      op: "github.fetch",
      attempt: 2,
      max_attempts: 3,
      elapsed_ms: 5_100,
    });
    expect(result.success).toBe(true);
  });
});

describe("RetryLogFieldsSchema: rejects field-name drift", () => {
  it("rejects camelCase delayMs (must be delay_ms)", () => {
    const result = RetryLogFieldsSchema.safeParse({
      event: RETRY_LOG_EVENTS.attemptFailed,
      op: "github.fetch",
      attempt: 1,
      max_attempts: 3,
      elapsed_ms: 42,
      delayMs: 5000,
    });
    expect(result.success).toBe(false);
  });

  it("rejects camelCase elapsedMs (must be elapsed_ms)", () => {
    const result = RetryLogFieldsSchema.safeParse({
      event: RETRY_LOG_EVENTS.attemptFailed,
      op: "github.fetch",
      attempt: 1,
      max_attempts: 3,
      elapsedMs: 42,
    });
    expect(result.success).toBe(false);
  });

  it("rejects camelCase maxAttempts (must be max_attempts)", () => {
    const result = RetryLogFieldsSchema.safeParse({
      event: RETRY_LOG_EVENTS.attemptFailed,
      op: "github.fetch",
      attempt: 1,
      maxAttempts: 3,
      elapsed_ms: 42,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown event literal", () => {
    const result = RetryLogFieldsSchema.safeParse({
      event: "retry.something_else",
      op: "github.fetch",
      attempt: 1,
      max_attempts: 3,
      elapsed_ms: 42,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown extra field (strict)", () => {
    const result = RetryLogFieldsSchema.safeParse({
      event: RETRY_LOG_EVENTS.attemptFailed,
      op: "github.fetch",
      attempt: 1,
      max_attempts: 3,
      elapsed_ms: 42,
      surprise: "boo",
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative elapsed_ms", () => {
    const result = RetryLogFieldsSchema.safeParse({
      event: RETRY_LOG_EVENTS.exhausted,
      op: "github.fetch",
      attempt: 3,
      max_attempts: 3,
      elapsed_ms: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer attempt", () => {
    const result = RetryLogFieldsSchema.safeParse({
      event: RETRY_LOG_EVENTS.attemptFailed,
      op: "github.fetch",
      attempt: 1.5,
      max_attempts: 3,
      elapsed_ms: 42,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty op", () => {
    const result = RetryLogFieldsSchema.safeParse({
      event: RETRY_LOG_EVENTS.attemptFailed,
      op: "",
      attempt: 1,
      max_attempts: 3,
      elapsed_ms: 42,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing op", () => {
    const result = RetryLogFieldsSchema.safeParse({
      event: RETRY_LOG_EVENTS.attemptFailed,
      attempt: 1,
      max_attempts: 3,
      elapsed_ms: 42,
    });
    expect(result.success).toBe(false);
  });
});

describe("RetryLogFieldsSchema: per-event field constraints (discriminated union)", () => {
  it("rejects retry.non_retriable without status (status is required on this branch)", () => {
    const result = RetryLogFieldsSchema.safeParse({
      event: RETRY_LOG_EVENTS.nonRetriable,
      op: "github.fetch",
      attempt: 1,
      max_attempts: 3,
      elapsed_ms: 12,
    });
    expect(result.success).toBe(false);
  });

  it("rejects retry.exhausted with delay_ms (no sleep follows the exhausted emit)", () => {
    const result = RetryLogFieldsSchema.safeParse({
      event: RETRY_LOG_EVENTS.exhausted,
      op: "github.fetch",
      attempt: 3,
      max_attempts: 3,
      elapsed_ms: 30_000,
      delay_ms: 5000,
    });
    expect(result.success).toBe(false);
  });

  it("rejects retry.succeeded_after_retry with delay_ms (no retry follows success)", () => {
    const result = RetryLogFieldsSchema.safeParse({
      event: RETRY_LOG_EVENTS.succeededAfterRetry,
      op: "github.fetch",
      attempt: 2,
      max_attempts: 3,
      elapsed_ms: 5_100,
      delay_ms: 5000,
    });
    expect(result.success).toBe(false);
  });

  it("rejects retry.succeeded_after_retry with status (only error-bearing events carry status)", () => {
    const result = RetryLogFieldsSchema.safeParse({
      event: RETRY_LOG_EVENTS.succeededAfterRetry,
      op: "github.fetch",
      attempt: 2,
      max_attempts: 3,
      elapsed_ms: 5_100,
      status: 503,
    });
    expect(result.success).toBe(false);
  });

  it("accepts retry.attempt_failed with status (5xx transient failure)", () => {
    const result = RetryLogFieldsSchema.safeParse({
      event: RETRY_LOG_EVENTS.attemptFailed,
      op: "github.fetch",
      attempt: 1,
      max_attempts: 3,
      elapsed_ms: 42,
      delay_ms: 5000,
      status: 503,
    });
    expect(result.success).toBe(true);
  });

  it("accepts retry.attempt_failed without status (non-HTTP error like a connection reset)", () => {
    const result = RetryLogFieldsSchema.safeParse({
      event: RETRY_LOG_EVENTS.attemptFailed,
      op: "github.fetch",
      attempt: 1,
      max_attempts: 3,
      elapsed_ms: 42,
      delay_ms: 5000,
    });
    expect(result.success).toBe(true);
  });
});
