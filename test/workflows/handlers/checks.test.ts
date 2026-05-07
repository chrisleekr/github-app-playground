/**
 * Unit tests for the canonical "all-green" check evaluator (issue #93).
 *
 * Mirrors the prompt-level definition in `resolve.ts` step 6 verbatim — a
 * check is failing iff `status === "completed"` AND `conclusion` is one of
 * `failure`, `cancelled`, `timed_out`, `action_required`. `skipped`,
 * `neutral`, and `success` are acceptable terminal states.
 */

import { describe, expect, it } from "bun:test";

import { evaluateCheckRuns } from "../../../src/workflows/handlers/checks";

describe("evaluateCheckRuns", () => {
  it("returns allGreen=true for an empty list", () => {
    expect(evaluateCheckRuns([])).toEqual({ allGreen: true, failingChecks: [] });
  });

  it("treats success / neutral / skipped as green", () => {
    const result = evaluateCheckRuns([
      { status: "completed", conclusion: "success", name: "lint" },
      { status: "completed", conclusion: "neutral", name: "informational" },
      { status: "completed", conclusion: "skipped", name: "optional" },
    ]);
    expect(result).toEqual({ allGreen: true, failingChecks: [] });
  });

  it("flags every failing-conclusion variant", () => {
    const result = evaluateCheckRuns([
      { status: "completed", conclusion: "failure", name: "test" },
      { status: "completed", conclusion: "cancelled", name: "build" },
      { status: "completed", conclusion: "timed_out", name: "e2e" },
      { status: "completed", conclusion: "action_required", name: "deploy" },
    ]);
    expect(result.allGreen).toBe(false);
    expect(result.failingChecks).toEqual(["test", "build", "e2e", "deploy"]);
  });

  it("ignores in-flight checks (status !== 'completed')", () => {
    const result = evaluateCheckRuns([
      { status: "in_progress", conclusion: null, name: "running" },
      { status: "queued", conclusion: null, name: "pending" },
      { status: "completed", conclusion: "success", name: "done" },
    ]);
    expect(result).toEqual({ allGreen: true, failingChecks: [] });
  });

  it("deduplicates failing checks by name (same check re-run multiple times)", () => {
    const result = evaluateCheckRuns([
      { status: "completed", conclusion: "failure", name: "test" },
      { status: "completed", conclusion: "failure", name: "test" },
      { status: "completed", conclusion: "cancelled", name: "test" },
    ]);
    expect(result.failingChecks).toEqual(["test"]);
  });

  it("returns mixed pass/fail correctly", () => {
    const result = evaluateCheckRuns([
      { status: "completed", conclusion: "success", name: "lint" },
      { status: "completed", conclusion: "failure", name: "test" },
      { status: "completed", conclusion: "skipped", name: "deploy" },
    ]);
    expect(result.allGreen).toBe(false);
    expect(result.failingChecks).toEqual(["test"]);
  });

  it("ignores completed checks with null conclusion (defensive)", () => {
    const result = evaluateCheckRuns([{ status: "completed", conclusion: null, name: "weird" }]);
    expect(result).toEqual({ allGreen: true, failingChecks: [] });
  });
});
