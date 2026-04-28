/**
 * Tests for `bot:fix-thread` (T073 / FR-029). ≥90% coverage on
 * `src/workflows/ship/scoped/fix-thread.ts`.
 */

import { describe, expect, it, mock } from "bun:test";

import { isDesignDiscussion, runFixThread } from "../../../../src/workflows/ship/scoped/fix-thread";

function buildOctokit() {
  const createReply = mock(() =>
    Promise.resolve({ data: { id: Math.floor(Math.random() * 100_000) + 1 } }),
  );
  return {
    octokit: { rest: { pulls: { createReplyForReviewComment: createReply } } } as never,
    createReply,
  };
}

const baseThread = {
  path: "src/foo.ts",
  line_range: "10-12",
  diff_hunk: "@@ -10,3 +10,4 @@",
  thread_body: "Please rename `foo` to `fooBar` for consistency.",
};

describe("isDesignDiscussion", () => {
  it("returns true on canonical design-discussion phrases", () => {
    expect(isDesignDiscussion("let's discuss this approach")).toBe(true);
    expect(isDesignDiscussion("we should redesign this module")).toBe(true);
    expect(isDesignDiscussion("can we take a different approach?")).toBe(true);
    expect(isDesignDiscussion("This is out of scope for this PR")).toBe(true);
  });
  it("returns false on mechanical-fix language", () => {
    expect(isDesignDiscussion("rename foo to bar")).toBe(false);
    expect(isDesignDiscussion("nit: missing semicolon")).toBe(false);
  });
  it("is case-insensitive", () => {
    expect(isDesignDiscussion("REDESIGN THIS")).toBe(true);
  });
});

describe("runFixThread", () => {
  it("applies a mechanical fix, replies with SHA, and resolves the thread", async () => {
    const fake = buildOctokit();
    const applyMechanicalFix = mock(() =>
      Promise.resolve({ applied: true, commit_sha: "deadbeef" }),
    );
    const resolveThread = mock(() => Promise.resolve());
    const out = await runFixThread({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      pr_number: 1,
      comment_id: 11,
      thread_node_id: "PRRC_thread_xyz",
      thread: baseThread,
      applyMechanicalFix,
      resolveThread,
    });
    expect(out.kind).toBe("applied");
    if (out.kind === "applied") expect(out.commit_sha).toBe("deadbeef");
    expect(applyMechanicalFix).toHaveBeenCalledTimes(1);
    expect(resolveThread).toHaveBeenCalledTimes(1);
    expect(fake.createReply).toHaveBeenCalledTimes(1);
    const replyBody = (fake.createReply.mock.calls[0]?.[0] as { body: string }).body;
    expect(replyBody).toContain("deadbeef");
  });

  it("refuses on design-discussion threads (FR-004)", async () => {
    const fake = buildOctokit();
    const applyMechanicalFix = mock(() => Promise.resolve({ applied: false }));
    const resolveThread = mock(() => Promise.resolve());
    const out = await runFixThread({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      pr_number: 1,
      comment_id: 11,
      thread_node_id: "PRRC_x",
      thread: { ...baseThread, thread_body: "Let's discuss this design choice" },
      applyMechanicalFix,
      resolveThread,
    });
    expect(out.kind).toBe("design-discussion");
    expect(applyMechanicalFix).not.toHaveBeenCalled();
    expect(resolveThread).not.toHaveBeenCalled();
    const replyBody = (fake.createReply.mock.calls[0]?.[0] as { body: string }).body;
    expect(replyBody).toContain("FR-004");
  });

  it("skips with a clear reason when no mechanical fix is applicable", async () => {
    const fake = buildOctokit();
    const applyMechanicalFix = mock(() =>
      Promise.resolve({ applied: false, skip_reason: "request is ambiguous" }),
    );
    const resolveThread = mock(() => Promise.resolve());
    const out = await runFixThread({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      pr_number: 1,
      comment_id: 11,
      thread_node_id: "PRRC_x",
      thread: baseThread,
      applyMechanicalFix,
      resolveThread,
    });
    expect(out.kind).toBe("skipped");
    if (out.kind === "skipped") expect(out.reason).toBe("request is ambiguous");
    expect(resolveThread).not.toHaveBeenCalled();
    const replyBody = (fake.createReply.mock.calls[0]?.[0] as { body: string }).body;
    expect(replyBody).toContain("ambiguous");
  });

  it("skips with a default reason when applyMechanicalFix returns no skip_reason", async () => {
    const fake = buildOctokit();
    const applyMechanicalFix = mock(() => Promise.resolve({ applied: false }));
    const resolveThread = mock(() => Promise.resolve());
    const out = await runFixThread({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      pr_number: 1,
      comment_id: 11,
      thread_node_id: "PRRC_x",
      thread: baseThread,
      applyMechanicalFix,
      resolveThread,
    });
    if (out.kind !== "skipped") throw new Error("expected skipped outcome");
    expect(out.reason).toContain("no actionable mechanical change");
  });

  it("still reports applied when thread resolution fails (best-effort)", async () => {
    const fake = buildOctokit();
    const applyMechanicalFix = mock(() =>
      Promise.resolve({ applied: true, commit_sha: "abc1234" }),
    );
    const resolveThread = mock(() => Promise.reject(new Error("graphql 403")));
    const out = await runFixThread({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      pr_number: 1,
      comment_id: 11,
      thread_node_id: "PRRC_x",
      thread: baseThread,
      applyMechanicalFix,
      resolveThread,
    });
    expect(out.kind).toBe("applied");
  });

  it("treats applyMechanicalFix returning applied=true with no commit_sha as skipped", async () => {
    const fake = buildOctokit();
    const applyMechanicalFix = mock(() => Promise.resolve({ applied: true }));
    const resolveThread = mock(() => Promise.resolve());
    const out = await runFixThread({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      pr_number: 1,
      comment_id: 11,
      thread_node_id: "PRRC_x",
      thread: baseThread,
      applyMechanicalFix,
      resolveThread,
    });
    expect(out.kind).toBe("skipped");
  });
});
