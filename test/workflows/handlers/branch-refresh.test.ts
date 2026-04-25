/**
 * Unit tests for the branch-refresh helper that drives the auto-rebase
 * directive in the `review` and `resolve` handler prompts.
 *
 * The directive has three branches:
 *   - up-to-date  → no-op message
 *   - fork PR     → defer to contributor (can't force-push to a fork)
 *   - same-repo behind base → rebase + force-with-lease + push
 *
 * These tests exercise each branch's wording so the agent receives the
 * correct instructions.
 */

import { describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";

import {
  type BranchStaleness,
  formatRefreshDirective,
  getBranchStaleness,
} from "../../../src/workflows/handlers/branch-refresh";

function buildOctokit(opts: {
  headFullName: string;
  baseFullName: string;
  behindBy: number;
  aheadBy: number;
}): Octokit {
  return {
    rest: {
      pulls: {
        get: mock(async () =>
          Promise.resolve({
            data: {
              head: {
                ref: "feature/x",
                label: "acme:feature/x",
                repo: { full_name: opts.headFullName },
              },
              base: { ref: "main", repo: { full_name: opts.baseFullName } },
            },
          }),
        ),
      },
      repos: {
        compareCommitsWithBasehead: mock(async () =>
          Promise.resolve({ data: { behind_by: opts.behindBy, ahead_by: opts.aheadBy } }),
        ),
      },
    },
  } as unknown as Octokit;
}

describe("getBranchStaleness", () => {
  it("returns up-to-date metadata for a same-repo, no-behind branch", async () => {
    const octokit = buildOctokit({
      headFullName: "acme/widgets",
      baseFullName: "acme/widgets",
      behindBy: 0,
      aheadBy: 4,
    });
    const result = await getBranchStaleness(octokit, "acme", "widgets", 99);
    expect(result.commitsBehindBase).toBe(0);
    expect(result.commitsAheadOfBase).toBe(4);
    expect(result.isFork).toBe(false);
    expect(result.headRef).toBe("feature/x");
    expect(result.baseRef).toBe("main");
  });

  it("flags fork PRs as isFork=true", async () => {
    const octokit = buildOctokit({
      headFullName: "fork/widgets",
      baseFullName: "acme/widgets",
      behindBy: 12,
      aheadBy: 2,
    });
    const result = await getBranchStaleness(octokit, "acme", "widgets", 99);
    expect(result.isFork).toBe(true);
    expect(result.commitsBehindBase).toBe(12);
  });
});

describe("formatRefreshDirective", () => {
  const baseSt: BranchStaleness = {
    commitsBehindBase: 0,
    commitsAheadOfBase: 5,
    isFork: false,
    headRef: "feature/foo",
    baseRef: "main",
  };

  it("emits a no-op message when behind=0", () => {
    const out = formatRefreshDirective(baseSt);
    expect(out).toContain("up-to-date");
    expect(out).toContain("0 commits behind");
    expect(out).not.toContain("git rebase");
  });

  it("instructs rebase + force-with-lease when same-repo branch is behind", () => {
    const out = formatRefreshDirective({ ...baseSt, commitsBehindBase: 3 });
    expect(out).toContain("3 commits behind");
    expect(out).toContain("git rebase origin/main");
    expect(out).toContain("--force-with-lease");
    // The fork-only branch tells the agent to comment on the PR for the
    // contributor; the same-repo branch must NOT include that escape hatch.
    expect(out).not.toContain("gh pr comment");
  });

  it("warns and defers to contributor on fork PRs (cannot push to fork)", () => {
    const out = formatRefreshDirective({ ...baseSt, commitsBehindBase: 7, isFork: true });
    expect(out).toContain("7 commits behind");
    expect(out).toContain("fork");
    expect(out).toContain("contributor");
    expect(out).not.toContain("--force-with-lease");
  });

  it("conflict-resolution guidance is included so the agent doesn't take ours/theirs blindly", () => {
    const out = formatRefreshDirective({ ...baseSt, commitsBehindBase: 1 });
    expect(out).toContain("conflicts");
    expect(out).toContain("typecheck");
    expect(out).toMatch(/do not take.*blindly/i);
  });
});
