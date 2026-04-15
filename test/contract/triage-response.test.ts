/**
 * Contract test for the triage-response JSON schema (T027).
 *
 * Validates that the Zod schema in `src/orchestrator/triage.ts` stays in
 * lock-step with the JSON Schema in
 * `specs/.../contracts/triage-response.schema.json`. Drift causes a
 * production incident (the router would accept responses the model's
 * API documentation says it won't emit, or reject ones it will).
 */

import { describe, expect, it } from "bun:test";

import { TriageResponseSchema } from "../../src/orchestrator/triage";

describe("TriageResponse schema — valid inputs", () => {
  it("accepts a canonical daemon response", () => {
    const r = TriageResponseSchema.safeParse({
      mode: "daemon",
      confidence: 0.85,
      complexity: "moderate",
      rationale: "Adds one endpoint and a unit test; standard tooling suffices.",
    });
    expect(r.success).toBe(true);
  });

  it("accepts each of the 3 modes × 3 complexities (9 combos)", () => {
    const modes = ["daemon", "shared-runner", "isolated-job"] as const;
    const complexities = ["trivial", "moderate", "complex"] as const;
    for (const mode of modes) {
      for (const complexity of complexities) {
        const r = TriageResponseSchema.safeParse({
          mode,
          confidence: 0.5,
          complexity,
          rationale: "ok",
        });
        expect(r.success).toBe(true);
      }
    }
  });

  it("accepts confidence at the boundaries (0.0 and 1.0)", () => {
    expect(
      TriageResponseSchema.safeParse({
        mode: "daemon",
        confidence: 0.0,
        complexity: "trivial",
        rationale: "x",
      }).success,
    ).toBe(true);
    expect(
      TriageResponseSchema.safeParse({
        mode: "daemon",
        confidence: 1.0,
        complexity: "trivial",
        rationale: "x",
      }).success,
    ).toBe(true);
  });

  it("accepts a rationale at the 500-char upper bound", () => {
    const rationale = "x".repeat(500);
    expect(
      TriageResponseSchema.safeParse({
        mode: "daemon",
        confidence: 0.5,
        complexity: "trivial",
        rationale,
      }).success,
    ).toBe(true);
  });
});

describe("TriageResponse schema — invalid inputs", () => {
  it("rejects an unknown mode (schema drift)", () => {
    const r = TriageResponseSchema.safeParse({
      mode: "inline",
      confidence: 0.9,
      complexity: "trivial",
      rationale: "inline is not a triage target",
    });
    expect(r.success).toBe(false);
  });

  it("rejects confidence outside [0, 1]", () => {
    expect(
      TriageResponseSchema.safeParse({
        mode: "daemon",
        confidence: 1.01,
        complexity: "trivial",
        rationale: "x",
      }).success,
    ).toBe(false);
    expect(
      TriageResponseSchema.safeParse({
        mode: "daemon",
        confidence: -0.01,
        complexity: "trivial",
        rationale: "x",
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown complexity value", () => {
    const r = TriageResponseSchema.safeParse({
      mode: "daemon",
      confidence: 0.5,
      complexity: "epic",
      rationale: "x",
    });
    expect(r.success).toBe(false);
  });

  it("rejects an empty rationale (min 1 char)", () => {
    expect(
      TriageResponseSchema.safeParse({
        mode: "daemon",
        confidence: 0.5,
        complexity: "trivial",
        rationale: "",
      }).success,
    ).toBe(false);
  });

  it("rejects a rationale above the 500-char upper bound", () => {
    const rationale = "x".repeat(501);
    expect(
      TriageResponseSchema.safeParse({
        mode: "daemon",
        confidence: 0.5,
        complexity: "trivial",
        rationale,
      }).success,
    ).toBe(false);
  });

  it("rejects missing required fields", () => {
    expect(TriageResponseSchema.safeParse({}).success).toBe(false);
    expect(TriageResponseSchema.safeParse({ mode: "daemon" }).success).toBe(false);
    expect(
      TriageResponseSchema.safeParse({
        mode: "daemon",
        confidence: 0.5,
        complexity: "trivial",
      }).success,
    ).toBe(false);
  });

  it("rejects null input", () => {
    expect(TriageResponseSchema.safeParse(null).success).toBe(false);
  });

  it("rejects non-object input (string, number, array)", () => {
    expect(TriageResponseSchema.safeParse("daemon").success).toBe(false);
    expect(TriageResponseSchema.safeParse(42).success).toBe(false);
    expect(TriageResponseSchema.safeParse([]).success).toBe(false);
  });
});
