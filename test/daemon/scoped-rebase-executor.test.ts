/**
 * Surface tests for the daemon-side `scoped-rebase` executor (T024).
 * Deeply mocking Bun's `$` shell is tricky so the executor's actual
 * git pipeline is exercised in the policy-layer rebase test (which
 * injects a runMerge stub). This file checks the wire surface — the
 * executor forwards the closed-PR path through to the policy layer
 * without invoking any git commands.
 */

import { describe, expect, it, mock } from "bun:test";

const mockGetPr = mock(() =>
  Promise.resolve({
    data: { state: "closed", merged: false, base: { ref: "main" }, head: { ref: "feat/x" } },
  }),
);
const mockCreateComment = mock(() => Promise.resolve({ data: { id: 4242 } }));

void mock.module("octokit", () => ({
  Octokit: class MockOctokit {
    rest = {
      pulls: { get: mockGetPr },
      issues: { createComment: mockCreateComment },
    };
  },
}));

describe("executeScopedRebase", () => {
  it("returns a `closed` outcome without touching git when the PR is closed", async () => {
    mockGetPr.mockClear();
    mockCreateComment.mockClear();

    const { executeScopedRebase } = await import("../../src/daemon/scoped-rebase-executor");

    const outcome = await executeScopedRebase({
      installationToken: "tok",
      installationId: 1,
      owner: "octo",
      repo: "repo",
      prNumber: 7,
    });

    expect(outcome.kind).toBe("closed");
    expect(mockGetPr).toHaveBeenCalledTimes(1);
    // Policy layer handled the closed-PR comment; no git work runs.
    expect(mockCreateComment).toHaveBeenCalledTimes(1);
  });
});
