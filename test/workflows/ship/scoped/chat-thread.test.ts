import { describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";

import { findReviewThreadByCommentId } from "../../../../src/workflows/ship/scoped/chat-thread";

interface ReviewThreadNode {
  id: string;
  isResolved: boolean;
  comments: { nodes: { databaseId: number }[] };
}

function buildOctokitStub(threads: ReviewThreadNode[]): {
  octokit: Octokit;
  graphqlMock: ReturnType<typeof mock>;
} {
  const graphqlMock = mock(() =>
    Promise.resolve({
      repository: {
        pullRequest: {
          reviewThreads: { nodes: threads },
        },
      },
    }),
  );
  const octokit = { graphql: graphqlMock } as unknown as Octokit;
  return { octokit, graphqlMock };
}

describe("findReviewThreadByCommentId", () => {
  it("returns the thread node-id when a thread's first comment matches the databaseId", async () => {
    const { octokit, graphqlMock } = buildOctokitStub([
      {
        id: "PRT_kwDOAAAAaa",
        isResolved: false,
        comments: { nodes: [{ databaseId: 4242 }] },
      },
    ]);

    const result = await findReviewThreadByCommentId(octokit, "owner", "repo", 113, 4242);

    expect(result).toEqual({ threadNodeId: "PRT_kwDOAAAAaa", alreadyResolved: false });
    expect(graphqlMock).toHaveBeenCalledTimes(1);
    expect(graphqlMock.mock.calls[0]?.[1]).toEqual({ owner: "owner", repo: "repo", pr: 113 });
  });

  it("returns alreadyResolved=true when the matched thread is already resolved", async () => {
    const { octokit } = buildOctokitStub([
      {
        id: "PRT_resolved",
        isResolved: true,
        comments: { nodes: [{ databaseId: 9999 }] },
      },
    ]);

    const result = await findReviewThreadByCommentId(octokit, "owner", "repo", 113, 9999);

    expect(result).toEqual({ threadNodeId: "PRT_resolved", alreadyResolved: true });
  });

  it("picks the right thread when multiple threads exist on the PR", async () => {
    const { octokit } = buildOctokitStub([
      { id: "PRT_a", isResolved: false, comments: { nodes: [{ databaseId: 100 }] } },
      { id: "PRT_b", isResolved: false, comments: { nodes: [{ databaseId: 200 }] } },
      { id: "PRT_c", isResolved: true, comments: { nodes: [{ databaseId: 300 }] } },
    ]);

    const result = await findReviewThreadByCommentId(octokit, "owner", "repo", 113, 200);

    expect(result?.threadNodeId).toBe("PRT_b");
  });

  it("returns null when no thread's first comment matches", async () => {
    const { octokit } = buildOctokitStub([
      { id: "PRT_a", isResolved: false, comments: { nodes: [{ databaseId: 100 }] } },
    ]);

    const result = await findReviewThreadByCommentId(octokit, "owner", "repo", 113, 999);

    expect(result).toBeNull();
  });

  it("returns null when the PR has zero review threads", async () => {
    const { octokit } = buildOctokitStub([]);

    const result = await findReviewThreadByCommentId(octokit, "owner", "repo", 113, 100);

    expect(result).toBeNull();
  });

  it("does NOT match a non-first comment of a thread (only the parent comment id is the threadId)", async () => {
    // Reply comments in a thread share the thread's node-id but their
    // databaseIds are DIFFERENT from the thread's first-comment id. The
    // chat-thread executor only ever gets the parent comment's id as
    // `threadId`, so we deliberately do NOT search reply comments.
    const { octokit } = buildOctokitStub([
      {
        id: "PRT_root",
        isResolved: false,
        comments: { nodes: [{ databaseId: 1000 }] },
      },
    ]);

    // 1001 would be a reply on the thread, NOT the parent — should NOT match.
    const result = await findReviewThreadByCommentId(octokit, "owner", "repo", 113, 1001);

    expect(result).toBeNull();
  });
});
