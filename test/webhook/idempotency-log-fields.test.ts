import { describe, expect, it } from "bun:test";

import {
  IDEMPOTENCY_LOG_EVENTS,
  IdempotencyLogFieldsSchema,
} from "../../src/webhook/idempotency-log-fields";

describe("IDEMPOTENCY_LOG_EVENTS", () => {
  it("pins the three canonical event strings", () => {
    expect(IDEMPOTENCY_LOG_EVENTS.claimed).toBe("idempotency.claimed");
    expect(IDEMPOTENCY_LOG_EVENTS.duplicateSkipped).toBe("idempotency.duplicate_skipped");
    expect(IDEMPOTENCY_LOG_EVENTS.failedOpen).toBe("idempotency.failed_open");
  });
});

describe("IdempotencyLogFieldsSchema: accepts well-formed events", () => {
  it("accepts a valid idempotency.claimed record", () => {
    const result = IdempotencyLogFieldsSchema.safeParse({
      event: IDEMPOTENCY_LOG_EVENTS.claimed,
      deliveryId: "d1",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid idempotency.duplicate_skipped record", () => {
    const result = IdempotencyLogFieldsSchema.safeParse({
      event: IDEMPOTENCY_LOG_EVENTS.duplicateSkipped,
      deliveryId: "d1",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid idempotency.failed_open record with reason unavailable", () => {
    const result = IdempotencyLogFieldsSchema.safeParse({
      event: IDEMPOTENCY_LOG_EVENTS.failedOpen,
      deliveryId: "d1",
      reason: "unavailable",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid idempotency.failed_open record with reason error and err", () => {
    const result = IdempotencyLogFieldsSchema.safeParse({
      event: IDEMPOTENCY_LOG_EVENTS.failedOpen,
      deliveryId: "d1",
      reason: "error",
      err: "ECONNREFUSED",
    });
    expect(result.success).toBe(true);
  });
});

describe("IdempotencyLogFieldsSchema: rejects drift and bad input", () => {
  it("rejects an unknown extra field (strict)", () => {
    const result = IdempotencyLogFieldsSchema.safeParse({
      event: IDEMPOTENCY_LOG_EVENTS.claimed,
      deliveryId: "d1",
      surprise: "boo",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown event literal", () => {
    const result = IdempotencyLogFieldsSchema.safeParse({
      event: "idempotency.bogus",
      deliveryId: "d1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid reason on failed_open", () => {
    const result = IdempotencyLogFieldsSchema.safeParse({
      event: IDEMPOTENCY_LOG_EVENTS.failedOpen,
      deliveryId: "d1",
      reason: "weird",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a failed_open record missing reason", () => {
    const result = IdempotencyLogFieldsSchema.safeParse({
      event: IDEMPOTENCY_LOG_EVENTS.failedOpen,
      deliveryId: "d1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty deliveryId", () => {
    const result = IdempotencyLogFieldsSchema.safeParse({
      event: IDEMPOTENCY_LOG_EVENTS.claimed,
      deliveryId: "",
    });
    expect(result.success).toBe(false);
  });
});
