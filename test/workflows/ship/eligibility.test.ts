/**
 * Tests for src/workflows/ship/eligibility.ts (FR-015 four refusal cases).
 * Mocks octokit.graphql per Constitution V; tests the verdict logic.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { config } from "../../../src/config";
import { checkEligibility } from "../../../src/workflows/ship/eligibility";

interface MockPr {
  state: "OPEN" | "CLOSED" | "MERGED";
  merged: boolean;
  baseRefName: string;
  baseRepoId: string;
  headRepoId: string | null;
}

const ORIGINAL_ALLOWED = process.env["ALLOWED_OWNERS"];
const ORIGINAL_FORBIDDEN = process.env["SHIP_FORBIDDEN_TARGET_BRANCHES"];

// Snapshot the live config singleton so per-test overrides can restore.
// `loadConfig()` only runs once at module load, so test mutations of
// `process.env` don't reach `config.*`; the test mutates the object
// directly and restores in afterEach.
const ORIGINAL_CONFIG_ALLOWED = config.allowedOwners;
const ORIGINAL_CONFIG_FORBIDDEN = config.shipForbiddenTargetBranches;
const mutableConfig = config as unknown as {
  allowedOwners: readonly string[] | undefined;
  shipForbiddenTargetBranches: readonly string[];
};

function makeOctokit(pr: MockPr | null): {
  graphql: (query: string, vars: unknown) => Promise<unknown>;
} {
  return {
    graphql: () =>
      Promise.resolve({
        repository: {
          pullRequest:
            pr === null
              ? null
              : {
                  state: pr.state,
                  merged: pr.merged,
                  baseRefName: pr.baseRefName,
                  baseRepository: { id: pr.baseRepoId },
                  headRepository: pr.headRepoId === null ? null : { id: pr.headRepoId },
                  author: { login: "alice" },
                },
        },
      }),
  };
}

const okPr: MockPr = {
  state: "OPEN",
  merged: false,
  baseRefName: "main",
  baseRepoId: "repo-1",
  headRepoId: "repo-1",
};

describe("checkEligibility", () => {
  beforeEach(() => {
    delete process.env["ALLOWED_OWNERS"];
    delete process.env["SHIP_FORBIDDEN_TARGET_BRANCHES"];
    mutableConfig.allowedOwners = undefined;
    mutableConfig.shipForbiddenTargetBranches = [];
  });

  afterEach(() => {
    if (ORIGINAL_ALLOWED !== undefined) process.env["ALLOWED_OWNERS"] = ORIGINAL_ALLOWED;
    if (ORIGINAL_FORBIDDEN !== undefined)
      process.env["SHIP_FORBIDDEN_TARGET_BRANCHES"] = ORIGINAL_FORBIDDEN;
    mutableConfig.allowedOwners = ORIGINAL_CONFIG_ALLOWED;
    mutableConfig.shipForbiddenTargetBranches = ORIGINAL_CONFIG_FORBIDDEN;
  });

  it("returns eligible:true for an open in-repo PR with no restrictions", async () => {
    const v = await checkEligibility({
      octokit: makeOctokit(okPr),
      owner: "chrisleekr",
      repo: "github-app-playground",
      pr_number: 1,
      triggeringUserLogin: "alice",
    });
    expect(v.eligible).toBe(true);
  });

  it("rejects fork PRs", async () => {
    const v = await checkEligibility({
      octokit: makeOctokit({ ...okPr, headRepoId: "repo-fork" }),
      owner: "chrisleekr",
      repo: "github-app-playground",
      pr_number: 1,
      triggeringUserLogin: "alice",
    });
    expect(v.eligible).toBe(false);
    if (!v.eligible) expect(v.reason).toBe("fork");
  });

  it("rejects closed PRs", async () => {
    const v = await checkEligibility({
      octokit: makeOctokit({ ...okPr, state: "CLOSED" }),
      owner: "chrisleekr",
      repo: "github-app-playground",
      pr_number: 1,
      triggeringUserLogin: "alice",
    });
    expect(v.eligible).toBe(false);
    if (!v.eligible) expect(v.reason).toBe("closed");
  });

  it("rejects merged PRs", async () => {
    const v = await checkEligibility({
      octokit: makeOctokit({ ...okPr, state: "MERGED", merged: true }),
      owner: "chrisleekr",
      repo: "github-app-playground",
      pr_number: 1,
      triggeringUserLogin: "alice",
    });
    expect(v.eligible).toBe(false);
    if (!v.eligible) expect(v.reason).toBe("merged");
  });

  it("rejects when triggering user is not in ALLOWED_OWNERS", async () => {
    mutableConfig.allowedOwners = ["carol", "dave"];
    const v = await checkEligibility({
      octokit: makeOctokit(okPr),
      owner: "chrisleekr",
      repo: "github-app-playground",
      pr_number: 1,
      triggeringUserLogin: "alice",
    });
    expect(v.eligible).toBe(false);
    if (!v.eligible) expect(v.reason).toBe("unauthorized");
  });

  it("rejects when target branch is in SHIP_FORBIDDEN_TARGET_BRANCHES", async () => {
    mutableConfig.shipForbiddenTargetBranches = ["main", "release"];
    const v = await checkEligibility({
      octokit: makeOctokit({ ...okPr, baseRefName: "main" }),
      owner: "chrisleekr",
      repo: "github-app-playground",
      pr_number: 1,
      triggeringUserLogin: "alice",
    });
    expect(v.eligible).toBe(false);
    if (!v.eligible) expect(v.reason).toBe("forbidden_target_branch");
  });
});
