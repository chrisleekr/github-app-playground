/**
 * Surface tests for the daemon-side `scoped-fix-thread` executor (T025).
 * The executor's body becomes a multi-turn Agent SDK invocation in a
 * follow-up; today it posts the maintainer-facing thread reply and
 * returns a structured halt so the orchestrator-side bridge has a
 * deterministic outcome to consume.
 */

import { describe, expect, it, mock } from "bun:test";

const mockCreateReply = mock(() => Promise.resolve({ data: { id: 9001 } }));
void mock.module("octokit", () => ({
  Octokit: class MockOctokit {
    rest = {
      pulls: {
        createReplyForReviewComment: mockCreateReply,
      },
    };
  },
}));

describe("executeScopedFixThread", () => {
  it("posts a thread reply and reports halted with the reply id", async () => {
    mockCreateReply.mockClear();
    mockCreateReply.mockImplementationOnce(() => Promise.resolve({ data: { id: 9001 } }));
    const { executeScopedFixThread } = await import("../../src/daemon/scoped-fix-thread-executor");

    const outcome = await executeScopedFixThread({
      installationToken: "tok",
      owner: "octo",
      repo: "repo",
      prNumber: 42,
      threadRef: {
        threadId: "thread-1",
        commentId: 7777,
        filePath: "src/foo.ts",
        startLine: 10,
        endLine: 15,
      },
      triggerCommentId: 7777,
    });

    expect(outcome.status).toBe("halted");
    expect(outcome.threadReplyId).toBe(9001);
    expect(mockCreateReply).toHaveBeenCalledTimes(1);
    const args = mockCreateReply.mock.calls[0]?.[0] as { body?: string } | undefined;
    expect(args?.body).toContain("src/foo.ts:10-15");
  });

  // H2: 4xx from `createReplyForReviewComment` must map to `halted` (with a
  // structured reason), NOT `failed` — operator dashboards must distinguish
  // "user deleted the comment" from "executor crashed."
  it("maps Octokit errors to halted with a structured reason (H2)", async () => {
    mockCreateReply.mockClear();
    mockCreateReply.mockImplementationOnce(() => {
      throw new Error("Not Found");
    });
    const { executeScopedFixThread } = await import("../../src/daemon/scoped-fix-thread-executor");

    const outcome = await executeScopedFixThread({
      installationToken: "tok",
      owner: "octo",
      repo: "repo",
      prNumber: 42,
      threadRef: {
        threadId: "thread-1",
        commentId: 7777,
        filePath: "src/foo.ts",
        startLine: 10,
        endLine: 15,
      },
      triggerCommentId: 7777,
    });

    expect(outcome.status).toBe("halted");
    expect(outcome.threadReplyId).toBeUndefined();
    expect(outcome.reason).toContain("thread reply failed");
    expect(outcome.reason).toContain("Not Found");
  });
});
