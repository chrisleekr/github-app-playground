import { describe, expect, it } from "bun:test";

import {
  CIRCUIT_LOG_EVENTS,
  CircuitLogFieldsSchema,
} from "../../src/utils/circuit-breaker-log-fields";

describe("CIRCUIT_LOG_EVENTS", () => {
  it("pins the five canonical event strings", () => {
    expect(CIRCUIT_LOG_EVENTS.opened).toBe("circuit.opened");
    expect(CIRCUIT_LOG_EVENTS.halfOpen).toBe("circuit.half_open");
    expect(CIRCUIT_LOG_EVENTS.closed).toBe("circuit.closed");
    expect(CIRCUIT_LOG_EVENTS.skipped).toBe("circuit.skipped");
    expect(CIRCUIT_LOG_EVENTS.failure).toBe("circuit.failure");
  });
});

describe("CircuitLogFieldsSchema: accepts well-formed events", () => {
  it("accepts a valid circuit.opened record", () => {
    const result = CircuitLogFieldsSchema.safeParse({
      event: CIRCUIT_LOG_EVENTS.opened,
      from: "closed",
      consecutive_failures: 5,
      latency_tripped: false,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid circuit.half_open record", () => {
    const result = CircuitLogFieldsSchema.safeParse({
      event: CIRCUIT_LOG_EVENTS.halfOpen,
      from: "open",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid circuit.closed record", () => {
    const result = CircuitLogFieldsSchema.safeParse({
      event: CIRCUIT_LOG_EVENTS.closed,
      open_ms: 61_000,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid circuit.skipped record", () => {
    const result = CircuitLogFieldsSchema.safeParse({
      event: CIRCUIT_LOG_EVENTS.skipped,
      open_ms: 1_200,
      skips_since_opened: 7,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid circuit.failure record", () => {
    const result = CircuitLogFieldsSchema.safeParse({
      event: CIRCUIT_LOG_EVENTS.failure,
      consecutive_failures: 3,
      max_consecutive_failures: 5,
      latency_tripped: true,
    });
    expect(result.success).toBe(true);
  });
});

describe("CircuitLogFieldsSchema: rejects drift and bad input", () => {
  it("rejects an unknown extra field (strict)", () => {
    const result = CircuitLogFieldsSchema.safeParse({
      event: CIRCUIT_LOG_EVENTS.closed,
      open_ms: 100,
      surprise: "boo",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown event literal", () => {
    const result = CircuitLogFieldsSchema.safeParse({
      event: "circuit.bogus",
      open_ms: 100,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid `from` state enum on circuit.opened", () => {
    const result = CircuitLogFieldsSchema.safeParse({
      event: CIRCUIT_LOG_EVENTS.opened,
      from: "weird",
      consecutive_failures: 5,
      latency_tripped: false,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a circuit.skipped record missing skips_since_opened", () => {
    const result = CircuitLogFieldsSchema.safeParse({
      event: CIRCUIT_LOG_EVENTS.skipped,
      open_ms: 1_200,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a camelCase field where snake_case is pinned", () => {
    const result = CircuitLogFieldsSchema.safeParse({
      event: CIRCUIT_LOG_EVENTS.closed,
      openMs: 100,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-boolean latency_tripped", () => {
    const result = CircuitLogFieldsSchema.safeParse({
      event: CIRCUIT_LOG_EVENTS.failure,
      consecutive_failures: 3,
      max_consecutive_failures: 5,
      latency_tripped: "yes",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative open_ms", () => {
    const result = CircuitLogFieldsSchema.safeParse({
      event: CIRCUIT_LOG_EVENTS.closed,
      open_ms: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer consecutive_failures", () => {
    const result = CircuitLogFieldsSchema.safeParse({
      event: CIRCUIT_LOG_EVENTS.opened,
      from: "closed",
      consecutive_failures: 2.5,
      latency_tripped: false,
    });
    expect(result.success).toBe(false);
  });
});
