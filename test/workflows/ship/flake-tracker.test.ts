/**
 * Tests for `src/workflows/ship/flake-tracker.ts` (T035, FR-014/014a).
 */

import { describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";

import {
  type CheckHistoryEntry,
  identifyFlakedRequiredChecks,
  renderFlakeAnnotation,
  triggerTargetedRerun,
} from "../../../src/workflows/ship/flake-tracker";

const sha = "deadbeefcafe1234567890abcdef1234567890ab";

function entry(
  opts: Partial<CheckHistoryEntry> & { check_name: string; conclusion: string },
): CheckHistoryEntry {
  return {
    head_sha: sha,
    check_name: opts.check_name,
    conclusion: opts.conclusion,
    is_required: opts.is_required ?? true,
    check_run_id: opts.check_run_id ?? 1,
  };
}

describe("identifyFlakedRequiredChecks", () => {
  it("flags a required check that oscillated FAILURE → SUCCESS", () => {
    const flakes = identifyFlakedRequiredChecks([
      entry({ check_name: "ci", conclusion: "FAILURE" }),
      entry({ check_name: "ci", conclusion: "SUCCESS" }),
    ]);
    expect(flakes.length).toBe(1);
    expect(flakes[0]?.check_name).toBe("ci");
  });

  it("does NOT flag consistent failure (no oscillation)", () => {
    const flakes = identifyFlakedRequiredChecks([
      entry({ check_name: "ci", conclusion: "FAILURE" }),
      entry({ check_name: "ci", conclusion: "FAILURE" }),
    ]);
    expect(flakes.length).toBe(0);
  });

  it("excludes non-required flakes from the gating set", () => {
    const flakes = identifyFlakedRequiredChecks([
      entry({ check_name: "extras", conclusion: "FAILURE", is_required: false }),
      entry({ check_name: "extras", conclusion: "SUCCESS", is_required: false }),
    ]);
    expect(flakes.length).toBe(0);
  });
});

describe("renderFlakeAnnotation", () => {
  it("returns empty string when no flakes", () => {
    expect(renderFlakeAnnotation([])).toBe("");
  });

  it("lists each flaked required check", () => {
    const out = renderFlakeAnnotation([
      entry({ check_name: "lint", conclusion: "FAILURE" }),
      entry({ check_name: "lint", conclusion: "SUCCESS" }),
    ]);
    expect(out).toContain("lint");
    expect(out).toContain(sha.slice(0, 7));
  });
});

describe("triggerTargetedRerun", () => {
  it("calls rerequestRun for each check with a non-null id", async () => {
    const rerequestRun = mock(() => Promise.resolve({}));
    const octokit = { rest: { checks: { rerequestRun } } } as unknown as Octokit;
    await triggerTargetedRerun({
      octokit,
      owner: "acme",
      repo: "repo",
      checks: [
        { check_name: "ci", head_sha: sha, is_required: true, check_run_id: 11 },
        { check_name: "ci2", head_sha: sha, is_required: true, check_run_id: null },
      ],
    });
    expect(rerequestRun).toHaveBeenCalledTimes(1);
    expect(rerequestRun.mock.calls[0]?.[0]).toMatchObject({
      owner: "acme",
      repo: "repo",
      check_run_id: 11,
    });
  });
});
