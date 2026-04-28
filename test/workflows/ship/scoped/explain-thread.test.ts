/**
 * Tests for `bot:explain-thread` (T074 / FR-030). ≥90% coverage on
 * `src/workflows/ship/scoped/explain-thread.ts`.
 */

import { describe, expect, it, mock } from "bun:test";

import { runExplainThread } from "../../../../src/workflows/ship/scoped/explain-thread";

function buildOctokit() {
  const createReply = mock(() => Promise.resolve({ data: { id: 6001 } }));
  const issuesCreateComment = mock(() =>
    Promise.reject(new Error("explain-thread MUST NOT post a top-level comment")),
  );
  const issuesUpdateComment = mock(() =>
    Promise.reject(new Error("explain-thread MUST NOT update any comment")),
  );

  return {
    octokit: {
      rest: {
        pulls: { createReplyForReviewComment: createReply },
        issues: {
          createComment: issuesCreateComment,
          updateComment: issuesUpdateComment,
        },
      },
    } as never,
    createReply,
    issuesCreateComment,
    issuesUpdateComment,
  };
}

describe("runExplainThread", () => {
  it("posts a single review-comment reply and returns the reply id", async () => {
    const fake = buildOctokit();
    const callLlm = mock(() => Promise.resolve("This code does X by Y."));
    const result = await runExplainThread({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      pr_number: 7,
      comment_id: 12345,
      thread: {
        path: "src/foo.ts",
        line_range: "10-15",
        diff_hunk: "@@ -10,3 +10,4 @@\n+const x = 1;",
        code_snippet: "const x = 1;",
      },
      callLlm,
    });
    expect(result.reply_id).toBe(6001);
    expect(fake.createReply).toHaveBeenCalledTimes(1);
    expect(fake.issuesCreateComment).not.toHaveBeenCalled();
    expect(fake.issuesUpdateComment).not.toHaveBeenCalled();
  });

  it("forwards file path, line range, diff hunk, and code snippet to the LLM prompt", async () => {
    const fake = buildOctokit();
    const callLlm = mock(() => Promise.resolve("explanation"));
    await runExplainThread({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      pr_number: 7,
      comment_id: 12345,
      thread: {
        path: "lib/bar.ts",
        line_range: "42-50",
        diff_hunk: "@@ HUNK @@",
        code_snippet: "function bar() { return 42; }",
      },
      callLlm,
    });
    const userPrompt = (callLlm.mock.calls[0]?.[0] as { userPrompt: string }).userPrompt;
    expect(userPrompt).toContain("lib/bar.ts");
    expect(userPrompt).toContain("42-50");
    expect(userPrompt).toContain("@@ HUNK @@");
    expect(userPrompt).toContain("function bar() { return 42; }");
  });

  it("does NOT call any thread-resolve mutation", async () => {
    // The contract says explain-thread NEVER resolves a thread. The
    // octokit mock doesn't expose a resolveReviewThread method, so a
    // real attempt would TypeError. This test documents the intent.
    const fake = buildOctokit();
    const callLlm = mock(() => Promise.resolve("body"));
    await runExplainThread({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      pr_number: 7,
      comment_id: 12345,
      thread: { path: "f", line_range: "1", diff_hunk: "", code_snippet: "" },
      callLlm,
    });
    expect(fake.createReply).toHaveBeenCalledTimes(1);
  });
});
