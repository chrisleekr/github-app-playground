/**
 * Unit tests for the canonical "all-green" check evaluator (issue #93).
 *
 * Mirrors the prompt-level definition in `resolve.ts` step 6 verbatim — a
 * check is failing iff `status === "completed"` AND `conclusion` is one of
 * `failure`, `cancelled`, `timed_out`, `action_required`. `skipped`,
 * `neutral`, and `success` are acceptable terminal states. In-flight checks
 * (`queued`/`in_progress`/`waiting`/`pending`) are tracked as `pendingChecks`
 * and block `allGreen`.
 */

import { describe, expect, it } from "bun:test";

import { evaluateCheckRuns } from "../../../src/workflows/handlers/checks";

describe("evaluateCheckRuns", () => {
  it("returns allGreen=true for an empty list", () => {
    expect(evaluateCheckRuns([])).toEqual({
      allGreen: true,
      failingChecks: [],
      pendingChecks: [],
    });
  });

  it("treats success / neutral / skipped as green", () => {
    const result = evaluateCheckRuns([
      { status: "completed", conclusion: "success", name: "lint" },
      { status: "completed", conclusion: "neutral", name: "informational" },
      { status: "completed", conclusion: "skipped", name: "optional" },
    ]);
    expect(result).toEqual({ allGreen: true, failingChecks: [], pendingChecks: [] });
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
    expect(result.pendingChecks).toEqual([]);
  });

  it("tracks in-flight checks as pending and blocks allGreen", () => {
    const result = evaluateCheckRuns([
      { status: "in_progress", conclusion: null, name: "running" },
      { status: "queued", conclusion: null, name: "queued-job" },
      { status: "completed", conclusion: "success", name: "done" },
    ]);
    expect(result.allGreen).toBe(false);
    expect(result.failingChecks).toEqual([]);
    expect(result.pendingChecks).toEqual(["running", "queued-job"]);
  });

  it("deduplicates failing checks by name (same check re-run multiple times)", () => {
    const result = evaluateCheckRuns([
      { status: "completed", conclusion: "failure", name: "test" },
      { status: "completed", conclusion: "failure", name: "test" },
      { status: "completed", conclusion: "cancelled", name: "test" },
    ]);
    expect(result.failingChecks).toEqual(["test"]);
    expect(result.pendingChecks).toEqual([]);
  });

  it("deduplicates pending checks by name", () => {
    const result = evaluateCheckRuns([
      { status: "queued", conclusion: null, name: "test" },
      { status: "in_progress", conclusion: null, name: "test" },
    ]);
    expect(result.pendingChecks).toEqual(["test"]);
  });

  it("returns mixed pass/fail correctly", () => {
    const result = evaluateCheckRuns([
      { status: "completed", conclusion: "success", name: "lint" },
      { status: "completed", conclusion: "failure", name: "test" },
      { status: "completed", conclusion: "skipped", name: "deploy" },
    ]);
    expect(result.allGreen).toBe(false);
    expect(result.failingChecks).toEqual(["test"]);
    expect(result.pendingChecks).toEqual([]);
  });

  it("ignores completed checks with null conclusion (defensive)", () => {
    const result = evaluateCheckRuns([{ status: "completed", conclusion: null, name: "weird" }]);
    expect(result).toEqual({ allGreen: true, failingChecks: [], pendingChecks: [] });
  });

  it("treats `stale` conclusion as failing (GitHub auto-sets after 14d incomplete)", () => {
    const result = evaluateCheckRuns([{ status: "completed", conclusion: "stale", name: "stuck" }]);
    expect(result.allGreen).toBe(false);
    expect(result.failingChecks).toEqual(["stuck"]);
  });

  it("treats `requested` status as pending (rerun queued but not yet running)", () => {
    const result = evaluateCheckRuns([{ status: "requested", conclusion: null, name: "rerun" }]);
    expect(result.allGreen).toBe(false);
    expect(result.pendingChecks).toEqual(["rerun"]);
  });
});
