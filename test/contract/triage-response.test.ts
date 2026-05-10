/**
 * Contract test for the post-collapse binary triage-response schema.
 * After the dispatch collapse triage returns `{ heavy, confidence, rationale }`
 * no mode, no complexity. The router maps `heavy` onto the ephemeral-daemon
 * scaler signal.
 */

import { describe, expect, it } from "bun:test";

import { TriageResponseSchema } from "../../src/orchestrator/triage";

describe("TriageResponse schema: valid inputs", () => {
  it("accepts a canonical heavy=true response", () => {
    const r = TriageResponseSchema.safeParse({
      heavy: true,
      confidence: 0.85,
      rationale: "Touches migrations + multi-service deployment, high blast radius.",
    });
    expect(r.success).toBe(true);
  });

  it("accepts a canonical heavy=false response", () => {
    const r = TriageResponseSchema.safeParse({
      heavy: false,
      confidence: 0.9,
      rationale: "One-line comment fix; no tests required.",
    });
    expect(r.success).toBe(true);
  });

  it("accepts confidence at the boundaries (0.0 and 1.0)", () => {
    expect(
      TriageResponseSchema.safeParse({ heavy: false, confidence: 0.0, rationale: "x" }).success,
    ).toBe(true);
    expect(
      TriageResponseSchema.safeParse({ heavy: true, confidence: 1.0, rationale: "x" }).success,
    ).toBe(true);
  });

  it("accepts a rationale at the 500-char upper bound", () => {
    const rationale = "x".repeat(500);
    expect(
      TriageResponseSchema.safeParse({ heavy: false, confidence: 0.5, rationale }).success,
    ).toBe(true);
  });
});

describe("TriageResponse schema: invalid inputs", () => {
  it("rejects non-boolean heavy", () => {
    expect(
      TriageResponseSchema.safeParse({ heavy: "true", confidence: 0.5, rationale: "x" }).success,
    ).toBe(false);
    expect(
      TriageResponseSchema.safeParse({ heavy: 1, confidence: 0.5, rationale: "x" }).success,
    ).toBe(false);
  });

  it("rejects legacy pre-collapse shape (mode/complexity)", () => {
    // Schema is `.strict()`, missing required `heavy` *or* extra
    // legacy keys is enough to fail. Cover both so future contributors
    // know the unknown-key rejection is intentional.
    const missingHeavy = TriageResponseSchema.safeParse({
      mode: "daemon",
      confidence: 0.5,
      complexity: "trivial",
      rationale: "legacy shape",
    });
    expect(missingHeavy.success).toBe(false);

    const legacyKeysPresent = TriageResponseSchema.safeParse({
      heavy: true,
      confidence: 0.5,
      rationale: "legacy fields present",
      mode: "daemon",
      complexity: "trivial",
    });
    expect(legacyKeysPresent.success).toBe(false);
  });

  it("rejects confidence outside [0, 1]", () => {
    expect(
      TriageResponseSchema.safeParse({ heavy: true, confidence: 1.01, rationale: "x" }).success,
    ).toBe(false);
    expect(
      TriageResponseSchema.safeParse({ heavy: true, confidence: -0.01, rationale: "x" }).success,
    ).toBe(false);
  });

  it("rejects an empty rationale (min 1 char)", () => {
    expect(
      TriageResponseSchema.safeParse({ heavy: false, confidence: 0.5, rationale: "" }).success,
    ).toBe(false);
  });

  it("rejects a rationale above the 500-char upper bound", () => {
    const rationale = "x".repeat(501);
    expect(
      TriageResponseSchema.safeParse({ heavy: false, confidence: 0.5, rationale }).success,
    ).toBe(false);
  });

  it("rejects missing required fields", () => {
    expect(TriageResponseSchema.safeParse({}).success).toBe(false);
    expect(TriageResponseSchema.safeParse({ heavy: true }).success).toBe(false);
    expect(TriageResponseSchema.safeParse({ heavy: true, confidence: 0.5 }).success).toBe(false);
  });

  it("rejects non-object input", () => {
    expect(TriageResponseSchema.safeParse(null).success).toBe(false);
    expect(TriageResponseSchema.safeParse("heavy").success).toBe(false);
    expect(TriageResponseSchema.safeParse(42).success).toBe(false);
    expect(TriageResponseSchema.safeParse([]).success).toBe(false);
  });
});
