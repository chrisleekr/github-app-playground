/**
 * Surface tests for the daemon-side `scoped-explain-thread` executor
 * (T026). The full Agent SDK invocation lands as a follow-up; today's
 * test asserts the read-only thread reply path works without touching
 * write surfaces (no clone, no push).
 */

import { describe, expect, it, mock } from "bun:test";

const mockCreateReply = mock(() => Promise.resolve({ data: { id: 9002 } }));
void mock.module("octokit", () => ({
  Octokit: class MockOctokit {
    rest = {
      pulls: {
        createReplyForReviewComment: mockCreateReply,
      },
    };
  },
}));

describe("executeScopedExplainThread", () => {
  it("posts a read-only thread reply and reports halted with the reply id", async () => {
    mockCreateReply.mockClear();
    const { executeScopedExplainThread } =
      await import("../../src/daemon/scoped-explain-thread-executor");

    const outcome = await executeScopedExplainThread({
      installationToken: "tok",
      owner: "octo",
      repo: "repo",
      prNumber: 99,
      threadRef: {
        threadId: "thread-2",
        commentId: 8888,
        filePath: "lib/bar.rs",
        startLine: 1,
        endLine: 1,
      },
      triggerCommentId: 8888,
    });

    expect(outcome.status).toBe("halted");
    expect(outcome.threadReplyId).toBe(9002);
    expect(mockCreateReply).toHaveBeenCalledTimes(1);
    const args = mockCreateReply.mock.calls[0]?.[0] as { body?: string } | undefined;
    expect(args?.body).toContain("read-only");
    expect(args?.body).toContain("lib/bar.rs:1-1");
  });
});
