/**
 * T054: round-trip a sample log line through the Zod schema. Catches
 * silent drift between emitters and the canonical field schema.
 */

import { describe, expect, it } from "bun:test";

import { ShipLogFieldsSchema, usdToCents } from "../../../src/workflows/ship/log-fields";

const validBase = {
  event: "ship.intent.transition",
  intent_id: "550e8400-e29b-41d4-a716-446655440000",
  pr: { owner: "acme", repo: "repo", number: 42, installation_id: 99 },
  iteration_n: 0,
  spent_usd_cents: 0,
  wall_clock_ms: 0,
};

describe("ShipLogFieldsSchema", () => {
  it("accepts a minimal valid line", () => {
    const result = ShipLogFieldsSchema.safeParse(validBase);
    expect(result.success).toBe(true);
  });

  it("accepts a transition line with optional fields populated", () => {
    const result = ShipLogFieldsSchema.safeParse({
      ...validBase,
      from_status: "active",
      to_status: "ready_awaiting_human_merge",
      iteration_n: 7,
      spent_usd_cents: 142,
      wall_clock_ms: 60_000,
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown fields (drift guard)", () => {
    const result = ShipLogFieldsSchema.safeParse({
      ...validBase,
      mystery_field: "oops",
    });
    expect(result.success).toBe(false);
  });

  it("rejects float for spent_usd_cents (must be integer cents)", () => {
    const result = ShipLogFieldsSchema.safeParse({ ...validBase, spent_usd_cents: 1.5 });
    expect(result.success).toBe(false);
  });

  it("rejects non-uuid intent_id", () => {
    const result = ShipLogFieldsSchema.safeParse({ ...validBase, intent_id: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("rejects invalid SessionStatus on to_status", () => {
    const result = ShipLogFieldsSchema.safeParse({ ...validBase, to_status: "made-up" });
    expect(result.success).toBe(false);
  });
});

describe("usdToCents", () => {
  it("converts standard amounts", () => {
    expect(usdToCents(1)).toBe(100);
    expect(usdToCents(0.42)).toBe(42);
    expect(usdToCents(0.005)).toBe(1);
  });
  it("returns 0 for non-finite or negative", () => {
    expect(usdToCents(Number.NaN)).toBe(0);
    expect(usdToCents(-1)).toBe(0);
    expect(usdToCents(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
